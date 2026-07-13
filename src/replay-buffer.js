export const REPLAY_SAMPLE_INTERVAL_MS = 250;
export const REPLAY_WINDOW_MS = 60_000;
export const REPLAY_MAX_BYTES = 32 * 1024 * 1024;

export const REPLAY_FLAG_PEDESTRIAN = 1 << 0;
export const REPLAY_FLAG_WAITING = 1 << 1;
export const REPLAY_FLAG_RELOCATED = 1 << 2;

// Account conservatively for the retained frame object and its typed-array views.
// `byteLength` therefore remains a strict upper bound for the ring's own payload
// and bookkeeping, rather than only counting coordinate bytes.
const FRAME_OVERHEAD_BYTES = 256;
const UINT32_MAX = 0xffff_ffff;
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
  return number;
}

function positiveNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) {
    throw new RangeError(`${label} must be greater than zero.`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = positiveNumber(value, label);
  if (!Number.isSafeInteger(number)) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return number;
}

function quantizeCoordinate(value, label) {
  const quantized = Math.round(finiteNumber(value, label) * 10_000_000);
  if (quantized < INT32_MIN || quantized > INT32_MAX) {
    throw new RangeError(`${label} is outside the replay coordinate range.`);
  }
  return quantized;
}

function quantizeHeading(value) {
  const heading = finiteNumber(value ?? 0, "Agent heading");
  const normalized = ((heading % 360) + 360) % 360;
  return Math.round(normalized * 10) % 3600;
}

function typedArraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function framesEqual(left, right) {
  return (
    typedArraysEqual(left.ids, right.ids)
    && typedArraysEqual(left.coordinates, right.coordinates)
    && typedArraysEqual(left.headings, right.headings)
    && typedArraysEqual(left.flags, right.flags)
  );
}

function frameByteLength(frame) {
  return (
    FRAME_OVERHEAD_BYTES
    + frame.ids.byteLength
    + frame.coordinates.byteLength
    + frame.headings.byteLength
    + frame.flags.byteLength
  );
}

function currentMonotonicTime() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function normalizeRelocatedIds(relocatedAgentIds) {
  if (relocatedAgentIds === undefined || relocatedAgentIds === null) {
    return [];
  }
  if (typeof relocatedAgentIds[Symbol.iterator] !== "function") {
    throw new TypeError("relocatedAgentIds must be iterable.");
  }
  return relocatedAgentIds;
}

function packAgents(agents, relocatedIds) {
  if (!Array.isArray(agents)) {
    throw new TypeError("Replay agents must be an array.");
  }
  const count = agents.length;
  const ids = new Uint32Array(count);
  const coordinates = new Int32Array(count * 2);
  const headings = new Uint16Array(count);
  const flags = new Uint8Array(count);
  const seenIds = new Set();

  for (let index = 0; index < count; index += 1) {
    const agent = agents[index];
    if (!agent || typeof agent !== "object") {
      throw new TypeError("Replay agent entries must be objects.");
    }
    const id = Number(agent.id);
    if (!Number.isSafeInteger(id) || id <= 0 || id > UINT32_MAX) {
      throw new RangeError("Replay agent ids must be unique positive uint32 values.");
    }
    if (seenIds.has(id)) {
      throw new RangeError(`Duplicate replay agent id: ${id}.`);
    }
    seenIds.add(id);
    ids[index] = id;
    coordinates[index * 2] = quantizeCoordinate(agent.lat, "Agent latitude");
    coordinates[index * 2 + 1] = quantizeCoordinate(agent.lng, "Agent longitude");
    headings[index] = quantizeHeading(agent.heading);

    let flag = 0;
    if (agent.mode === "pedestrian") {
      flag |= REPLAY_FLAG_PEDESTRIAN;
    } else if (agent.mode !== "car") {
      throw new RangeError(`Unsupported replay agent mode: ${agent.mode}.`);
    }
    if (agent.waiting) {
      flag |= REPLAY_FLAG_WAITING;
    }
    if (agent.relocated || relocatedIds.has(id)) {
      flag |= REPLAY_FLAG_RELOCATED;
    }
    flags[index] = flag;
  }

  return { ids, coordinates, headings, flags };
}

function decodedFrame(frame) {
  const agents = new Array(frame.ids.length);
  for (let index = 0; index < frame.ids.length; index += 1) {
    const flag = frame.flags[index];
    agents[index] = {
      id: frame.ids[index],
      mode: flag & REPLAY_FLAG_PEDESTRIAN ? "pedestrian" : "car",
      lat: frame.coordinates[index * 2] / 10_000_000,
      lng: frame.coordinates[index * 2 + 1] / 10_000_000,
      heading: frame.headings[index] / 10,
      waiting: Boolean(flag & REPLAY_FLAG_WAITING),
      relocated: Boolean(flag & REPLAY_FLAG_RELOCATED),
    };
  }
  return {
    sequence: frame.sequence,
    timestampMs: frame.timestampMs,
    endTimestampMs: frame.endTimestampMs,
    simulationTimeSeconds: frame.simulationTimeSeconds,
    endSimulationTimeSeconds: frame.endSimulationTimeSeconds,
    sampleCount: frame.sampleCount,
    byteLength: frame.byteLength,
    agents,
  };
}

function frameSummary(frame) {
  return {
    sequence: frame.sequence,
    timestampMs: frame.timestampMs,
    endTimestampMs: frame.endTimestampMs,
    simulationTimeSeconds: frame.simulationTimeSeconds,
    endSimulationTimeSeconds: frame.endSimulationTimeSeconds,
    sampleCount: frame.sampleCount,
    agentCount: frame.ids.length,
    byteLength: frame.byteLength,
  };
}

function endingSimulationTime(frame) {
  const value = frame?.endSimulationTimeSeconds ?? frame?.simulationTimeSeconds;
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function endingTimestamp(frame) {
  const value = frame?.endTimestampMs ?? frame?.timestampMs;
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Return the real-time delay needed between two displayed replay frames.
 * Replay intentionally runs at one simulated second per real second, regardless
 * of the speed multiplier that was active while the history was recorded.
 */
export function replayFrameDelayMs(
  currentFrame,
  nextFrame,
  fallbackMs = REPLAY_SAMPLE_INTERVAL_MS,
) {
  const fallback = positiveNumber(fallbackMs, "fallbackMs");
  const currentSimulationTime = endingSimulationTime(currentFrame);
  const nextSimulationTime = endingSimulationTime(nextFrame);
  if (currentSimulationTime !== null && nextSimulationTime !== null) {
    return Math.max(0, (nextSimulationTime - currentSimulationTime) * 1_000);
  }

  const currentTimestamp = endingTimestamp(currentFrame);
  const nextTimestamp = endingTimestamp(nextFrame);
  if (currentTimestamp !== null && nextTimestamp !== null) {
    return Math.max(0, nextTimestamp - currentTimestamp);
  }
  return fallback;
}

class ReplaySnapshot {
  constructor(frames) {
    // Copy the small frame descriptors but share their immutable typed arrays.
    // A live append may coalesce into the buffer's newest frame; copying the
    // scalar time fields keeps an in-progress playback endpoint fixed.
    this.frames = frames.map((frame) => ({ ...frame }));
  }

  get length() {
    return this.frames.length;
  }

  get oldestSequence() {
    return this.frames[0]?.sequence ?? null;
  }

  get newestSequence() {
    return this.frames.at(-1)?.sequence ?? null;
  }

  decode(sequence = this.newestSequence) {
    if (sequence === null) {
      return null;
    }
    const normalized = Number(sequence);
    if (!Number.isSafeInteger(normalized)) {
      throw new TypeError("Replay sequence must be a safe integer.");
    }
    const frame = this.frames.find((candidate) => candidate.sequence === normalized);
    return frame ? decodedFrame(frame) : null;
  }

  summaries() {
    return this.frames.map(frameSummary);
  }
}

export class ReplayBuffer {
  constructor({
    sampleIntervalMs = REPLAY_SAMPLE_INTERVAL_MS,
    windowMs = REPLAY_WINDOW_MS,
    maxBytes = REPLAY_MAX_BYTES,
  } = {}) {
    this.sampleIntervalMs = positiveNumber(sampleIntervalMs, "sampleIntervalMs");
    this.windowMs = positiveNumber(windowMs, "windowMs");
    this.maxBytes = positiveInteger(maxBytes, "maxBytes");
    this.reset();
  }

  get length() {
    return this.frames.length;
  }

  get byteLength() {
    return this.retainedBytes;
  }

  get oldestSequence() {
    return this.frames[0]?.sequence ?? null;
  }

  get newestSequence() {
    return this.frames.at(-1)?.sequence ?? null;
  }

  get oldestTimestampMs() {
    return this.frames[0]?.timestampMs ?? null;
  }

  get newestTimestampMs() {
    return this.frames.at(-1)?.endTimestampMs ?? null;
  }

  reset() {
    this.frames = [];
    this.retainedBytes = 0;
    this.nextSequence = 1;
    this.lastSampleTimestampMs = null;
    this.lastObservedTimestampMs = null;
    this.pendingRelocatedIds = new Set();
  }

  append(agents, {
    timestampMs = currentMonotonicTime(),
    simulationTimeSeconds = null,
    relocatedAgentIds = null,
    force = false,
  } = {}) {
    if (!Array.isArray(agents)) {
      throw new TypeError("Replay agents must be an array.");
    }
    const timestamp = finiteNumber(timestampMs, "timestampMs");
    if (
      this.lastObservedTimestampMs !== null
      && timestamp < this.lastObservedTimestampMs
    ) {
      throw new RangeError("Replay timestamps must be monotonic.");
    }
    const simulationTime = simulationTimeSeconds === null
      ? null
      : finiteNumber(simulationTimeSeconds, "simulationTimeSeconds");
    const relocated = new Set(normalizeRelocatedIds(relocatedAgentIds));
    for (const agent of agents) {
      if (agent?.relocated) {
        relocated.add(Number(agent.id));
      }
    }
    for (const id of relocated) {
      if (Number.isSafeInteger(Number(id)) && Number(id) > 0) {
        this.pendingRelocatedIds.add(Number(id));
      }
    }

    this.lastObservedTimestampMs = timestamp;
    this.evict(timestamp);
    if (
      !force
      && this.lastSampleTimestampMs !== null
      && timestamp - this.lastSampleTimestampMs < this.sampleIntervalMs
    ) {
      return this.result("sampled-out", null);
    }

    const packed = packAgents(agents, this.pendingRelocatedIds);
    const candidate = {
      sequence: this.nextSequence,
      timestampMs: timestamp,
      endTimestampMs: timestamp,
      simulationTimeSeconds: simulationTime,
      endSimulationTimeSeconds: simulationTime,
      sampleCount: 1,
      ...packed,
    };
    candidate.byteLength = frameByteLength(candidate);
    if (candidate.byteLength > this.maxBytes) {
      throw new RangeError(
        `A replay frame (${candidate.byteLength} bytes) exceeds maxBytes (${this.maxBytes}).`,
      );
    }

    this.lastSampleTimestampMs = timestamp;
    this.pendingRelocatedIds.clear();
    const previous = this.frames.at(-1);
    const previousSimulationTime = endingSimulationTime(previous);
    const sameSimulationInstant = (
      simulationTime !== null
      && previousSimulationTime !== null
      && simulationTime === previousSimulationTime
    );
    if (previous && sameSimulationInstant && framesEqual(previous, candidate)) {
      previous.endTimestampMs = timestamp;
      previous.endSimulationTimeSeconds = simulationTime;
      previous.sampleCount += 1;
      this.evict(timestamp);
      return this.result("coalesced", previous.sequence);
    }

    this.nextSequence += 1;
    this.frames.push(candidate);
    this.retainedBytes += candidate.byteLength;
    this.evict(timestamp);
    return this.result("appended", candidate.sequence);
  }

  decode(sequence = this.newestSequence) {
    if (sequence === null) {
      return null;
    }
    const normalized = Number(sequence);
    if (!Number.isSafeInteger(normalized)) {
      throw new TypeError("Replay sequence must be a safe integer.");
    }
    const frame = this.frames.find((candidate) => candidate.sequence === normalized);
    return frame ? decodedFrame(frame) : null;
  }

  seek(timestampMs) {
    if (this.frames.length === 0) {
      return null;
    }
    const timestamp = finiteNumber(timestampMs, "timestampMs");
    let lower = 0;
    let upper = this.frames.length - 1;
    let selected = 0;
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (this.frames[middle].timestampMs <= timestamp) {
        selected = middle;
        lower = middle + 1;
      } else {
        upper = middle - 1;
      }
    }
    return decodedFrame(this.frames[selected]);
  }

  summaries() {
    return this.frames.map(frameSummary);
  }

  snapshot() {
    return new ReplaySnapshot(this.frames);
  }

  result(status, sequence) {
    return {
      status,
      sequence,
      length: this.length,
      byteLength: this.byteLength,
      oldestSequence: this.oldestSequence,
      newestSequence: this.newestSequence,
    };
  }

  evict(referenceTimestampMs) {
    const cutoff = referenceTimestampMs - this.windowMs;
    while (
      this.frames.length > 0
      && this.frames[0].endTimestampMs < cutoff
    ) {
      this.removeOldest();
    }
    if (
      this.frames.length > 0
      && this.frames[0].timestampMs < cutoff
    ) {
      this.frames[0].timestampMs = cutoff;
    }
    while (this.retainedBytes > this.maxBytes && this.frames.length > 0) {
      this.removeOldest();
    }
  }

  removeOldest() {
    const removed = this.frames.shift();
    if (removed) {
      this.retainedBytes -= removed.byteLength;
    }
  }
}

export function createReplayBuffer(options) {
  return new ReplayBuffer(options);
}
