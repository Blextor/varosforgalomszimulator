import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class FakeElement {
  constructor() {
    this.disabled = false;
    this.hidden = true;
    this.value = "0";
    this.textContent = "";
    this.listeners = new Map();
    this.attributes = new Map();
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
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
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
const storageValues = new Map([
  [
    "ujbuda-traffic-agent-color-modes-v1",
    JSON.stringify({ car: "individual", pedestrian: "uniform" }),
  ],
  [
    "ujbuda-traffic-map-render-options-v1",
    JSON.stringify({ prepareAllLayers: true, renderFullMap: false }),
  ],
]);
globalThis.localStorage = {
  getItem(key) {
    assert.equal(storageValues.has(key), true);
    return storageValues.get(key);
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
  "\nexport const replayAppTest = { state, consumeSimulationState, presentReplaySequence, returnToLive, toggleReplayPlayback, selectedSimulationStatePath, inspectFeature, loadAgentColorModes, persistAgentColorModes, loadMapRenderOptions, persistMapRenderOptions, setMapRenderOption, handleStaticPreparationChange, handleViewportInteractionChange, pollSimulation };\n",
);

const appModule = await import(
  `data:text/javascript;base64,${Buffer.from(appSource).toString("base64")}`,
);
const app = appModule.replayAppTest;
const mapCalls = [];
const freezeCalls = [];
const colorModeCalls = [];
const staticRenderOptionCalls = [];
app.state.localMap = {
  setAgents(agents, options) { mapCalls.push({ agents, options }); },
  freezeAgentTransition(timestamp) { freezeCalls.push(timestamp); },
  setAgentColorModes(modes) { colorModeCalls.push({ ...modes }); },
  setStaticRenderOptions(options) { staticRenderOptionCalls.push({ ...options }); },
  setSelectedAgentRoute() { return true; },
  isViewportInteracting() { return false; },
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

assert.deepEqual(app.state.mapRenderOptions, {
  prepareAllLayers: true,
  renderFullMap: false,
});
assert.equal(elements.get("#prepare-all-map-layers").checked, true);
assert.equal(elements.get("#render-full-map").checked, false);
const renderStatus = elements.get("#map-render-status");
assert.match(renderStatus.textContent, /térkép betöltésekor indul/);
assert.equal(renderStatus.getAttribute("aria-busy"), "false");

const fullMapToggle = elements.get("#render-full-map");
fullMapToggle.checked = true;
fullMapToggle.listeners.get("change")({ currentTarget: fullMapToggle });
assert.deepEqual(staticRenderOptionCalls.at(-1), {
  prepareAllLayers: true,
  renderFullMap: true,
});
assert.equal(storageWrites.at(-1).key, "ujbuda-traffic-map-render-options-v1");
assert.deepEqual(JSON.parse(storageWrites.at(-1).value), staticRenderOptionCalls.at(-1));
assert.equal(renderStatus.getAttribute("aria-busy"), "true");
assert.match(renderStatus.textContent, /előkészítő indítása/);

app.handleStaticPreparationChange({ phase: "preparing", completed: 2, total: 6 });
assert.equal(renderStatus.textContent, "Térképrétegek előkészítése: 2/6…");
assert.equal(renderStatus.getAttribute("aria-busy"), "true");
app.handleStaticPreparationChange({ phase: "ready" });
assert.equal(
  renderStatus.textContent,
  "Minden részletességi szint és a teljes kerület előkészítve.",
);
assert.equal(renderStatus.getAttribute("aria-busy"), "false");
app.handleStaticPreparationChange({ phase: "limited" });
assert.match(renderStatus.textContent, /biztonságos memóriahatár/);
assert.equal(renderStatus.getAttribute("aria-busy"), "false");
app.handleStaticPreparationChange({ phase: "fallback" });
assert.match(renderStatus.textContent, /takarékos mód maradt aktív/);
assert.equal(renderStatus.getAttribute("aria-busy"), "false");

const prepareAllToggle = elements.get("#prepare-all-map-layers");
prepareAllToggle.checked = false;
prepareAllToggle.listeners.get("change")({ currentTarget: prepareAllToggle });
assert.deepEqual(staticRenderOptionCalls.at(-1), {
  prepareAllLayers: false,
  renderFullMap: true,
});
app.handleStaticPreparationChange({ phase: "ready" });
assert.equal(renderStatus.textContent, "A teljes kerület előkészítve.");
fullMapToggle.checked = false;
fullMapToggle.listeners.get("change")({ currentTarget: fullMapToggle });
assert.deepEqual(staticRenderOptionCalls.at(-1), {
  prepareAllLayers: false,
  renderFullMap: false,
});
assert.match(renderStatus.textContent, /Takarékos mód/);
assert.equal(renderStatus.getAttribute("aria-busy"), "false");
const staticCallsBeforeInvalidOption = staticRenderOptionCalls.length;
assert.equal(app.setMapRenderOption("renderFullMap", false), false);
assert.equal(app.setMapRenderOption("unknown", true), false);
assert.equal(staticRenderOptionCalls.length, staticCallsBeforeInvalidOption);

const workingStorage = globalThis.localStorage;
globalThis.localStorage = {
  getItem() { return "{"; },
  setItem() {},
};
assert.deepEqual(app.loadAgentColorModes(), {
  car: "uniform",
  pedestrian: "uniform",
});
assert.deepEqual(app.loadMapRenderOptions(), {
  prepareAllLayers: false,
  renderFullMap: false,
});
globalThis.localStorage = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
};
assert.deepEqual(app.loadAgentColorModes(), {
  car: "uniform",
  pedestrian: "uniform",
});
assert.deepEqual(app.loadMapRenderOptions(), {
  prepareAllLayers: false,
  renderFullMap: false,
});
assert.doesNotThrow(() => app.persistAgentColorModes({ car: "individual" }));
assert.doesNotThrow(() => app.persistMapRenderOptions({ prepareAllLayers: true }));
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

const configuredBeforeInteractionTest = app.state.configured;
app.state.configured = false;
app.state.viewportInteracting = false;
const interactionTimer = globalThis.setTimeout(() => {}, 60_000);
app.state.pollTimer = interactionTimer;
app.handleViewportInteractionChange(true);
assert.equal(app.state.viewportInteracting, true);
assert.equal(app.state.pollTimer, interactionTimer);
app.handleViewportInteractionChange(false);
assert.equal(app.state.viewportInteracting, false);
assert.equal(app.state.pollTimer, interactionTimer);
globalThis.clearTimeout(interactionTimer);
app.state.pollTimer = null;
app.state.configured = configuredBeforeInteractionTest;

const nativePollSetTimeout = globalThis.setTimeout;
const nativePollClearTimeout = globalThis.clearTimeout;
const nativePollFetch = globalThis.fetch;
const viewportPollTimers = [];
let viewportFetchCount = 0;
try {
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    viewportPollTimers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) {
      timer.cleared = true;
    }
  };
  const gesturePayload = {
    ...firstPayload,
    agents: [{ ...firstPayload.agents[0], lat: 47.4705, speedKph: 42 }],
    stats: { ...firstPayload.stats, elapsedSeconds: 31 },
  };
  globalThis.fetch = async () => {
    viewportFetchCount += 1;
    return {
      ok: true,
      status: 200,
      json: async () => gesturePayload,
    };
  };
  app.state.pollTimer = null;
  app.state.polling = false;
  app.state.controlPending = false;
  app.state.configured = true;
  app.state.viewportInteracting = true;
  app.state.viewportUiDirty = false;
  app.state.pollAgain = false;
  app.state.replayMode = "live";
  app.state.selectedFeature = { type: "agent", agent: firstPayload.agents[0] };
  app.state.replayBuffer = replayModule.createReplayBuffer();
  app.state.replayMetadata.clear();
  const callsBeforeViewportPoll = mapCalls.length;
  const clockBeforeViewportPoll = elements.get("#clock-chip").textContent;
  elements.get("#inspector-details").textContent = "gesture-before";
  await app.pollSimulation();
  assert.equal(viewportFetchCount, 1);
  assert.equal(mapCalls.length, callsBeforeViewportPoll + 1);
  assert.equal(mapCalls.at(-1).agents[0].lat, 47.4705);
  assert.equal(app.state.latestLivePayload.agents[0].lat, 47.4705);
  assert.equal(app.state.selectedFeature.agent.speedKph, 42);
  assert.equal(app.state.replayBuffer.length, 1);
  assert.equal(app.state.viewportUiDirty, true);
  assert.equal(elements.get("#clock-chip").textContent, clockBeforeViewportPoll);
  assert.equal(elements.get("#inspector-details").textContent, "gesture-before");
  assert.equal(app.state.pollAgain, false);
  assert.equal(app.state.polling, false);
  assert.equal(viewportPollTimers.some((timer) => timer.delay === 8_000 && timer.cleared), true);
  assert.equal(viewportPollTimers.some((timer) => timer.delay === 125 && !timer.cleared), true);

  app.handleViewportInteractionChange(false);
  assert.equal(app.state.viewportInteracting, false);
  assert.equal(app.state.viewportUiDirty, false);
  assert.notEqual(elements.get("#clock-chip").textContent, clockBeforeViewportPoll);
  assert.notEqual(elements.get("#inspector-details").textContent, "gesture-before");
} finally {
  globalThis.setTimeout = nativePollSetTimeout;
  globalThis.clearTimeout = nativePollClearTimeout;
  globalThis.fetch = nativePollFetch;
  app.state.pollTimer = null;
  app.state.viewportInteracting = false;
  app.state.viewportUiDirty = false;
  app.state.selectedFeature = null;
  app.state.configured = configuredBeforeInteractionTest;
}

console.log("replay app live/history/background-poll contract: OK");
