export const RUNNING_POLL_INTERVAL_MS = 125;
export const HIGH_AGENT_POLL_THRESHOLD = 3_000;
export const HIGH_AGENT_POLL_INTERVAL_MS = 200;
export const IDLE_POLL_INTERVAL_MS = 750;
export const DEFAULT_AGENT_FRAME_INTERVAL_MS = RUNNING_POLL_INTERVAL_MS;

const MIN_OBSERVED_FRAME_INTERVAL_MS = 50;
const MAX_OBSERVED_FRAME_INTERVAL_MS = 300;
const FRAME_INTERVAL_SMOOTHING = 0.25;
const TRANSITION_SETTLE_MARGIN_MS = 24;
const MIN_TRANSITION_DURATION_MS = 90;
const MAX_TRANSITION_DURATION_MS = 330;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function runningPollIntervalForAgentCount(agentCount = 0) {
  return Number(agentCount) >= HIGH_AGENT_POLL_THRESHOLD
    ? HIGH_AGENT_POLL_INTERVAL_MS
    : RUNNING_POLL_INTERVAL_MS;
}

export function pollDelayAfterElapsed({
  running,
  failures = 0,
  elapsedMs = 0,
  agentCount = 0,
}) {
  const runningInterval = runningPollIntervalForAgentCount(agentCount);
  const baseInterval = running ? runningInterval : IDLE_POLL_INTERVAL_MS;
  const retryInterval = failures === 0
    ? baseInterval
    : Math.min(10000, baseInterval * (2 ** Math.min(failures, 4)));
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return Math.max(0, retryInterval - elapsed);
}

export function updateAgentFrameInterval(previousIntervalMs, observedIntervalMs) {
  const previous = Number.isFinite(previousIntervalMs)
    ? previousIntervalMs
    : DEFAULT_AGENT_FRAME_INTERVAL_MS;
  if (
    !Number.isFinite(observedIntervalMs)
    || observedIntervalMs < MIN_OBSERVED_FRAME_INTERVAL_MS
    || observedIntervalMs > MAX_OBSERVED_FRAME_INTERVAL_MS
  ) {
    return previous;
  }
  return previous + (observedIntervalMs - previous) * FRAME_INTERVAL_SMOOTHING;
}

export function agentTransitionDuration(frameIntervalMs) {
  const interval = Number.isFinite(frameIntervalMs)
    ? frameIntervalMs
    : DEFAULT_AGENT_FRAME_INTERVAL_MS;
  return clamp(
    interval - TRANSITION_SETTLE_MARGIN_MS,
    MIN_TRANSITION_DURATION_MS,
    MAX_TRANSITION_DURATION_MS,
  );
}

export function interpolationProgress(timestamp, transitionStarted, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 1;
  }
  return clamp((timestamp - transitionStarted) / durationMs, 0, 1);
}

export function interpolateHeading(startHeading, endHeading, progress) {
  const start = Number(startHeading);
  const end = Number(endHeading);
  if (!Number.isFinite(end)) {
    return Number.isFinite(start) ? start : 0;
  }
  if (!Number.isFinite(start)) {
    return ((end % 360) + 360) % 360;
  }
  const amount = clamp(Number.isFinite(progress) ? progress : 1, 0, 1);
  const delta = ((end - start + 540) % 360) - 180;
  return ((start + delta * amount) % 360 + 360) % 360;
}
