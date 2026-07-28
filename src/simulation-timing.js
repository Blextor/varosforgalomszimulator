export const RUNNING_POLL_INTERVAL_MS = 125;
export const HIGH_AGENT_POLL_THRESHOLD = 3_000;
export const HIGH_AGENT_POLL_INTERVAL_MS = 200;
export const IDLE_POLL_INTERVAL_MS = 750;
export const DEFAULT_AGENT_FRAME_INTERVAL_MS = RUNNING_POLL_INTERVAL_MS;

const MIN_OBSERVED_FRAME_INTERVAL_MS = 50;
const MAX_OBSERVED_FRAME_INTERVAL_MS = 300;
const FRAME_INTERVAL_SMOOTHING = 0.25;
const MIN_TRANSITION_DURATION_MS = 90;
const MAX_TRANSITION_DURATION_MS = 330;
const METERS_PER_LATITUDE_DEGREE = 111_320;
const MIN_CURVE_DISTANCE_METERS = 0.75;
const MAX_CURVE_DISTANCE_METERS = 80;
const MAX_CURVE_HEADING_DELTA_DEGREES = 120;
const MIN_CURVE_FORWARD_DOT = 0.25;
const MAX_CURVE_CONTROL_DISTANCE_METERS = 12;

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
    interval,
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

function normalizedHeading(value) {
  return ((value % 360) + 360) % 360;
}

function shortestHeadingDelta(startHeading, endHeading) {
  return ((endHeading - startHeading + 540) % 360) - 180;
}

function writePose(target, lat, lng, heading) {
  if (!target) {
    return { lat, lng, heading };
  }
  target.lat = lat;
  target.lng = lng;
  target.heading = heading;
  return target;
}

/**
 * Interpolate between two geographic poses.
 *
 * `target` lets a caller supply a reusable pose object. Rendering thousands of
 * agents at 60 fps would otherwise allocate one throwaway object per agent per
 * frame, and the resulting minor GCs are visible as stutter.
 */
export function interpolateGeographicPose(
  startPose,
  endPose,
  progress,
  { curve = false, metersPerLongitudeDegree = null, target = null } = {},
) {
  const amount = clamp(Number.isFinite(progress) ? progress : 1, 0, 1);
  const rawStartLatitude = Number(startPose?.lat);
  const rawStartLongitude = Number(startPose?.lng);
  const rawEndLatitude = Number(endPose?.lat);
  const rawEndLongitude = Number(endPose?.lng);
  const startLatitude = Number.isFinite(rawStartLatitude)
    ? rawStartLatitude
    : (Number.isFinite(rawEndLatitude) ? rawEndLatitude : 0);
  const startLongitude = Number.isFinite(rawStartLongitude)
    ? rawStartLongitude
    : (Number.isFinite(rawEndLongitude) ? rawEndLongitude : 0);
  const endLatitude = Number.isFinite(rawEndLatitude)
    ? rawEndLatitude
    : startLatitude;
  const endLongitude = Number.isFinite(rawEndLongitude)
    ? rawEndLongitude
    : startLongitude;
  const linearPose = writePose(
    target,
    startLatitude + (endLatitude - startLatitude) * amount,
    startLongitude + (endLongitude - startLongitude) * amount,
    interpolateHeading(startPose?.heading, endPose?.heading, amount),
  );
  const rawStartHeading = Number(startPose?.heading);
  const rawEndHeading = Number(endPose?.heading);
  if (
    curve !== true
    || !Number.isFinite(rawStartLatitude)
    || !Number.isFinite(rawStartLongitude)
    || !Number.isFinite(rawEndLatitude)
    || !Number.isFinite(rawEndLongitude)
    || !Number.isFinite(rawStartHeading)
    || !Number.isFinite(rawEndHeading)
    || amount <= 0
    || amount >= 1
  ) {
    return linearPose;
  }

  const suppliedLongitudeScale = Number(metersPerLongitudeDegree);
  const meanLatitudeRadians = (startLatitude + endLatitude) * Math.PI / 360;
  const longitudeScale = (
    Number.isFinite(suppliedLongitudeScale)
    && suppliedLongitudeScale > 0
  )
    ? suppliedLongitudeScale
    : METERS_PER_LATITUDE_DEGREE * Math.max(
      0.2,
      Math.abs(Math.cos(meanLatitudeRadians)),
    );
  const endX = (endLongitude - startLongitude) * longitudeScale;
  const endY = (startLatitude - endLatitude) * METERS_PER_LATITUDE_DEGREE;
  const distance = Math.hypot(endX, endY);
  if (
    distance < MIN_CURVE_DISTANCE_METERS
    || distance > MAX_CURVE_DISTANCE_METERS
  ) {
    return linearPose;
  }

  const startHeading = normalizedHeading(rawStartHeading);
  const endHeading = normalizedHeading(rawEndHeading);
  const headingDelta = shortestHeadingDelta(startHeading, endHeading);
  if (Math.abs(headingDelta) > MAX_CURVE_HEADING_DELTA_DEGREES) {
    return linearPose;
  }

  const chordX = endX / distance;
  const chordY = endY / distance;
  const startRadians = startHeading * Math.PI / 180;
  const endRadians = endHeading * Math.PI / 180;
  const startDirectionX = Math.sin(startRadians);
  const startDirectionY = -Math.cos(startRadians);
  const endDirectionX = Math.sin(endRadians);
  const endDirectionY = -Math.cos(endRadians);
  const startForwardDot = startDirectionX * chordX + startDirectionY * chordY;
  const endForwardDot = endDirectionX * chordX + endDirectionY * chordY;
  if (
    startForwardDot < MIN_CURVE_FORWARD_DOT
    || endForwardDot < MIN_CURVE_FORWARD_DOT
  ) {
    return linearPose;
  }

  // A single Hermite arc is useful only when the chord lies between the two
  // endpoint tangents. Opposing side errors would create an artificial S bend.
  const startCross = startDirectionX * chordY - startDirectionY * chordX;
  const endCross = chordX * endDirectionY - chordY * endDirectionX;
  if (startCross * endCross < -0.01) {
    return linearPose;
  }

  const quarterTurnRadians = Math.abs(headingDelta) * Math.PI / 720;
  const circularArcControlRatio = 1 / (
    3 * Math.cos(quarterTurnRadians) ** 2
  );
  const controlDistance = Math.min(
    distance * circularArcControlRatio,
    MAX_CURVE_CONTROL_DISTANCE_METERS,
  );
  const controlOneX = startDirectionX * controlDistance;
  const controlOneY = startDirectionY * controlDistance;
  const controlTwoX = endX - endDirectionX * controlDistance;
  const controlTwoY = endY - endDirectionY * controlDistance;
  const controlOneProjection = controlOneX * chordX + controlOneY * chordY;
  const controlTwoProjection = controlTwoX * chordX + controlTwoY * chordY;
  if (
    controlOneProjection < 0
    || controlTwoProjection > distance
    || controlOneProjection > controlTwoProjection
  ) {
    return linearPose;
  }

  const inverseAmount = 1 - amount;
  const firstWeight = 3 * inverseAmount ** 2 * amount;
  const secondWeight = 3 * inverseAmount * amount ** 2;
  const endWeight = amount ** 3;
  const positionX = (
    firstWeight * controlOneX
    + secondWeight * controlTwoX
    + endWeight * endX
  );
  const positionY = (
    firstWeight * controlOneY
    + secondWeight * controlTwoY
    + endWeight * endY
  );
  const tangentX = (
    3 * inverseAmount ** 2 * controlOneX
    + 6 * inverseAmount * amount * (controlTwoX - controlOneX)
    + 3 * amount ** 2 * (endX - controlTwoX)
  );
  const tangentY = (
    3 * inverseAmount ** 2 * controlOneY
    + 6 * inverseAmount * amount * (controlTwoY - controlOneY)
    + 3 * amount ** 2 * (endY - controlTwoY)
  );
  const tangentLength = Math.hypot(tangentX, tangentY);
  const tangentHeading = tangentLength > 1e-9
    ? normalizedHeading(Math.atan2(tangentX, -tangentY) * 180 / Math.PI)
    : linearPose.heading;
  return writePose(
    target,
    startLatitude - positionY / METERS_PER_LATITUDE_DEGREE,
    startLongitude + positionX / longitudeScale,
    tangentHeading,
  );
}
