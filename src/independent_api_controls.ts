/**
 * Independent API Mode UI Controls
 *
 * Adds small per-message buttons to:
 * - Manually retry independent prompt generation
 * - Cancel pending auto-retries
 * - Retry failed image generations (bulk) when placeholders exist
 */

import {createLogger} from './logger';
import {isIndependentApiMode} from './mode_utils';
import {hasImagePrompts} from './image_extractor';
import {normalizeImageUrl} from './image_utils';
import {sessionManager} from './session_manager';
import {
  cancelIndependentPromptRetries,
  ensureIndependentApiPromptsAndGenerateImages,
  getIndependentPromptRetryState,
  onIndependentPromptRetryStateChange,
} from './independent_api_prompt_generation';
import {t} from './i18n';
import {getGenerationTimingInfo} from './image_generator';
import {
  estimateRemainingQueueMs,
  formatDurationClock,
} from './utils/time_utils';
import {htmlEncode} from './utils/dom_utils';

const logger = createLogger('IndependentApiControls');

const CONTROLS_CLASS = 'auto-illustrator-independent-controls';

let initialized = false;
let latestSettings: AutoIllustratorSettings | null = null;

function getMessageEl(messageId: number): HTMLElement | null {
  return document.querySelector(
    `.mes[mesid="${messageId}"]`
  ) as HTMLElement | null;
}

function ensureContainer(messageEl: HTMLElement): HTMLDivElement {
  const existing = messageEl.querySelector(
    `.${CONTROLS_CLASS}`
  ) as HTMLDivElement | null;
  if (existing) return existing;

  const container = document.createElement('div');
  container.className = CONTROLS_CLASS;
  messageEl.appendChild(container);
  return container;
}

function removeContainer(messageEl: HTMLElement): void {
  const existing = messageEl.querySelector(`.${CONTROLS_CLASS}`);
  if (existing) {
    existing.remove();
  }
}

function getFailedPlaceholderImages(
  messageEl: HTMLElement
): HTMLImageElement[] {
  return Array.from(
    messageEl.querySelectorAll(
      'img.auto-illustrator-img[data-failed-placeholder="true"][data-prompt-id]'
    )
  ) as HTMLImageElement[];
}

async function handleRetryPrompts(messageId: number): Promise<void> {
  const context = SillyTavern.getContext();
  if (!context) return;
  const settings = latestSettings;
  if (!settings) return;

  await ensureIndependentApiPromptsAndGenerateImages(
    messageId,
    context,
    settings,
    {
      manual: true,
    }
  );
}

function handleCancelPromptRetry(messageId: number): void {
  cancelIndependentPromptRetries(messageId);
}

async function handleRetryFailedImages(messageId: number): Promise<void> {
  const context = SillyTavern.getContext();
  if (!context) {
    return;
  }

  const settings = latestSettings;
  if (!settings) {
    return;
  }

  // Don't allow manual operations while a streaming session is active for this message
  const session = sessionManager.getSession(messageId);
  if (session && session.type === 'streaming') {
    toastr.warning(t('toast.cannotManualWhileStreaming'), t('extensionName'));
    return;
  }

  const messageEl = getMessageEl(messageId);
  if (!messageEl) return;

  const failedImages = getFailedPlaceholderImages(messageEl);
  if (failedImages.length === 0) {
    // If there are prompts but no images at all, allow starting generation session manually.
    await ensureIndependentApiPromptsAndGenerateImages(
      messageId,
      context,
      settings,
      {
        manual: true,
      }
    );
    return;
  }

  // Queue regenerations for all failed placeholders (dedupe by promptId)
  const uniqueByPromptId = new Map<string, string>();
  for (const img of failedImages) {
    const promptId = img.getAttribute('data-prompt-id') || '';
    if (!promptId) continue;
    uniqueByPromptId.set(promptId, normalizeImageUrl(img.src));
  }

  let queued = 0;
  for (const [promptId, imageUrl] of uniqueByPromptId.entries()) {
    try {
      await sessionManager.queueRegeneration(
        messageId,
        promptId,
        imageUrl,
        context,
        settings,
        'replace-image'
      );
      queued++;
    } catch (error) {
      logger.error(
        `Failed to queue regeneration for prompt ${promptId} in message ${messageId}:`,
        error
      );
    }
  }

  if (queued > 0) {
    toastr.info(t('toast.retryQueued', {count: queued}), t('extensionName'));
  } else {
    toastr.warning(t('toast.failedToGenerate'), t('extensionName'));
  }
}

function renderControlsForMessage(
  messageId: number,
  context: SillyTavernContext,
  settings: AutoIllustratorSettings
): void {
  const message = context.chat?.[messageId];
  if (!message || message.is_user) {
    return;
  }

  const messageEl = getMessageEl(messageId);
  if (!messageEl) {
    return;
  }

  // Only show in independent API mode
  if (!isIndependentApiMode(settings.promptGenerationMode)) {
    removeContainer(messageEl);
    return;
  }

  const retryState = getIndependentPromptRetryState(messageId);
  const messageText = message.mes || '';
  const promptTagsPresent = hasImagePrompts(
    messageText,
    settings.promptDetectionPatterns
  );

  const session = sessionManager.getSession(messageId);
  const sessionActive = !!session;

  const failedImages = getFailedPlaceholderImages(messageEl);
  const hasFailedImages = failedImages.length > 0;

  // Show "retry images" when we have prompts and either failed placeholders exist,
  // or there are no auto-illustrator images yet (prompts but never generated/inserted).
  const hasAnyIllustratorImages = messageText.includes('auto-illustrator-img');
  const shouldShowRetryImages =
    promptTagsPresent &&
    !sessionActive &&
    (hasFailedImages || !hasAnyIllustratorImages);

  const shouldShowPromptControls = !!retryState && !promptTagsPresent;
  const shouldShowSessionStatus = sessionActive;

  if (
    !shouldShowPromptControls &&
    !shouldShowRetryImages &&
    !shouldShowSessionStatus
  ) {
    removeContainer(messageEl);
    return;
  }

  const container = ensureContainer(messageEl);

  const parts: string[] = [];

  if (shouldShowSessionStatus && session) {
    const status = session.processor.getStatus();
    const stats = status.queueStats;
    const queued = stats.QUEUED ?? 0;
    const generating = stats.GENERATING ?? 0;
    const completed = stats.COMPLETED ?? 0;
    const failed = stats.FAILED ?? 0;

    parts.push(
      `<span class="auto-illustrator-independent-status">${htmlEncode(
        t('controls.imageQueueStatus', {
          queued,
          generating,
          active: status.activeGenerations,
          max: status.maxConcurrent,
          completed,
          failed,
        })
      )}</span>`
    );

    const pendingCount = queued + generating;
    const timing = getGenerationTimingInfo();
    if (pendingCount > 0 && timing.cooldownRemainingMs > 0) {
      const etaMs = estimateRemainingQueueMs({
        pendingCount,
        cooldownRemainingMs: timing.cooldownRemainingMs,
        averageGenerationDurationMs: timing.averageGenerationDurationMs,
        minGenerationIntervalMs: timing.minGenerationIntervalMs,
        maxConcurrent: timing.maxConcurrent,
      });

      const cooldownText = t('progress.cooldownRemaining', {
        time: formatDurationClock(timing.cooldownRemainingMs),
      });
      const etaText =
        etaMs !== null
          ? t('progress.queueEta', {time: formatDurationClock(etaMs)})
          : '';

      const detailText = etaText
        ? `${cooldownText} • ${etaText}`
        : cooldownText;
      parts.push(
        `<span class="auto-illustrator-independent-status auto-illustrator-independent-status-details">${htmlEncode(
          detailText
        )}</span>`
      );
    }
  }

  if (shouldShowPromptControls && retryState) {
    if (retryState.status === 'scheduled' && retryState.nextRetryAt) {
      const seconds = Math.max(
        0,
        Math.round((retryState.nextRetryAt - Date.now()) / 1000)
      );
      parts.push(
        `<span class="auto-illustrator-independent-status">${t(
          'controls.promptRetryScheduled',
          {
            seconds,
            attempt: retryState.retryCount + 1,
            total: retryState.maxRetries,
          }
        )}</span>`
      );
    } else if (retryState.status === 'running') {
      parts.push(
        `<span class="auto-illustrator-independent-status">${t('controls.promptRetryRunning')}</span>`
      );
    } else if (retryState.status === 'failed') {
      parts.push(
        `<span class="auto-illustrator-independent-status">${t('controls.promptRetryFailed')}</span>`
      );
    } else if (retryState.status === 'cancelled') {
      parts.push(
        `<span class="auto-illustrator-independent-status">${t('controls.promptRetryCancelled')}</span>`
      );
    }

    if (
      (retryState.status === 'scheduled' || retryState.status === 'failed') &&
      (retryState.lastErrorType || retryState.lastErrorMessage)
    ) {
      const type = retryState.lastErrorType || 'unknown';
      const message = retryState.lastErrorMessage || '';
      const full = `${type}: ${message}`.trim();
      const maxLen = 160;
      const truncated =
        full.length > maxLen ? full.substring(0, maxLen - 3) + '...' : full;

      parts.push(
        `<span class="auto-illustrator-independent-status auto-illustrator-independent-status-details" title="${htmlEncode(
          full
        )}">${htmlEncode(
          t('controls.lastError', {type, message: truncated})
        )}</span>`
      );
    }

    parts.push(
      `<button class="menu_button auto-illustrator-independent-btn" data-action="retry-prompts">${t('controls.retryPrompts')}</button>`
    );

    if (retryState.status === 'scheduled' || retryState.status === 'running') {
      parts.push(
        `<button class="menu_button auto-illustrator-independent-btn caution" data-action="cancel-retry">${t('controls.cancelRetry')}</button>`
      );
    }
  }

  if (shouldShowRetryImages) {
    parts.push(
      `<button class="menu_button auto-illustrator-independent-btn" data-action="retry-images">${t('controls.retryImages')}</button>`
    );
  }

  container.innerHTML = parts.join(' ');

  // Attach handlers
  const retryPromptsBtn = container.querySelector(
    'button[data-action="retry-prompts"]'
  ) as HTMLButtonElement | null;
  if (retryPromptsBtn) {
    retryPromptsBtn.onclick = async e => {
      e.preventDefault();
      e.stopPropagation();
      await handleRetryPrompts(messageId);
    };
  }

  const cancelBtn = container.querySelector(
    'button[data-action="cancel-retry"]'
  ) as HTMLButtonElement | null;
  if (cancelBtn) {
    cancelBtn.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      handleCancelPromptRetry(messageId);
    };
  }

  const retryImagesBtn = container.querySelector(
    'button[data-action="retry-images"]'
  ) as HTMLButtonElement | null;
  if (retryImagesBtn) {
    retryImagesBtn.onclick = async e => {
      e.preventDefault();
      e.stopPropagation();
      await handleRetryFailedImages(messageId);
    };
  }
}

export function renderIndependentApiControls(
  settings: AutoIllustratorSettings
): void {
  latestSettings = settings;

  const context = SillyTavern.getContext();
  if (!context?.chat) {
    return;
  }

  // Initialize state change listener once
  if (!initialized) {
    initialized = true;

    onIndependentPromptRetryStateChange(messageId => {
      const freshContext = SillyTavern.getContext();
      const currentSettings = latestSettings;
      if (!freshContext || !currentSettings) return;
      renderControlsForMessage(messageId, freshContext, currentSettings);
    });
  }

  for (let messageId = 0; messageId < context.chat.length; messageId++) {
    renderControlsForMessage(messageId, context, settings);
  }
}
