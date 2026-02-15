/**
 * Independent API Prompt Generation (with retries)
 *
 * In independent-api mode, prompts are generated via a separate LLM call after
 * the assistant message is received. This module adds:
 * - Automatic retries with backoff (5s, 10s, 20s; 3 retries by default)
 * - Cancellable retry schedule
 * - Manual retry entry points (used by UI controls)
 */

import {createLogger} from './logger';
import {generatePromptsForMessage} from './services/prompt_generation_service';
import {
  escapePromptForPromptTag,
  insertPromptTagsWithContext,
} from './prompt_insertion';
import {saveMetadata} from './metadata';
import {sessionManager} from './session_manager';
import {hasImagePrompts} from './image_extractor';
import {t} from './i18n';

const logger = createLogger('IndependentApiPromptGen');

const RETRY_DELAYS_MS = [5000, 10000, 20000] as const;

export type IndependentPromptRetryStatus =
  | 'running'
  | 'scheduled'
  | 'failed'
  | 'cancelled';

export interface IndependentPromptRetryState {
  messageId: number;
  status: IndependentPromptRetryStatus;
  /** How many retries have already been scheduled/used (0-3). */
  retryCount: number;
  /** Total retries available (default: 3). */
  maxRetries: number;
  /** Next retry timestamp (ms since epoch) if scheduled. */
  nextRetryAt?: number;
  lastErrorType?: string;
  lastErrorMessage?: string;
}

interface InternalState extends IndependentPromptRetryState {
  abortController: AbortController;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

const states = new Map<number, InternalState>();

const STATE_EVENT = 'auto-illustrator:independent-api-prompt-retry-state';

function emitState(messageId: number): void {
  document.dispatchEvent(new CustomEvent(STATE_EVENT, {detail: {messageId}}));
}

export function getIndependentPromptRetryState(
  messageId: number
): IndependentPromptRetryState | null {
  const state = states.get(messageId);
  if (!state) return null;

  const {
    abortController: _abortController,
    timeoutId: _timeoutId,
    ...publicState
  } = state;
  return publicState;
}

export function onIndependentPromptRetryStateChange(
  callback: (messageId: number) => void
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const messageId = detail?.messageId;
    if (typeof messageId === 'number') {
      callback(messageId);
    }
  };

  document.addEventListener(STATE_EVENT, handler as EventListener);
  return () => {
    document.removeEventListener(STATE_EVENT, handler as EventListener);
  };
}

function clearTimer(state: InternalState): void {
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }
}

export function cancelIndependentPromptRetries(
  messageId: number,
  options?: {silent?: boolean}
): void {
  const state = states.get(messageId);
  if (!state) {
    return;
  }

  clearTimer(state);
  state.abortController.abort();
  state.status = 'cancelled';
  state.nextRetryAt = undefined;

  logger.info(
    `Cancelled independent API prompt retries for message ${messageId}`
  );
  if (!options?.silent) {
    toastr.info(t('toast.promptRetryCancelled'), t('extensionName'));
  }

  emitState(messageId);
}

export function cancelAllIndependentPromptRetries(): void {
  // messageId indices are chat-local; clear state entirely to avoid collisions
  // when switching chats (new chats re-use messageId 0..N).
  const messageIds = Array.from(states.keys());
  for (const messageId of messageIds) {
    cancelIndependentPromptRetries(messageId, {silent: true});
  }
  states.clear();
}

async function startNonStreamingGenerationSession(
  messageId: number,
  context: SillyTavernContext,
  settings: AutoIllustratorSettings
): Promise<void> {
  // Start a session to detect prompts and generate images
  await sessionManager.startStreamingSession(messageId, context, settings);
  // Auto-finalize when all generations complete (non-streaming messages)
  sessionManager.setupStreamingCompletion(messageId, context, settings);
}

async function tryGenerateAndInsertPromptsOnce(
  messageId: number,
  context: SillyTavernContext,
  settings: AutoIllustratorSettings,
  state: InternalState
): Promise<'success' | 'no-prompts' | 'error' | 'cancelled'> {
  if (state.abortController.signal.aborted) {
    return 'cancelled';
  }

  const message = context.chat?.[messageId];
  if (!message || message.is_user) {
    return 'cancelled';
  }

  // If prompt tags already exist, don't generate again
  const currentText = message.mes || '';
  if (hasImagePrompts(currentText, settings.promptDetectionPatterns)) {
    logger.debug(
      `Message ${messageId} already contains prompt tags; skipping prompt generation`
    );
    return 'success';
  }

  const generation = await generatePromptsForMessage(
    currentText,
    context,
    settings,
    {messageId}
  );

  if (state.abortController.signal.aborted) {
    return 'cancelled';
  }

  if (generation.status === 'no-prompts') {
    return 'no-prompts';
  }

  if (generation.status !== 'success') {
    state.lastErrorType = generation.errorType;
    state.lastErrorMessage = generation.errorMessage;
    return 'error';
  }

  const prompts = generation.suggestions;
  if (prompts.length === 0) {
    // Defensive; should not happen with status=success.
    return 'no-prompts';
  }

  logger.info(
    `LLM generated ${prompts.length} prompt(s) for message ${messageId}`
  );

  // Insert prompt tags into message using context matching
  const tagTemplate = settings.promptDetectionPatterns?.[0] || '';
  const insertionResult = insertPromptTagsWithContext(
    currentText,
    prompts,
    tagTemplate
  );

  // Fallback for failed suggestions - append at end
  let finalText = insertionResult.updatedText;
  let totalInserted = insertionResult.insertedCount;

  if (insertionResult.failedSuggestions.length > 0) {
    logger.warn(
      `Failed to insert ${insertionResult.failedSuggestions.length} prompt(s) via context matching; appending at end`
    );

    const promptTagTemplate = tagTemplate.includes('{PROMPT}')
      ? tagTemplate
      : '<!--img-prompt="{PROMPT}"-->';

    for (const failed of insertionResult.failedSuggestions) {
      const escaped = escapePromptForPromptTag(failed.text);
      const promptTag = promptTagTemplate.replace('{PROMPT}', escaped);
      finalText += ` ${promptTag}`;
      totalInserted++;
    }
  }

  if (totalInserted === 0) {
    state.lastErrorType = 'insertion-failed';
    state.lastErrorMessage = 'No prompts could be inserted into message text';
    return 'error';
  }

  // Save updated message with prompt tags (invisible in UI)
  message.mes = finalText;
  await saveMetadata();

  logger.info(
    `Inserted ${totalInserted} prompt tag(s) into message ${messageId}`
  );
  return 'success';
}

async function runAttempt(
  messageId: number,
  settings: AutoIllustratorSettings,
  state: InternalState
): Promise<void> {
  if (state.abortController.signal.aborted) {
    return;
  }

  // Always use fresh context for retries
  const context = SillyTavern.getContext();
  if (!context) {
    state.lastErrorType = 'context-unavailable';
    state.lastErrorMessage = 'SillyTavern context not available';
  } else {
    const result = await tryGenerateAndInsertPromptsOnce(
      messageId,
      context,
      settings,
      state
    );

    if (result === 'cancelled') {
      state.status = 'cancelled';
      emitState(messageId);
      return;
    }

    if (result === 'no-prompts') {
      // No prompts needed; stop retrying and don't start image generation.
      states.delete(messageId);
      emitState(messageId);
      return;
    }

    if (result === 'success') {
      // Prompts are now in the message; start image generation session.
      try {
        if (sessionManager.getSession(messageId)) {
          logger.debug(
            `Image generation session already active for message ${messageId}; skipping duplicate start`
          );
        } else {
          await startNonStreamingGenerationSession(messageId, context, settings);
        }
      } catch (error) {
        logger.error(
          `Failed to start image generation session for message ${messageId}:`,
          error
        );
      }

      states.delete(messageId);
      emitState(messageId);
      return;
    }

    // result === 'error' falls through to retry scheduling below
  }

  if (state.abortController.signal.aborted) {
    state.status = 'cancelled';
    emitState(messageId);
    return;
  }

  if (state.retryCount >= state.maxRetries) {
    state.status = 'failed';
    state.nextRetryAt = undefined;
    clearTimer(state);

    logger.warn(
      `Independent API prompt generation failed after ${state.maxRetries} retries for message ${messageId}`
    );
    toastr.warning(t('toast.promptRetryFailed'), t('extensionName'));

    emitState(messageId);
    return;
  }

  const delayMs = RETRY_DELAYS_MS[state.retryCount] ?? RETRY_DELAYS_MS.at(-1)!;
  const attempt = state.retryCount + 1;
  const total = state.maxRetries;

  state.status = 'scheduled';
  state.nextRetryAt = Date.now() + delayMs;
  clearTimer(state);

  toastr.warning(
    t('toast.promptRetrying', {
      seconds: Math.round(delayMs / 1000),
      attempt,
      total,
    }),
    t('extensionName')
  );

  state.timeoutId = setTimeout(async () => {
    // Move to next retry
    state.retryCount++;
    state.status = 'running';
    state.nextRetryAt = undefined;
    emitState(messageId);

    await runAttempt(messageId, settings, state);
  }, delayMs);

  emitState(messageId);
}

export async function ensureIndependentApiPromptsAndGenerateImages(
  messageId: number,
  context: SillyTavernContext,
  settings: AutoIllustratorSettings,
  options?: {manual?: boolean}
): Promise<void> {
  const manual = options?.manual ?? false;

  // If message already has prompts, just start image generation (no retries needed)
  const message = context.chat?.[messageId];
  if (!message || message.is_user) {
    return;
  }

  const currentText = message.mes || '';
  if (hasImagePrompts(currentText, settings.promptDetectionPatterns)) {
    // If prompt retries are scheduled for this message, cancel them now to avoid duplicate sessions.
    const existingState = states.get(messageId);
    if (existingState) {
      clearTimer(existingState);
      existingState.abortController.abort();
      states.delete(messageId);
      emitState(messageId);
    }

    try {
      await startNonStreamingGenerationSession(messageId, context, settings);
    } catch (error) {
      logger.error(
        `Failed to start image generation session for message ${messageId}:`,
        error
      );
    }
    return;
  }

  const existing = states.get(messageId);
  if (existing) {
    if (manual) {
      // Cancel any existing schedule and restart fresh
      cancelIndependentPromptRetries(messageId, {silent: true});
      states.delete(messageId);
    } else if (
      existing.status === 'running' ||
      existing.status === 'scheduled'
    ) {
      logger.debug(
        `Prompt generation already in progress for message ${messageId}, skipping duplicate`
      );
      return;
    }
  }

  const state: InternalState = {
    messageId,
    status: 'running',
    retryCount: 0,
    maxRetries: RETRY_DELAYS_MS.length,
    abortController: new AbortController(),
    timeoutId: null,
  };
  states.set(messageId, state);
  emitState(messageId);

  await runAttempt(messageId, settings, state);
}
