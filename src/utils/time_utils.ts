export function formatDurationClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad2 = (value: number) => String(value).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  }

  return `${minutes}:${pad2(seconds)}`;
}

export function estimateRemainingQueueMs(params: {
  pendingCount: number;
  cooldownRemainingMs: number;
  averageGenerationDurationMs: number | null;
  minGenerationIntervalMs: number;
  maxConcurrent?: number;
}): number | null {
  const pendingCount = Math.max(0, Math.floor(params.pendingCount));
  if (pendingCount === 0) return 0;

  const averageGenerationDurationMs = params.averageGenerationDurationMs;
  if (
    averageGenerationDurationMs === null ||
    !Number.isFinite(averageGenerationDurationMs) ||
    averageGenerationDurationMs <= 0
  ) {
    return null;
  }

  const minGenerationIntervalMs = Math.max(0, params.minGenerationIntervalMs);
  const cooldownRemainingMs = Math.max(0, params.cooldownRemainingMs);
  const maxConcurrent = Math.max(1, params.maxConcurrent ?? 1);

  // Best-effort approximation:
  // - If cooldown is configured, we assume sequential throughput.
  // - Without cooldown, approximate batching by maxConcurrent.
  if (minGenerationIntervalMs > 0 || maxConcurrent <= 1) {
    const cooldownGapsMs =
      Math.max(0, pendingCount - 1) * minGenerationIntervalMs;
    return (
      cooldownRemainingMs +
      pendingCount * averageGenerationDurationMs +
      cooldownGapsMs
    );
  }

  // No cooldown, concurrent generation: estimate "waves" of maxConcurrent.
  const waves = Math.ceil(pendingCount / maxConcurrent);
  return waves * averageGenerationDurationMs;
}
