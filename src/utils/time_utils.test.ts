import {describe, expect, it} from 'vitest';

import {estimateRemainingQueueMs, formatDurationClock} from './time_utils';

describe('time_utils', () => {
  describe('formatDurationClock', () => {
    it('formats seconds as m:ss', () => {
      expect(formatDurationClock(0)).toBe('0:00');
      expect(formatDurationClock(1)).toBe('0:01');
      expect(formatDurationClock(1000)).toBe('0:01');
      expect(formatDurationClock(61_000)).toBe('1:01');
    });

    it('formats hours as h:mm:ss', () => {
      expect(formatDurationClock(3_600_000)).toBe('1:00:00');
      expect(formatDurationClock(3_661_000)).toBe('1:01:01');
    });
  });

  describe('estimateRemainingQueueMs', () => {
    it('returns 0 when no work remains', () => {
      expect(
        estimateRemainingQueueMs({
          pendingCount: 0,
          cooldownRemainingMs: 1000,
          averageGenerationDurationMs: 2000,
          minGenerationIntervalMs: 500,
        })
      ).toBe(0);
    });

    it('returns null when no average is available', () => {
      expect(
        estimateRemainingQueueMs({
          pendingCount: 3,
          cooldownRemainingMs: 1000,
          averageGenerationDurationMs: null,
          minGenerationIntervalMs: 500,
        })
      ).toBeNull();
    });

    it('estimates sequential queue time with cooldown gaps', () => {
      expect(
        estimateRemainingQueueMs({
          pendingCount: 3,
          cooldownRemainingMs: 2000,
          averageGenerationDurationMs: 5000,
          minGenerationIntervalMs: 1000,
          maxConcurrent: 3,
        })
      ).toBe(19_000);
    });

    it('estimates concurrent queue time without cooldown', () => {
      expect(
        estimateRemainingQueueMs({
          pendingCount: 5,
          cooldownRemainingMs: 0,
          averageGenerationDurationMs: 4000,
          minGenerationIntervalMs: 0,
          maxConcurrent: 2,
        })
      ).toBe(12_000);
    });
  });
});
