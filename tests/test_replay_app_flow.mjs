import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class FakeElement {
  constructor() {
    this.disabled = false;
    this.hidden = true;
    this.value = "0";
    this.textContent = "";
    this.listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.style = { setProperty() {} };
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  querySelectorAll() {
    return [];
  }

  replaceChildren() {}
  append() {}
  setAttribute() {}
}

const elements = new Map();
const fakeDocument = {
  hidden: false,
  activeElement: null,
  querySelector(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, new FakeElement());
    }
    return elements.get(selector);
  },
  addEventListener() {},
  createElement() { return new FakeElement(); },
  createDocumentFragment() { return new FakeElement(); },
};
globalThis.document = fakeDocument;
globalThis.window = globalThis;
const storageWrites = [];
globalThis.localStorage = {
  getItem(key) {
    assert.equal(key, "ujbuda-traffic-agent-color-modes-v1");
    return JSON.stringify({ car: "individual", pedestrian: "uniform" });
  },
  setItem(key, value) {
    storageWrites.push({ key, value });
  },
};

const replaySource = await readFile(
  new URL("../src/replay-buffer.js", import.meta.url),
  "utf8",
);
const replayModule = await import(
  `data:text/javascript;base64,${Buffer.from(replaySource).toString("base64")}`,
);
globalThis.__replayModuleForAppTest = replayModule;

let appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
appSource = appSource
  .replace(
    /^import \{ LocalTrafficMap[^\n]+\n/,
    "const LocalTrafficMap = class {}; const POI_CATEGORY_STYLE = { other: { label: 'Egyéb', color: '#aaa', priority: 0 } }; const roadModeForSegment = () => 'mixed';\n",
  )
  .replace(
    /import \{\s*STATE_PROTOCOL_VERSION[\s\S]*?\} from "\.\/state-protocol\.js";/,
    "const STATE_PROTOCOL_VERSION = 2; class StateProtocolError extends Error {} const createStateProtocolCache = () => ({ revision: null, agents: new Map() }); const reduceSimulationState = (wire, cache) => ({ payload: wire, cache });",
  )
  .replace(
    /import \{ pollDelayAfterElapsed \} from "\.\/simulation-timing\.js";/,
    "const pollDelayAfterElapsed = () => 125;",
  )
  .replace(
    /import \{\s*REPLAY_SAMPLE_INTERVAL_MS,[\s\S]*?\} from "\.\/replay-buffer\.js";/,
    "const { REPLAY_SAMPLE_INTERVAL_MS, createReplayBuffer, replayFrameDelayMs } = globalThis.__replayModuleForAppTest;",
  );

const startupPattern = /\nupdateReplayUi\(\);\ninitializeApplication\(\);\s*$/;
assert.match(appSource, startupPattern);
appSource = appSource.replace(
  startupPattern,
  "\nexport const replayAppTest = { state, consumeSimulationState, presentReplaySequence, returnToLive, toggleReplayPlayback, selectedSimulationStatePath, inspectFeature, loadAgentColorModes, persistAgentColorModes };\n",
);

const appModule = await import(
  `data:text/javascript;base64,${Buffer.from(appSource).toString("base64")}`,
);
const app = appModule.replayAppTest;
const mapCalls = [];
const freezeCalls = [];
const colorModeCalls = [];
app.state.localMap = {
  setAgents(agents, options) { mapCalls.push({ agents, options }); },
  freezeAgentTransition(timestamp) { freezeCalls.push(timestamp); },
  setAgentColorModes(modes) { colorModeCalls.push({ ...modes }); },
  setSelectedAgentRoute() { return true; },
};

assert.deepEqual(app.state.agentColorModes, {
  car: "individual",
  pedestrian: "uniform",
});
assert.equal(elements.get("#car-individual-colors").checked, true);
assert.equal(elements.get("#pedestrian-individual-colors").checked, false);
const pedestrianColorToggle = elements.get("#pedestrian-individual-colors");
pedestrianColorToggle.checked = true;
pedestrianColorToggle.listeners.get("change")({ currentTarget: pedestrianColorToggle });
assert.deepEqual(colorModeCalls.at(-1), {
  car: "individual",
  pedestrian: "individual",
});
assert.deepEqual(JSON.parse(storageWrites.at(-1).value), colorModeCalls.at(-1));
const carColorToggle = elements.get("#car-individual-colors");
carColorToggle.checked = false;
carColorToggle.listeners.get("change")({ currentTarget: carColorToggle });
assert.deepEqual(colorModeCalls.at(-1), {
  car: "uniform",
  pedestrian: "individual",
});

const workingStorage = globalThis.localStorage;
globalThis.localStorage = {
  getItem() { return "{"; },
  setItem() {},
};
assert.deepEqual(app.loadAgentColorModes(), {
  car: "uniform",
  pedestrian: "uniform",
});
globalThis.localStorage = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
};
assert.deepEqual(app.loadAgentColorModes(), {
  car: "uniform",
  pedestrian: "uniform",
});
assert.doesNotThrow(() => app.persistAgentColorModes({ car: "individual" }));
globalThis.localStorage = workingStorage;

const firstPayload = {
  configured: true,
  running: true,
  serverInstanceId: "server-test",
  simulationEpoch: 1,
  speedMultiplier: 15,
  agents: [{ id: 1, mode: "car", lat: 47.47, lng: 19.03, heading: 0, waiting: false }],
  stats: { cars: 1, pedestrians: 0, elapsedSeconds: 1 },
};
assert.equal(app.consumeSimulationState(firstPayload), true);
assert.equal(app.state.replayBuffer.length, 1);
assert.equal(mapCalls.length, 1);

app.state.replayBuffer.lastSampleTimestampMs -= 300;
const secondPayload = {
  ...firstPayload,
  agents: [{ ...firstPayload.agents[0], lat: 47.4701 }],
  stats: { ...firstPayload.stats, elapsedSeconds: 2 },
};
app.consumeSimulationState(secondPayload, { observeInterval: true });
assert.equal(app.state.replayBuffer.length, 2);
assert.equal(mapCalls.length, 2);

const oldestSequence = app.state.replayBuffer.oldestSequence;
assert.equal(app.presentReplaySequence(oldestSequence), true);
assert.equal(app.state.replayMode, "history");
assert.equal(elements.get("#car-count").disabled, true);
assert.equal(mapCalls.at(-1).options.resetTiming, true);
assert.equal(mapCalls.at(-1).options.snapAgentIds.has("1"), true);

app.inspectFeature({ type: "agent", agent: mapCalls.at(-1).agents[0] });
assert.equal(app.selectedSimulationStatePath().includes("selectedAgentId"), false);

const callsBeforeBackgroundPoll = mapCalls.length;
app.state.replayBuffer.lastSampleTimestampMs -= 300;
app.consumeSimulationState({
  ...secondPayload,
  agents: [{ ...secondPayload.agents[0], lat: 47.4702 }],
  stats: { ...secondPayload.stats, elapsedSeconds: 3 },
});
assert.equal(mapCalls.length, callsBeforeBackgroundPoll);

app.returnToLive();
assert.equal(app.state.replayMode, "live");
assert.equal(elements.get("#car-count").disabled, false);
assert.equal(mapCalls.length, callsBeforeBackgroundPoll + 1);
assert.equal(mapCalls.at(-1).agents[0].lat, 47.4702);
assert.equal(mapCalls.at(-1).options.snapAgentIds.has("1"), true);

app.state.replayBuffer.lastSampleTimestampMs -= 300;
app.consumeSimulationState({
  ...secondPayload,
  agents: [{ ...secondPayload.agents[0], lat: 47.4703 }],
  stats: { ...secondPayload.stats, elapsedSeconds: 15 },
});
const replayStartSequence = app.state.replayBuffer.newestSequence - 1;
assert.equal(app.state.replayBuffer.decode(replayStartSequence).endSimulationTimeSeconds, 3);
assert.equal(app.presentReplaySequence(replayStartSequence), true);

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativePerformanceDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "performance",
);
const scheduledTimers = [];
let fakeNow = 1_000_000;
globalThis.setTimeout = (callback, delay) => {
  const timer = { callback, delay, cleared: false };
  scheduledTimers.push(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => {
  if (timer) {
    timer.cleared = true;
  }
};
Object.defineProperty(globalThis, "performance", {
  configurable: true,
  value: { now: () => fakeNow },
});

try {
  const callsBeforePlayback = mapCalls.length;
  app.toggleReplayPlayback();
  assert.equal(app.state.replayPlaying, true);
  assert.equal(mapCalls.length, callsBeforePlayback + 1);
  assert.equal(mapCalls.at(-1).agents[0].lat, 47.4703);
  assert.equal(mapCalls.at(-1).options.animate, true);
  assert.equal(mapCalls.at(-1).options.transitionDurationMs, 12_000);
  assert.equal(app.state.replayCursorSequence, replayStartSequence);
  assert.equal(elements.get("#replay-range").value, String(replayStartSequence));
  assert.match(elements.get("#replay-position").textContent, /00:00:03/);
  assert.equal(scheduledTimers.length, 1);
  assert.equal(scheduledTimers[0].delay, 12_000);

  fakeNow += 4_000;
  app.toggleReplayPlayback();
  assert.equal(app.state.replayPlaying, false);
  assert.equal(scheduledTimers[0].cleared, true);
  assert.deepEqual(freezeCalls, [fakeNow]);
  assert.equal(app.state.replayTransition.remainingDurationMs, 8_000);
  assert.equal(app.state.replayCursorSequence, replayStartSequence);
  assert.match(elements.get("#replay-position").textContent, /00:00:03/);

  const callsBeforeResume = mapCalls.length;
  app.toggleReplayPlayback();
  assert.equal(app.state.replayPlaying, true);
  assert.equal(mapCalls.length, callsBeforeResume + 1);
  assert.equal(mapCalls.at(-1).agents[0].lat, 47.4703);
  assert.equal(mapCalls.at(-1).options.transitionDurationMs, 8_000);
  assert.equal(scheduledTimers.length, 2);
  assert.equal(scheduledTimers[1].delay, 8_000);
  assert.equal(app.state.replayCursorSequence, replayStartSequence);

  // A faster live simulation may advance substantially during historical
  // playback. It must be recorded in the background without moving the fixed
  // playback endpoint or shortening its already scheduled twelve seconds.
  app.state.replayBuffer.lastSampleTimestampMs -= 300;
  const callsBeforeLiveAdvance = mapCalls.length;
  app.consumeSimulationState({
    ...secondPayload,
    agents: [{ ...secondPayload.agents[0], lat: 47.4704 }],
    stats: { ...secondPayload.stats, elapsedSeconds: 30 },
  });
  assert.equal(mapCalls.length, callsBeforeLiveAdvance);
  assert.equal(scheduledTimers.length, 2);
  assert.equal(scheduledTimers[1].delay, 8_000);
  assert.equal(app.state.replayBuffer.decode(replayStartSequence), null);

  // The fixed playback snapshot may outlive the live ring. Scrubbing must
  // still decode from that snapshot and playing again must keep using it.
  const replayRange = elements.get("#replay-range");
  replayRange.value = String(replayStartSequence);
  replayRange.listeners.get("input")();
  assert.equal(scheduledTimers[1].cleared, true);
  assert.notEqual(app.state.replayPlaybackSnapshot, null);
  assert.equal(app.state.replayCursorSequence, replayStartSequence);
  assert.equal(mapCalls.at(-1).agents[0].lat, 47.4702);

  app.toggleReplayPlayback();
  assert.equal(app.state.replayPlaying, true);
  assert.equal(scheduledTimers.length, 3);
  assert.equal(scheduledTimers[2].delay, 12_000);

  fakeNow += 12_000;
  scheduledTimers[2].callback();
  assert.equal(app.state.replayPlaying, false);
  assert.equal(app.state.replayMode, "live");
  assert.equal(mapCalls.at(-1).agents[0].lat, 47.4704);
} finally {
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
  Object.defineProperty(globalThis, "performance", nativePerformanceDescriptor);
}

console.log("replay app live/history/background-poll contract: OK");
