/**
 * Prompt Generation Service
 * Generates image prompts using a separate LLM call
 */

import {createLogger} from '../logger';
import promptGenerationTemplate from '../presets/prompt_generation.md';
import type {PromptSuggestion} from '../prompt_insertion';

const logger = createLogger('PromptGenService');

export type PromptGenerationStatus = 'success' | 'no-prompts' | 'error';

export type PromptGenerationErrorType =
  | 'generateRaw-unavailable'
  | 'llm-call-failed'
  | 'invalid-format';

export interface PromptGenerationResult {
  status: PromptGenerationStatus;
  suggestions: PromptSuggestion[];
  errorType?: PromptGenerationErrorType;
  errorMessage?: string;
  rawResponse?: string;
}

type LlmCallMethod =
  | 'generateRaw(string)'
  | 'generateRaw(messages)'
  | 'generateQuietPrompt';

function formatLlmCallError(method: LlmCallMethod, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${method}: ${message}`;
}

function shouldRetryWithReducedContext(errorMessage: string): boolean {
  const lower = (errorMessage || '').toLowerCase();
  return (
    lower.includes('502') ||
    lower.includes('bad gateway') ||
    lower.includes('504') ||
    lower.includes('gateway timeout') ||
    lower.includes('413') ||
    lower.includes('payload too large') ||
    lower.includes('request entity too large') ||
    lower.includes('context length') ||
    lower.includes('too many tokens') ||
    lower.includes('max_tokens') ||
    lower.includes('timeout')
  );
}

/**
 * Builds user prompt with context from previous messages
 * Format: === CONTEXT === ... === CURRENT MESSAGE === ...
 *
 * @param context - SillyTavern context
 * @param currentMessageText - The message to generate prompts for
 * @param contextMessageCount - Number of previous messages to include as context
 * @returns Formatted user prompt with context
 */
function buildUserPromptWithContext(
  context: SillyTavernContext,
  currentMessageText: string,
  contextMessageCount: number,
  currentMessageIndex?: number
): string {
  // Get recent chat history (last N messages, excluding current)
  const chat = context.chat || [];
  const safeCurrentIndex =
    typeof currentMessageIndex === 'number' &&
    Number.isFinite(currentMessageIndex) &&
    currentMessageIndex >= 0 &&
    currentMessageIndex < chat.length
      ? currentMessageIndex
      : chat.length - 1;

  const startIndex = Math.max(0, safeCurrentIndex - contextMessageCount);
  const recentMessages = chat.slice(startIndex, safeCurrentIndex); // Last N messages before current

  let contextText = '';
  if (recentMessages.length > 0 && contextMessageCount > 0) {
    contextText = recentMessages
      .map(msg => {
        const name = msg.name || (msg.is_user ? 'User' : 'Assistant');
        const text = msg.mes || '';
        return `${name}: ${text}`;
      })
      .join('\n\n');
  } else {
    contextText = '(No previous messages)';
  }

  return `=== CONTEXT ===
${contextText}

=== CURRENT MESSAGE ===
${currentMessageText}`;
}

/**
 * Parses LLM response and extracts prompt suggestions
 * Expects plain text delimiter format:
 * ---PROMPT---
 * TEXT: ...
 * INSERT_AFTER: ...
 * INSERT_BEFORE: ...
 * REASONING: ...
 * ---END---
 *
 * @param llmResponse - Raw LLM response text
 * @returns Array of parsed prompt suggestions, or empty array if parsing fails
 */
function parsePromptSuggestions(llmResponse: string): PromptSuggestion[] {
  try {
    // Strip markdown code blocks if present
    let cleanedResponse = llmResponse.trim();
    if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/^```[a-z]*\s*\n?/, '');
      cleanedResponse = cleanedResponse.replace(/\n?```\s*$/, '');
      cleanedResponse = cleanedResponse.trim();
    }

    // Split by ---PROMPT--- delimiter
    const promptBlocks = cleanedResponse.split('---PROMPT---');
    const validSuggestions: PromptSuggestion[] = [];

    for (const block of promptBlocks) {
      // Skip empty blocks or the part before first ---PROMPT---
      if (!block.trim() || !block.includes('TEXT:')) {
        continue;
      }

      // Stop at ---END--- marker if present
      const blockContent = block.split('---END---')[0];

      // Extract fields using regex - more robust than split
      const textMatch = blockContent.match(/^TEXT:\s*(.+?)$/m);
      const insertAfterMatch = blockContent.match(/^INSERT_AFTER:\s*(.+?)$/m);
      const insertBeforeMatch = blockContent.match(/^INSERT_BEFORE:\s*(.+?)$/m);
      const reasoningMatch = blockContent.match(/^REASONING:\s*(.+?)$/m);

      // Check required fields
      if (!textMatch || !insertAfterMatch || !insertBeforeMatch) {
        const missingFields = [];
        if (!textMatch) missingFields.push('TEXT');
        if (!insertAfterMatch) missingFields.push('INSERT_AFTER');
        if (!insertBeforeMatch) missingFields.push('INSERT_BEFORE');
        logger.warn(
          `Skipping prompt block with missing required fields: ${missingFields.join(', ')}`
        );
        logger.debug('Block content preview:', blockContent.substring(0, 200));
        continue;
      }

      const text = textMatch[1].trim();
      const insertAfter = insertAfterMatch[1].trim();
      const insertBefore = insertBeforeMatch[1].trim();
      const reasoning = reasoningMatch ? reasoningMatch[1].trim() : undefined;

      // Check non-empty
      if (!text || !insertAfter || !insertBefore) {
        const emptyFields = [];
        if (!text) emptyFields.push('TEXT');
        if (!insertAfter) emptyFields.push('INSERT_AFTER');
        if (!insertBefore) emptyFields.push('INSERT_BEFORE');
        logger.warn(
          `Skipping prompt block with empty fields: ${emptyFields.join(', ')}`
        );
        logger.debug('Block content preview:', blockContent.substring(0, 200));
        continue;
      }

      validSuggestions.push({
        text,
        insertAfter,
        insertBefore,
        reasoning,
      });
    }

    logger.info(
      `Parsed ${validSuggestions.length} valid suggestions from LLM response`
    );
    return validSuggestions;
  } catch (error) {
    logger.error('Failed to parse LLM response:', error);
    logger.debug('Raw response:', llmResponse);
    return [];
  }
}

/**
 * Generates image prompts for a message using separate LLM call
 *
 * Uses context.generateRaw() to analyze the message text and suggest
 * image prompts with context-based insertion points.
 *
 * @param messageText - The complete message text to analyze
 * @param context - SillyTavern context
 * @param settings - Extension settings
 * @returns Array of prompt suggestions, or empty array on failure
 *
 * @example
 * const suggestions = await generatePromptsForMessage(
 *   "She walked through the forest under the pale moonlight.",
 *   context,
 *   settings
 * );
 * // Returns: [{
 * //   text: "1girl, forest, moonlight, highly detailed",
 * //   insertAfter: "through the forest",
 * //   insertBefore: "under the pale"
 * // }]
 */
export async function generatePromptsForMessage(
  messageText: string,
  context: SillyTavernContext,
  settings: AutoIllustratorSettings,
  options?: {messageId?: number}
): Promise<PromptGenerationResult> {
  logger.info('Generating image prompts using separate LLM call');
  logger.debug(`Message length: ${messageText.length} characters`);

  // Check for LLM availability
  if (!context.generateRaw) {
    logger.error('generateRaw not available in context');
    return {
      status: 'error',
      suggestions: [],
      errorType: 'generateRaw-unavailable',
      errorMessage: 'LLM generation not available (generateRaw missing)',
    };
  }

  // Build system prompt with all instructions from template
  let systemPrompt = promptGenerationTemplate;

  // Replace FREQUENCY_GUIDELINES with user's custom or default
  const frequencyGuidelines = settings.llmFrequencyGuidelines || '';
  systemPrompt = systemPrompt.replace(
    '{{FREQUENCY_GUIDELINES}}',
    frequencyGuidelines
  );

  // Replace PROMPT_WRITING_GUIDELINES with user's custom or default
  const promptWritingGuidelines = settings.llmPromptWritingGuidelines || '';
  systemPrompt = systemPrompt.replace(
    '{{PROMPT_WRITING_GUIDELINES}}',
    promptWritingGuidelines
  );

  // Build user prompt with context and current message
  const contextMessageCount = settings.contextMessageCount || 10;
  const userPrompt = buildUserPromptWithContext(
    context,
    messageText,
    contextMessageCount,
    options?.messageId
  );

  logger.debug('Calling LLM for prompt generation (using generateRaw)');
  logger.debug('Context message count:', contextMessageCount);
  logger.debug('User prompt length:', userPrompt.length);
  logger.trace('User prompt:', userPrompt);

  // Call LLM with generateRaw (no chat context)
  const callPromptLlm = async (promptText: string): Promise<string> => {
    const errors: string[] = [];
    let llmResponse: string;

    // Primary: generateRaw with string prompt
    try {
      llmResponse = await context.generateRaw({
        systemPrompt,
        prompt: promptText,
      });
      logger.info('Prompt generation LLM call succeeded', {
        method: 'generateRaw(string)',
      });
    } catch (error) {
      errors.push(formatLlmCallError('generateRaw(string)', error));

      // Fallback: generateRaw with chat-style message array
      // Some providers only support chat completions and may fail on raw string prompts.
      const messages: Array<{role: string; content: string}> = [];
      if (systemPrompt && systemPrompt.trim().length > 0) {
        messages.push({role: 'system', content: systemPrompt});
      }
      messages.push({role: 'user', content: promptText});

      try {
        llmResponse = await context.generateRaw({
          prompt: messages as unknown[],
        });
        logger.info('Prompt generation LLM call succeeded', {
          method: 'generateRaw(messages)',
        });
      } catch (secondError) {
        errors.push(formatLlmCallError('generateRaw(messages)', secondError));

        // Last resort: generateQuietPrompt (chat pipeline, no message insertion)
        if (typeof context.generateQuietPrompt === 'function') {
          try {
            const combined = `SYSTEM:\n${systemPrompt}\n\nUSER:\n${promptText}`;
            llmResponse = await context.generateQuietPrompt({
              quietPrompt: combined,
            });
            logger.info('Prompt generation LLM call succeeded', {
              method: 'generateQuietPrompt',
            });
          } catch (thirdError) {
            errors.push(formatLlmCallError('generateQuietPrompt', thirdError));
            throw new Error(errors.join(' | '));
          }
        } else {
          throw new Error(errors.join(' | '));
        }
      }
    }

    logger.debug('LLM response received');
    logger.trace('Raw LLM response:', llmResponse);
    return llmResponse;
  };

  let llmResponse: string;
  try {
    llmResponse = await callPromptLlm(userPrompt);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('LLM generation failed:', error);

    // If the raw call fails due to gateway/timeouts/payload issues, retry once with
    // reduced context to shrink the request and improve compatibility with proxies.
    if (
      contextMessageCount > 0 &&
      shouldRetryWithReducedContext(errorMessage)
    ) {
      logger.warn(
        'Retrying prompt generation with reduced context (contextMessageCount=0) due to upstream error',
        {error: errorMessage}
      );

      const reducedUserPrompt = buildUserPromptWithContext(
        context,
        messageText,
        0,
        options?.messageId
      );

      try {
        llmResponse = await callPromptLlm(reducedUserPrompt);
      } catch (secondError) {
        const secondMessage =
          secondError instanceof Error
            ? secondError.message
            : String(secondError);
        logger.error('LLM generation failed (reduced context):', secondError);
        return {
          status: 'error',
          suggestions: [],
          errorType: 'llm-call-failed',
          errorMessage: `${errorMessage} | reduced-context: ${secondMessage}`,
        };
      }
    } else {
      return {
        status: 'error',
        suggestions: [],
        errorType: 'llm-call-failed',
        errorMessage,
      };
    }
  }

  // Parse response
  const suggestions = parsePromptSuggestions(llmResponse);

  if (suggestions.length === 0) {
    const cleaned = llmResponse.trim();
    const includesPromptDelimiter = cleaned.includes('---PROMPT---');
    const includesEndDelimiter = cleaned.includes('---END---');

    // If the LLM returned a well-formed "no prompts" response (just ---END---),
    // treat it as a valid "no-prompts" outcome (no retries needed).
    if (includesEndDelimiter && !includesPromptDelimiter) {
      logger.info('LLM returned no prompts (---END--- without prompt blocks)');
      return {status: 'no-prompts', suggestions: [], rawResponse: llmResponse};
    }

    logger.warn('LLM returned no valid suggestions (invalid format)');
    return {
      status: 'error',
      suggestions: [],
      errorType: 'invalid-format',
      errorMessage: 'LLM response did not contain any valid prompt blocks',
      rawResponse: llmResponse,
    };
  }

  // Apply maxPromptsPerMessage limit
  const maxPrompts = settings.maxPromptsPerMessage || 5;
  if (suggestions.length > maxPrompts) {
    logger.info(
      `Limiting prompts from ${suggestions.length} to ${maxPrompts} (maxPromptsPerMessage)`
    );
    return {
      status: 'success',
      suggestions: suggestions.slice(0, maxPrompts),
      rawResponse: llmResponse,
    };
  }

  logger.info(
    `Successfully generated ${suggestions.length} prompt suggestions`
  );

  // Log suggestions for debugging
  suggestions.forEach((s, i) => {
    logger.debug(`Suggestion ${i + 1}:`, {
      text: s.text.substring(0, 60) + (s.text.length > 60 ? '...' : ''),
      after: s.insertAfter.substring(0, 30),
      before: s.insertBefore.substring(0, 30),
      reasoning: s.reasoning,
    });
  });

  return {status: 'success', suggestions, rawResponse: llmResponse};
}
