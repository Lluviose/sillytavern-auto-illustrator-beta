/**
 * Tests for Prompt Generation Service
 */

import {describe, it, expect, vi, beforeEach} from 'vitest';
import {generatePromptsForMessage} from './prompt_generation_service';

describe('prompt_generation_service', () => {
  let mockContext: SillyTavernContext;
  let mockSettings: AutoIllustratorSettings;

  beforeEach(() => {
    // Create mock context with generateRaw
    mockContext = {
      generateRaw: vi.fn(),
      generateQuietPrompt: vi
        .fn()
        .mockRejectedValue(new Error('quiet disabled')),
      chat: [],
    } as unknown as SillyTavernContext;

    // Create mock settings
    mockSettings = {
      maxPromptsPerMessage: 5,
      contextMessageCount: 5,
      llmFrequencyGuidelines: 'test frequency',
      llmPromptWritingGuidelines: 'test writing',
      promptGenerationMode: 'llm-post',
    } as AutoIllustratorSettings;
  });

  describe('generatePromptsForMessage', () => {
    it('should parse valid plain text response with single prompt', async () => {
      const messageText = 'She walked through the forest under the moonlight.';
      const llmResponse = `---PROMPT---
TEXT: 1girl, forest, moonlight, highly detailed
INSERT_AFTER: through the forest
INSERT_BEFORE: under the moonlight
REASONING: Key visual scene
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].text).toBe(
        '1girl, forest, moonlight, highly detailed'
      );
      expect(result.suggestions[0].insertAfter).toBe('through the forest');
      expect(result.suggestions[0].insertBefore).toBe('under the moonlight');
      expect(result.suggestions[0].reasoning).toBe('Key visual scene');
    });

    it('should parse valid plain text response with multiple prompts', async () => {
      const messageText = 'Complex scene with multiple events.';
      const llmResponse = `---PROMPT---
TEXT: first scene
INSERT_AFTER: event one
INSERT_BEFORE: event two
REASONING: First moment
---PROMPT---
TEXT: second scene
INSERT_AFTER: event two
INSERT_BEFORE: event three
REASONING: Second moment
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(2);
      expect(result.suggestions[0].text).toBe('first scene');
      expect(result.suggestions[1].text).toBe('second scene');
    });

    it('should handle response with explanatory text before/after', async () => {
      const messageText = 'Test message.';
      const llmResponse = `Here are the prompts:
---PROMPT---
TEXT: test prompt
INSERT_AFTER: test
INSERT_BEFORE: message
REASONING: Test scene
---END---
Hope this helps!`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].text).toBe('test prompt');
    });

    it('should return no-prompts status when LLM returns no prompts', async () => {
      const messageText = 'No visual content here.';
      const llmResponse = '---END---';

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('no-prompts');
      expect(result.suggestions).toHaveLength(0);
    });

    it('should return error status on malformed response', async () => {
      const messageText = 'Test message.';
      const llmResponse = 'This is not a valid format at all';

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('error');
      expect(result.suggestions).toHaveLength(0);
      expect(result.errorType).toBe('invalid-format');
    });

    it('should return no-prompts status when response has ---END--- but no prompts', async () => {
      const messageText = 'Test message.';
      const llmResponse = `Some text but no prompts
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('no-prompts');
      expect(result.suggestions).toHaveLength(0);
    });

    it('should skip prompts with missing required fields', async () => {
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT: valid prompt
INSERT_AFTER: test
INSERT_BEFORE: message
REASONING: Valid
---PROMPT---
TEXT: missing insertAfter
INSERT_BEFORE: message
REASONING: Invalid
---PROMPT---
TEXT: another valid
INSERT_AFTER: another
INSERT_BEFORE: test
REASONING: Valid too
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(2);
      expect(result.suggestions[0].text).toBe('valid prompt');
      expect(result.suggestions[1].text).toBe('another valid');
    });

    it('should skip prompts with empty fields', async () => {
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT: valid prompt
INSERT_AFTER: test
INSERT_BEFORE: message
REASONING: Valid
---PROMPT---
INSERT_AFTER: test
INSERT_BEFORE: message
REASONING: Missing TEXT field entirely
---PROMPT---
TEXT: another invalid
INSERT_AFTER: test
REASONING: Missing INSERT_BEFORE field
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].text).toBe('valid prompt');
    });

    it('should respect maxPromptsPerMessage limit', async () => {
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT: prompt1
INSERT_AFTER: a
INSERT_BEFORE: b
REASONING: First
---PROMPT---
TEXT: prompt2
INSERT_AFTER: c
INSERT_BEFORE: d
REASONING: Second
---PROMPT---
TEXT: prompt3
INSERT_AFTER: e
INSERT_BEFORE: f
REASONING: Third
---PROMPT---
TEXT: prompt4
INSERT_AFTER: g
INSERT_BEFORE: h
REASONING: Fourth
---PROMPT---
TEXT: prompt5
INSERT_AFTER: i
INSERT_BEFORE: j
REASONING: Fifth
---PROMPT---
TEXT: prompt6
INSERT_AFTER: k
INSERT_BEFORE: l
REASONING: Sixth (should be cut off)
---PROMPT---
TEXT: prompt7
INSERT_AFTER: m
INSERT_BEFORE: n
REASONING: Seventh (should be cut off)
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      // Settings has maxPromptsPerMessage = 5
      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(5);
      expect(result.suggestions.map(p => p.text)).toEqual([
        'prompt1',
        'prompt2',
        'prompt3',
        'prompt4',
        'prompt5',
      ]);
    });

    it('should handle maxPromptsPerMessage limit of 1', async () => {
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT: prompt1
INSERT_AFTER: a
INSERT_BEFORE: b
REASONING: First
---PROMPT---
TEXT: prompt2
INSERT_AFTER: c
INSERT_BEFORE: d
REASONING: Second
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      mockSettings.maxPromptsPerMessage = 1;

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].text).toBe('prompt1');
    });

    it('should return error status when generateRaw throws error', async () => {
      const messageText = 'Test message.';

      vi.mocked(mockContext.generateRaw).mockRejectedValue(
        new Error('LLM error')
      );

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('error');
      expect(result.suggestions).toHaveLength(0);
      expect(result.errorType).toBe('llm-call-failed');
    });

    it('should fall back to generateRaw(messages) when generateRaw(string) fails', async () => {
      const messageText = 'She walked through the forest under the moonlight.';
      const llmResponse = `---PROMPT---
TEXT: 1girl, forest, moonlight, highly detailed
INSERT_AFTER: through the forest
INSERT_BEFORE: under the moonlight
REASONING: Key visual scene
---END---`;

      vi.mocked(mockContext.generateRaw).mockImplementation(async options => {
        if (typeof options.prompt === 'string') {
          throw new Error('502 Bad Gateway');
        }
        return llmResponse;
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(vi.mocked(mockContext.generateRaw)).toHaveBeenCalledTimes(2);
    });

    it('should fall back to generateQuietPrompt when generateRaw fails', async () => {
      const messageText = 'She walked through the forest under the moonlight.';
      const llmResponse = `---PROMPT---
TEXT: 1girl, forest, moonlight, highly detailed
INSERT_AFTER: through the forest
INSERT_BEFORE: under the moonlight
REASONING: Key visual scene
---END---`;

      vi.mocked(mockContext.generateRaw).mockRejectedValue(
        new Error('502 Bad Gateway')
      );
      vi.mocked(mockContext.generateQuietPrompt).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(vi.mocked(mockContext.generateQuietPrompt)).toHaveBeenCalledTimes(
        1
      );
    });

    it('should return error status when generateRaw is not available', async () => {
      const messageText = 'Test message.';
      const contextWithoutGenerateRaw = {} as SillyTavernContext;

      const result = await generatePromptsForMessage(
        messageText,
        contextWithoutGenerateRaw,
        mockSettings
      );

      expect(result.status).toBe('error');
      expect(result.errorType).toBe('generateRaw-unavailable');
    });

    it('should trim whitespace from prompt fields', async () => {
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT:    prompt with spaces
INSERT_AFTER:   before
INSERT_BEFORE:   after
REASONING:   reason
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].text).toBe('prompt with spaces');
      expect(result.suggestions[0].insertAfter).toBe('before');
      expect(result.suggestions[0].insertBefore).toBe('after');
    });

    it('should handle prompts with special characters', async () => {
      const messageText = 'Test message with "quotes" and special chars.';
      const llmResponse = `---PROMPT---
TEXT: prompt with "quotes" and $pecial chars
INSERT_AFTER: message with "quotes"
INSERT_BEFORE: and special
REASONING: Test special characters
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].text).toBe(
        'prompt with "quotes" and $pecial chars'
      );
      expect(result.suggestions[0].insertAfter).toBe('message with "quotes"');
    });

    it('should handle Unicode characters in prompts', async () => {
      const messageText = '她走进花园。玫瑰盛开着。';
      const llmResponse = `---PROMPT---
TEXT: 1个女孩，花园，细节
INSERT_AFTER: 走进花园。
INSERT_BEFORE: 玫瑰盛开着
REASONING: 中文测试
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].text).toBe('1个女孩，花园，细节');
      expect(result.suggestions[0].insertAfter).toBe('走进花园。');
      expect(result.suggestions[0].insertBefore).toBe('玫瑰盛开着');
    });

    it('should handle reasoning field being optional', async () => {
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT: prompt without reasoning
INSERT_AFTER: test
INSERT_BEFORE: message
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].text).toBe('prompt without reasoning');
      expect(result.suggestions[0].reasoning).toBeUndefined();
    });

    it('should handle markdown code blocks', async () => {
      const messageText = 'Test message.';
      const llmResponse = `\`\`\`
---PROMPT---
TEXT: test prompt
INSERT_AFTER: test
INSERT_BEFORE: message
REASONING: Test
---END---
\`\`\``;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].text).toBe('test prompt');
    });

    it('should handle newlines in field values', async () => {
      const messageText = 'Test\n\nmessage with newlines.';
      const llmResponse = `---PROMPT---
TEXT: test prompt
INSERT_AFTER: Test

INSERT_BEFORE: message with newlines
REASONING: Handles newlines naturally
---END---`;

      vi.mocked(mockContext.generateRaw).mockResolvedValue(llmResponse);

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result.status).toBe('success');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].text).toBe('test prompt');
      // The regex captures only the first line for INSERT_AFTER/INSERT_BEFORE
      expect(result.suggestions[0].insertAfter).toBe('Test');
      expect(result.suggestions[0].insertBefore).toBe('message with newlines');
    });
  });
});
