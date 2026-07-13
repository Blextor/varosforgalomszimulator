import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const timingSource = await readFile(
  new URL("../src/simulation-timing.js", import.meta.url),
  "utf8",
);
const timingUrl = `data:text/javascript;base64,${Buffer.from(timingSource).toString("base64")}`;
const localMapSource = await readFile(
  new URL("../src/local-map.js", import.meta.url),
  "utf8",
);
const rewrittenLocalMapSource = localMapSource.replace(
  'from "./simulation-timing.js";',
  `from ${JSON.stringify(timingUrl)};`,
);
const localMapModule = await import(
  `data:text/javascript;base64,${Buffer.from(rewrittenLocalMapSource).toString("base64")}`
);

assert.equal(localMapModule.roadLodFraction(2, 0.8), 1);
assert.equal(localMapModule.roadLodFraction(1, 1.1), 0);
assert.ok(Math.abs(localMapModule.roadLodFraction(1, 1.5) - 0.5) < 1e-9);
assert.equal(localMapModule.roadLodFraction(0, 2.4), 0);
assert.equal(localMapModule.roadLodFraction(0, 3.2), 1);
assert.equal(
  localMapModule.roadVisibleAtZoom({ style: { priority: 0 }, lodRank: 0 }, 2.4),
  false,
);
assert.equal(
  localMapModule.roadVisibleAtZoom({ style: { priority: 0 }, lodRank: 0.99 }, 3.2),
  true,
);

assert.deepEqual(
  localMapModule.viewportPreviewTransform(
    { centerX: 0, centerY: 0, scale: 1 },
    { centerX: 10, centerY: 0, scale: 2 },
    100,
    80,
  ),
  { ratio: 2, translateX: -70, translateY: -40 },
);
assert.equal(localMapModule.baseOverscanForViewport(1_000, 760), 380);
assert.equal(localMapModule.baseOverscanForViewport(1_530, 1_080), 512);
assert.equal(localMapModule.baseOverscanForViewport(200, 100), 160);

const viewportMap = Object.create(localMapModule.LocalTrafficMap.prototype);
viewportMap.viewportInteraction = { centerX: 0, centerY: 0, scale: 1 };
viewportMap.centerX = 10;
viewportMap.centerY = 0;
viewportMap.scale = 2;
viewportMap.width = 100;
viewportMap.height = 80;
viewportMap.baseCanvas = { style: {} };
viewportMap.agentCanvas = { style: {} };
viewportMap.baseRenderView = viewportMap.viewportInteraction;
viewportMap.agentRenderView = { centerX: 999, centerY: 999, scale: 99 };
viewportMap.viewportAnimationFrame = null;
let viewportBaseDraws = 0;
let viewportAgentDraws = 0;
viewportMap.drawBase = () => { viewportBaseDraws += 1; };
viewportMap.drawAgents = () => { viewportAgentDraws += 1; };
let viewportWorkerRequests = 0;
viewportMap.staticRenderReady = true;
viewportMap.requestStaticRender = () => { viewportWorkerRequests += 1; return true; };
viewportMap.applyViewportTransform();
assert.equal(viewportMap.baseCanvas.style.transform, "matrix(2, 0, 0, 2, -70, -40)");
assert.equal(viewportMap.agentCanvas.style.transform, viewportMap.baseCanvas.style.transform);

for (const padding of [160, 320, 512]) {
  for (const ratio of [0.8, 1, 2]) {
    const width = 1_000;
    const height = 700;
    const source = { centerX: 1_000, centerY: 500, scale: 0.1 };
    const target = { centerX: 1_050, centerY: 480, scale: source.scale * ratio };
    const world = { x: 1_100, y: 520 };
    const transform = localMapModule.viewportPreviewTransform(source, target, width, height);
    const sourceX = (world.x - source.centerX) * source.scale + width / 2;
    const sourceY = (world.y - source.centerY) * source.scale + height / 2;
    const expectedX = (world.x - target.centerX) * target.scale + width / 2;
    const expectedY = (world.y - target.centerY) * target.scale + height / 2;
    const agentX = sourceX * transform.ratio + transform.translateX;
    const agentY = sourceY * transform.ratio + transform.translateY;
    const baseLocalX = padding + sourceX;
    const baseLocalY = padding + sourceY;
    const baseX = transform.ratio * (baseLocalX - padding) + transform.translateX;
    const baseY = transform.ratio * (baseLocalY - padding) + transform.translateY;
    assert.ok(Math.abs(agentX - expectedX) < 1e-9);
    assert.ok(Math.abs(agentY - expectedY) < 1e-9);
    assert.ok(Math.abs(baseX - expectedX) < 1e-9);
    assert.ok(Math.abs(baseY - expectedY) < 1e-9);
  }
}

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
let viewportCallback = null;
globalThis.requestAnimationFrame = (callback) => {
  viewportCallback = callback;
  return 42;
};
try {
  viewportMap.scheduleViewportDraw();
  assert.equal(viewportMap.viewportAnimationFrame, 42);
  viewportCallback(16);
  assert.equal(viewportBaseDraws, 0);
  assert.equal(viewportAgentDraws, 0);
  assert.equal(viewportWorkerRequests, 0);
} finally {
  if (originalRequestAnimationFrame === undefined) {
    delete globalThis.requestAnimationFrame;
  } else {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
}

const workerMap = Object.create(localMapModule.LocalTrafficMap.prototype);
workerMap.width = 100;
workerMap.height = 80;
workerMap.baseOverscan = 20;
workerMap.basePixelRatio = 1.25;
workerMap.pixelRatio = 1.5;
workerMap.centerX = 5;
workerMap.centerY = 0;
workerMap.scale = 5;
workerMap.zoom = 4;
workerMap.activePoiCategories = new Set();
workerMap.staticRenderReady = true;
workerMap.staticRenderPending = false;
workerMap.staticRenderPendingRequestId = null;
workerMap.staticRenderPendingView = null;
workerMap.staticRenderTimeout = null;
workerMap.staticRenderQueued = false;
workerMap.staticRenderRequestId = 0;
workerMap.staticRenderMetadata = new Map();
const workerMessages = [];
workerMap.staticRenderWorker = {
  postMessage(message) { workerMessages.push(message); },
  terminate() {},
};
assert.equal(workerMap.requestStaticRender(), true);
assert.equal(workerMessages.length, 1);
assert.equal(workerMessages[0].type, "render");
workerMap.centerX = 6;
assert.equal(workerMap.requestStaticRender(), true);
assert.equal(workerMap.staticRenderQueued, true);

let bitmapDraws = 0;
let bitmapCloses = 0;
workerMap.baseCanvas = { width: 175, height: 150, style: {} };
workerMap.agentCanvas = { style: {} };
workerMap.baseContext = {
  setTransform() {},
  clearRect() {},
  drawImage() { bitmapDraws += 1; },
  set globalAlpha(value) {},
};
workerMap.agentRenderView = workerMessages[0].view;
workerMap.viewportInteraction = workerMessages[0].view;
workerMap.dragState = { viewChanged: true };
workerMap.viewportCommitTimer = null;
workerMap.container = { classList: { add() {}, remove() {} } };
workerMap.handleStaticRendererMessage({
  data: {
    type: "rendered",
    requestId: workerMessages[0].requestId,
    view: workerMessages[0].view,
    bitmap: { close() { bitmapCloses += 1; } },
  },
});
assert.equal(bitmapDraws, 0);
assert.equal(bitmapCloses, 1);
assert.equal(workerMap.baseRenderView, undefined);
assert.equal(workerMessages.length, 1);
assert.equal(workerMap.staticRenderPending, false);
assert.equal(workerMap.staticRenderQueued, true);
workerMap.dragState = null;
workerMap.staticRenderQueued = false;
assert.equal(workerMap.requestStaticRender(), true);
assert.equal(workerMessages.length, 2);
assert.equal(workerMessages[1].view.centerX, 6);
const secondRequestId = workerMap.staticRenderPendingRequestId;
const secondRequestTimeout = workerMap.staticRenderTimeout;
const drawsBeforeStaleResponse = bitmapDraws;
const messagesBeforeStaleResponse = workerMessages.length;
let staleBitmapCloses = 0;
workerMap.handleStaticRendererMessage({
  data: {
    type: "rendered",
    requestId: workerMessages[0].requestId,
    view: workerMessages[0].view,
    bitmap: { close() { staleBitmapCloses += 1; } },
  },
});
assert.equal(staleBitmapCloses, 1);
assert.equal(workerMap.staticRenderPending, true);
assert.equal(workerMap.staticRenderPendingRequestId, secondRequestId);
assert.equal(workerMap.staticRenderTimeout, secondRequestTimeout);
assert.equal(bitmapDraws, drawsBeforeStaleResponse);
assert.equal(workerMessages.length, messagesBeforeStaleResponse);
workerMap.disableStaticRenderer();

const deferredWorkerMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(deferredWorkerMap, {
  destroyed: false,
  staticRenderTimeout: null,
  staticRenderReady: false,
  staticRenderQueued: false,
  staticRenderRevision: 0,
  viewportInteraction: { centerX: 0, centerY: 0, scale: 1 },
  viewportCommitTimer: null,
  dragState: { viewChanged: true },
  activePoiCategories: new Set(),
  poiVisibilityCache: null,
});
let deferredWorkerRequests = 0;
let deferredBaseDraws = 0;
deferredWorkerMap.requestStaticRender = () => {
  deferredWorkerRequests += 1;
  return true;
};
deferredWorkerMap.drawBase = () => { deferredBaseDraws += 1; };
deferredWorkerMap.handleStaticRendererMessage({ data: { type: "ready" } });
assert.equal(deferredWorkerMap.staticRenderReady, true);
assert.equal(deferredWorkerMap.staticRenderQueued, true);
assert.equal(deferredWorkerRequests, 0);
deferredWorkerMap.setPoiCategories(["parking"]);
assert.deepEqual([...deferredWorkerMap.activePoiCategories], ["parking"]);
assert.equal(deferredWorkerMap.staticRenderRevision, 1);
assert.equal(deferredWorkerRequests, 0);
assert.equal(deferredBaseDraws, 0);

const timeoutMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(timeoutMap, {
  width: 100,
  height: 80,
  baseOverscan: 20,
  basePixelRatio: 1.25,
  centerX: 5,
  centerY: 0,
  scale: 5,
  zoom: 4,
  activePoiCategories: new Set(),
  staticRenderReady: true,
  staticRenderPending: false,
  staticRenderPendingRequestId: null,
  staticRenderPendingView: null,
  staticRenderPendingRevision: null,
  staticRenderTimeout: null,
  staticRenderQueued: false,
  staticRenderRevision: 0,
  staticRenderRequestId: 0,
  staticRenderMetadata: new Map(),
  destroyed: false,
  viewportInteraction: { centerX: 5, centerY: 0, scale: 5 },
  dragState: { viewChanged: true },
});
let timeoutWorkerTerminations = 0;
let timeoutFallbackCommits = 0;
let timeoutPreviewUpdates = 0;
timeoutMap.staticRenderWorker = {
  postMessage() {},
  terminate() { timeoutWorkerTerminations += 1; },
};
timeoutMap.finishViewportInteraction = () => { timeoutFallbackCommits += 1; };
timeoutMap.applyViewportTransform = () => { timeoutPreviewUpdates += 1; };
timeoutMap.drawBase = () => assert.fail("interactive timeout must use the commit fallback");
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timeoutHandle = { type: "static-render-timeout" };
let scheduledTimeoutCallback = null;
let scheduledTimeoutDelay = null;
let clearedTimeoutHandle = null;
globalThis.setTimeout = (callback, delay) => {
  scheduledTimeoutCallback = callback;
  scheduledTimeoutDelay = delay;
  return timeoutHandle;
};
globalThis.clearTimeout = (handle) => { clearedTimeoutHandle = handle; };
try {
  assert.equal(timeoutMap.requestStaticRender(), true);
  const timedOutRequestId = timeoutMap.staticRenderPendingRequestId;
  assert.equal(typeof scheduledTimeoutCallback, "function");
  assert.equal(scheduledTimeoutDelay, 2_500);
  timeoutMap.handleStaticRenderTimeout(timedOutRequestId + 1);
  assert.equal(timeoutWorkerTerminations, 0);
  scheduledTimeoutCallback();
  assert.equal(clearedTimeoutHandle, timeoutHandle);
  assert.equal(timeoutWorkerTerminations, 1);
  assert.equal(timeoutFallbackCommits, 0);
  assert.equal(timeoutPreviewUpdates, 1);
  assert.equal(timeoutMap.staticRenderReady, false);
  timeoutMap.dragState = null;
  timeoutMap.finishViewportInteraction();
  assert.equal(timeoutFallbackCommits, 1);
  let lateBitmapCloses = 0;
  timeoutMap.handleStaticRendererMessage({
    data: {
      type: "rendered",
      requestId: timedOutRequestId,
      view: workerMessages[0].view,
      bitmap: { close() { lateBitmapCloses += 1; } },
    },
  });
  assert.equal(lateBitmapCloses, 1);
  timeoutMap.handleStaticRendererMessage({
    data: { type: "error", requestId: timedOutRequestId },
  });
  assert.equal(timeoutWorkerTerminations, 1);
  assert.equal(timeoutFallbackCommits, 1);
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

const fallbackMap = Object.create(localMapModule.LocalTrafficMap.prototype);
const fallbackView = {
  width: 100,
  height: 80,
  padding: 20,
  pixelRatio: 1,
  centerX: 5,
  centerY: 0,
  scale: 5,
  zoom: 4,
};
Object.assign(fallbackMap, {
  destroyed: false,
  width: 100,
  height: 80,
  centerX: 6,
  centerY: 0,
  scale: 5,
  zoom: 4,
  viewportInteraction: { centerX: 5, centerY: 0, scale: 5 },
  viewportCommitTimer: null,
  viewportAnimationFrame: null,
  dragState: { viewChanged: true },
  staticRenderWorker: { terminate() {} },
  staticRenderReady: true,
  staticRenderPending: true,
  staticRenderPendingRequestId: 1,
  staticRenderPendingView: fallbackView,
  staticRenderPendingRevision: 0,
  staticRenderTimeout: null,
  staticRenderQueued: false,
  staticRenderMetadata: new Map([[1, {}]]),
  baseRenderView: fallbackView,
  agentRenderView: fallbackView,
  baseCanvas: { style: {} },
  agentCanvas: { style: {} },
  container: { classList: { add() {}, remove() {} } },
  agents: [],
  previousAgents: new Map(),
  agentAnimationActive: false,
  selectedRouteIndex: 0,
  previousSelectedRouteIndex: 0,
  interpolationResetAgentIds: new Set(),
});
let fallbackBaseDraws = 0;
let fallbackAgentDraws = 0;
fallbackMap.drawBase = () => {
  fallbackBaseDraws += 1;
  fallbackMap.baseRenderView = fallbackMap.staticViewSnapshot();
};
fallbackMap.drawAgents = () => {
  fallbackAgentDraws += 1;
  fallbackMap.agentRenderView = fallbackMap.staticViewSnapshot();
};
fallbackMap.fallbackFromStaticRendererFailure();
assert.equal(fallbackBaseDraws, 0);
assert.equal(fallbackAgentDraws, 0);
assert.ok(fallbackMap.viewportInteraction);
fallbackMap.dragState = null;
fallbackMap.finishViewportInteraction();
assert.equal(fallbackBaseDraws, 1);
assert.equal(fallbackAgentDraws, 1);
assert.equal(fallbackMap.viewportInteraction, null);
assert.equal(fallbackMap.baseCanvas.style.transform, "none");
assert.equal(fallbackMap.agentCanvas.style.transform, "none");

const gestureMap = Object.create(localMapModule.LocalTrafficMap.prototype);
const gestureTarget = {
  id: 1,
  mode: "car",
  lat: 47.001,
  lng: 19.001,
  heading: 20,
  waiting: false,
};
gestureMap.agents = [gestureTarget];
gestureMap.previousAgents = new Map([[gestureTarget.id, {
  ...gestureTarget,
  lat: 47,
  lng: 19,
}]]);
gestureMap.agentAnimationActive = true;
gestureMap.animationFrame = null;
gestureMap.viewportCommitTimer = null;
gestureMap.viewportInteraction = null;
gestureMap.centerX = 10;
gestureMap.centerY = 20;
gestureMap.scale = 3;
gestureMap.container = { classList: { add() {}, remove() {} } };
gestureMap.beginViewportInteraction();
assert.equal(gestureMap.agents[0], gestureTarget);
assert.equal(gestureMap.agents[0].lat, 47.001);

const commitMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(commitMap, {
  width: 100,
  height: 80,
  baseOverscan: 20,
  basePixelRatio: 1.25,
  pixelRatio: 1.5,
  centerX: 6,
  centerY: 0,
  scale: 5,
  zoom: 4,
  viewportInteraction: { centerX: 5, centerY: 0, scale: 5 },
  viewportCommitTimer: null,
  viewportAnimationFrame: null,
  dragState: null,
  animationFrame: null,
  agents: [],
  previousAgents: new Map(),
  selectedRouteIndex: 2,
  previousSelectedRouteIndex: 1,
  interpolationResetAgentIds: new Set(),
  activePoiCategories: new Set(),
  staticRenderReady: true,
  staticRenderPending: false,
  staticRenderPendingRequestId: null,
  staticRenderPendingView: null,
  staticRenderPendingRevision: null,
  staticRenderTimeout: null,
  staticRenderQueued: false,
  staticRenderRevision: 0,
  staticRenderRequestId: 0,
  staticRenderMetadata: new Map(),
  destroyed: false,
  baseRenderView: {
    width: 100,
    height: 80,
    padding: 20,
    pixelRatio: 1.25,
    centerX: 5,
    centerY: 0,
    scale: 5,
    zoom: 4,
  },
});
commitMap.agentRenderView = commitMap.baseRenderView;
commitMap.baseCanvas = { width: 175, height: 150, style: {} };
commitMap.agentCanvas = { style: {} };
commitMap.baseContext = workerMap.baseContext;
commitMap.container = { classList: { add() {}, remove() {} } };
const commitMessages = [];
commitMap.staticRenderWorker = {
  postMessage(message) { commitMessages.push(message); },
};
let commitAgentDraws = 0;
let commitBaseDraws = 0;
commitMap.drawAgents = () => {
  commitAgentDraws += 1;
  commitMap.agentRenderView = commitMap.staticViewSnapshot();
};
commitMap.drawBase = () => { commitBaseDraws += 1; };
const bitmapDrawsBeforeCommit = bitmapDraws;
commitMap.finishViewportInteraction();
assert.equal(commitAgentDraws, 0);
assert.equal(commitBaseDraws, 0);
assert.equal(commitMap.previousSelectedRouteIndex, 1);
assert.ok(commitMap.viewportInteraction);
assert.equal(commitMessages.length, 1);
commitMap.handleStaticRendererMessage({
  data: {
    type: "rendered",
    requestId: commitMessages[0].requestId,
    view: commitMessages[0].view,
    bitmap: { close() {} },
  },
});
assert.equal(commitMap.viewportInteraction, null);
assert.equal(commitMap.baseCanvas.style.transform, "none");
assert.equal(commitMap.agentCanvas.style.transform, "none");
assert.equal(commitAgentDraws, 1);
assert.equal(commitMap.previousSelectedRouteIndex, 2);
assert.equal(commitBaseDraws, 0);
assert.equal(bitmapDraws, bitmapDrawsBeforeCommit + 1);

const wheelMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(wheelMap, {
  viewportCommitTimer: null,
  viewportInteraction: null,
  animationFrame: null,
  agentAnimationActive: false,
  centerX: 0,
  centerY: 0,
  fitScale: 2,
  scale: 2,
  zoom: 1,
  width: 200,
  height: 100,
  containerLeft: 0,
  containerTop: 0,
  container: {
    getBoundingClientRect: () => ({ left: 100, top: 50 }),
    classList: { add() {}, remove() {} },
  },
});
let wheelAnchor = null;
wheelMap.screenToWorld = (x, y) => {
  wheelAnchor = { x, y };
  return { x: 10, y: 20 };
};
wheelMap.scheduleViewportDraw = () => {};
wheelMap.scheduleViewportCommit = () => {};
wheelMap.handleWheel({
  preventDefault() {},
  clientX: 150,
  clientY: 90,
  deltaY: 0,
});
assert.deepEqual(wheelAnchor, { x: 50, y: 40 });
assert.equal(wheelMap.containerLeft, 100);
assert.equal(wheelMap.containerTop, 50);

const schedulerMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(schedulerMap, {
  agents: new Array(5_000),
  agentColorModes: { car: "individual", pedestrian: "individual" },
  viewportInteraction: null,
  animationFrame: null,
  agentAnimationActive: true,
  transitionStarted: 0,
  agentTransitionDurationMs: 176,
  lastAgentDrawAt: Number.NEGATIVE_INFINITY,
});
const scheduledAgentDraws = [];
let queuedAgentFrame = null;
let nextAgentFrameId = 0;
const schedulerRequestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (callback) => {
  queuedAgentFrame = callback;
  nextAgentFrameId += 1;
  return nextAgentFrameId;
};
schedulerMap.drawAgents = (timestamp) => {
  scheduledAgentDraws.push(timestamp);
  schedulerMap.lastAgentDrawAt = timestamp;
};
try {
  schedulerMap.scheduleAgentDraw();
  for (let frame = 0; frame < 20 && queuedAgentFrame; frame += 1) {
    const callback = queuedAgentFrame;
    queuedAgentFrame = null;
    callback(frame * (1_000 / 60));
  }
  assert.equal(scheduledAgentDraws.length, 7);
  for (let index = 1; index < scheduledAgentDraws.length - 1; index += 1) {
    assert.ok(scheduledAgentDraws[index] - scheduledAgentDraws[index - 1] <= 34);
  }
  assert.ok(scheduledAgentDraws.at(-1) >= 176);
  assert.equal(schedulerMap.agentAnimationActive, false);
  assert.equal(schedulerMap.animationFrame, null);

  schedulerMap.viewportInteraction = { centerX: 0, centerY: 0, scale: 1 };
  schedulerMap.scheduleAgentDraw();
  assert.equal(queuedAgentFrame, null);
} finally {
  if (schedulerRequestAnimationFrame === undefined) {
    delete globalThis.requestAnimationFrame;
  } else {
    globalThis.requestAnimationFrame = schedulerRequestAnimationFrame;
  }
}

const map = Object.create(localMapModule.LocalTrafficMap.prototype);
const previous = {
  id: 1,
  mode: "car",
  lat: 47,
  lng: 19,
  heading: 350,
  waiting: false,
};
const current = {
  ...previous,
  lat: 47.0002,
  lng: 19.0002,
  heading: 10,
};
map.agents = [current];
map.previousAgents = new Map([[1, previous]]);
map.interpolationResetAgentIds = new Set();
map.transitionStarted = 0;
map.agentTransitionDurationMs = 100;

const captured = map.captureInterpolatedAgents(50);
assert.equal(captured.get(1).lat, 47.0001);
assert.equal(captured.get(1).lng, 19.0001);
assert.equal(captured.get(1).heading, 0);

map.previousAgents = captured;
map.coordinateToWorld = (latitude, longitude) => ({ x: longitude, y: latitude });
map.worldToScreen = (world) => ({ ...world });
const next = {
  ...current,
  lat: 47.0004,
  lng: 19.0004,
  heading: 30,
};
const nextStart = map.interpolatedAgentScreen(next, 0);
assert.equal(nextStart.x, captured.get(1).lng);
assert.equal(nextStart.y, captured.get(1).lat);
assert.equal(nextStart.heading, captured.get(1).heading);

const renderMap = Object.create(localMapModule.LocalTrafficMap.prototype);
renderMap.agentContext = {
  setTransform() {},
  clearRect() {},
};
renderMap.pixelRatio = 1;
renderMap.width = 1_000;
renderMap.height = 800;
renderMap.zoom = 7;
renderMap.bounds = { west: 18.9, north: 47.1 };
renderMap.metersPerLongitudeDegree = 75_000;
renderMap.centerX = 7_500;
renderMap.centerY = 11_132;
renderMap.scale = 0.1;
renderMap.agents = [current];
renderMap.previousAgents = new Map([[current.id, current]]);
renderMap.interpolationResetAgentIds = new Set();
renderMap.transitionStarted = 0;
renderMap.agentTransitionDurationMs = 100;
renderMap.selectedAgentId = null;
renderMap.renderedAgents = [];
renderMap.agentRenderCache = new Map();
let batchedRenderCalls = 0;
renderMap.drawOverviewAgents = () => { batchedRenderCalls += 1; };
renderMap.drawAgents(100);
const cachedRenderEntry = renderMap.renderedAgents[0];
const cachedScreen = cachedRenderEntry.screen;
renderMap.drawAgents(100);
assert.equal(renderMap.renderedAgents[0], cachedRenderEntry);
assert.equal(renderMap.renderedAgents[0].screen, cachedScreen);
assert.equal(renderMap.agentRenderCache.size, 1);
assert.equal(batchedRenderCalls, 2);

const lifecycleMap = Object.create(localMapModule.LocalTrafficMap.prototype);
lifecycleMap.agents = [previous];
lifecycleMap.previousAgents = new Map([[1, previous]]);
lifecycleMap.interpolationResetAgentIds = new Set();
lifecycleMap.transitionStarted = 0;
lifecycleMap.lastAgentSnapshotAt = 100;
lifecycleMap.agentFrameIntervalMs = 160;
lifecycleMap.agentTransitionDurationMs = 176;
lifecycleMap.agentAnimationActive = true;
lifecycleMap.animationFrame = null;
let scheduledDraws = 0;
lifecycleMap.scheduleAgentDraw = () => { scheduledDraws += 1; };
lifecycleMap.setAgents([current], { animate: false, resetTiming: true });
assert.equal(lifecycleMap.previousAgents.size, 0);
assert.equal(lifecycleMap.lastAgentSnapshotAt, null);
assert.equal(lifecycleMap.agentFrameIntervalMs, 125);
assert.equal(lifecycleMap.agentAnimationActive, false);
assert.equal(scheduledDraws, 1);

lifecycleMap.setAgents([{ ...current }], { animate: false });
assert.equal(scheduledDraws, 1);
lifecycleMap.agentAnimationActive = false;
lifecycleMap.setAgents([{ ...current }], { animate: true, observeInterval: false });
assert.equal(lifecycleMap.agentAnimationActive, false);
assert.equal(scheduledDraws, 1);

const replayMap = Object.create(localMapModule.LocalTrafficMap.prototype);
replayMap.agents = [previous];
replayMap.previousAgents = new Map([[1, previous]]);
replayMap.interpolationResetAgentIds = new Set();
replayMap.transitionStarted = 0;
replayMap.lastAgentSnapshotAt = null;
replayMap.agentFrameIntervalMs = 160;
replayMap.agentTransitionDurationMs = 176;
replayMap.agentAnimationActive = false;
replayMap.animationFrame = null;
replayMap.scheduleAgentDraw = () => {};
const nativePerformanceDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "performance",
);
let replayNow = 1_000;
Object.defineProperty(globalThis, "performance", {
  configurable: true,
  value: { now: () => replayNow },
});
try {
  replayMap.setAgents([current], {
    animate: true,
    observeInterval: false,
    transitionDurationMs: 12_000,
  });
  assert.equal(replayMap.agentTransitionDurationMs, 12_000);
  replayNow += 6_000;
  const frozenAgents = replayMap.freezeAgentTransition(replayNow);
  assert.equal(frozenAgents[0].lat, 47.0001);
  assert.equal(frozenAgents[0].lng, 19.0001);
  assert.equal(frozenAgents[0].heading, 0);
  assert.equal(replayMap.agentAnimationActive, false);

  replayMap.setAgents([current], {
    animate: true,
    observeInterval: false,
    transitionDurationMs: 6_000,
  });
  assert.equal(replayMap.agentTransitionDurationMs, 6_000);
  assert.equal(replayMap.previousAgents.get(1).lat, 47.0001);
  replayNow += 3_000;
  const resumedMidpoint = replayMap.captureInterpolatedAgents(replayNow).get(1);
  assert.ok(Math.abs(resumedMidpoint.lat - 47.00015) < 1e-10);
  assert.ok(Math.abs(resumedMidpoint.lng - 19.00015) < 1e-10);
  assert.equal(resumedMidpoint.heading, 5);

  replayMap.setAgents([next], { animate: true, observeInterval: false });
  assert.equal(replayMap.agentTransitionDurationMs, 136);
  assert.ok(replayMap.agentTransitionDurationMs <= 330);
} finally {
  Object.defineProperty(globalThis, "performance", nativePerformanceDescriptor);
}

const relocatedOne = { ...current, id: 1, relocated: true };
const relocatedTwo = { ...current, id: 2, relocated: true };
lifecycleMap.agents = [previous, { ...previous, id: 2 }];
lifecycleMap.previousAgents = new Map(lifecycleMap.agents.map((agent) => [agent.id, agent]));
lifecycleMap.setAgents([relocatedOne, relocatedTwo], { animate: true });
assert.equal(lifecycleMap.previousAgents.size, 0);
assert.deepEqual([...lifecycleMap.interpolationResetAgentIds].sort(), ["1", "2"]);

let arcCount = 0;
let fillCount = 0;
let strokeCount = 0;
let selectedDrawCount = 0;
let currentPolygon = null;
const carPolygons = [];
const lineWidths = [];
const context = {
  save() {},
  restore() {},
  beginPath() {},
  moveTo(x, y) { currentPolygon = [{ x, y }]; },
  lineTo(x, y) { currentPolygon.push({ x, y }); },
  closePath() { carPolygons.push(currentPolygon); },
  arc() { arcCount += 1; },
  fill() { fillCount += 1; },
  stroke() { strokeCount += 1; },
  set globalAlpha(value) { this._globalAlpha = value; },
  set fillStyle(value) { this._fillStyle = value; },
  set strokeStyle(value) { this._strokeStyle = value; },
  set lineWidth(value) { lineWidths.push(value); },
};
map.zoom = 1.5;
map.agentColorModes = { car: "uniform", pedestrian: "uniform" };
map.selectedAgentId = "4";
map.renderedAgents = [
  { agent: { id: 1, mode: "car", waiting: false }, screen: { x: 1, y: 1, heading: 0 } },
  { agent: { id: 2, mode: "car", waiting: true }, screen: { x: 2, y: 2, heading: 90 } },
  { agent: { id: 3, mode: "pedestrian", waiting: false }, screen: { x: 3, y: 3 } },
  { agent: { id: 4, mode: "pedestrian", waiting: true }, screen: { x: 4, y: 4 } },
];
map.drawAgent = () => { selectedDrawCount += 1; };
map.drawOverviewAgents(context);
assert.equal(carPolygons.length, 3);
const polygonExtent = (polygon, key) => (
  Math.max(...polygon.map((point) => point[key]))
  - Math.min(...polygon.map((point) => point[key]))
);
const overviewMetrics = localMapModule.agentVisualMetrics(map.zoom);
assert.ok(Math.abs(polygonExtent(carPolygons[0], "x") - overviewMetrics.carWidth) < 1e-10);
assert.ok(Math.abs(polygonExtent(carPolygons[0], "y") - overviewMetrics.carLength) < 1e-10);
assert.ok(Math.abs(polygonExtent(carPolygons[1], "x") - overviewMetrics.carLength) < 1e-10);
assert.ok(Math.abs(polygonExtent(carPolygons[1], "y") - overviewMetrics.carWidth) < 1e-10);
assert.equal(arcCount, 1);
assert.equal(fillCount, 3);
assert.equal(strokeCount, 2);
assert.deepEqual(lineWidths, [
  overviewMetrics.outlineWidth * 2,
  overviewMetrics.outlineWidth * 2,
]);
assert.equal(selectedDrawCount, 1);

const appearanceMap = Object.create(localMapModule.LocalTrafficMap.prototype);
appearanceMap.agentColorModes = { car: "uniform", pedestrian: "uniform" };
let appearanceDraws = 0;
appearanceMap.scheduleAgentDraw = () => { appearanceDraws += 1; };
assert.equal(appearanceMap.setAgentColorModes({ car: "uniform" }), false);
assert.equal(appearanceDraws, 0);
assert.equal(appearanceMap.setAgentColorModes({ car: "individual" }), true);
assert.deepEqual(appearanceMap.agentColorModes, {
  car: "individual",
  pedestrian: "uniform",
});
assert.equal(appearanceDraws, 1);
assert.equal(appearanceMap.setAgentColorModes({ pedestrian: "individual" }), true);
assert.deepEqual(appearanceMap.agentColorModes, {
  car: "individual",
  pedestrian: "individual",
});
assert.equal(appearanceDraws, 2);

const routeMap = Object.create(localMapModule.LocalTrafficMap.prototype);
routeMap.selectedRouteWorldNodes = Array.from({ length: 10 }, (_, index) => ({
  x: index,
  y: index,
}));
routeMap.previousSelectedRouteIndex = 4;
routeMap.selectedRouteIndex = 7;
routeMap.selectedRouteMode = "car";
routeMap.zoom = 1;
routeMap.worldToScreen = (world) => ({ ...world });
const routeLineStarts = [];
const routeContext = {
  save() {},
  restore() {},
  beginPath() {},
  moveTo() {},
  lineTo(x) { routeLineStarts.push(x); },
  setLineDash() {},
  stroke() {},
};
routeMap.drawSelectedRoute(routeContext, { x: -1, y: -1 }, 0.5);
assert.equal(routeLineStarts[0], 5);
routeLineStarts.length = 0;
routeMap.drawSelectedRoute(routeContext, { x: -1, y: -1 }, 1);
assert.equal(routeLineStarts[0], 8);

const panMap = Object.create(localMapModule.LocalTrafficMap.prototype);
panMap.segments = [
  { from: 1, to: 2, highway: "primary", modes: ["car"], totalLanes: 2 },
  { from: 2, to: 3, highway: "footway", modes: ["pedestrian"], totalLanes: 1 },
  { from: 4, to: 5, highway: "primary", modes: ["car"], totalLanes: 2 },
];
panMap.nodeWorld = new Map([
  [1, { x: 0, y: 0 }],
  [2, { x: 10, y: 0 }],
  [3, { x: 20, y: 0 }],
  [4, { x: 1_000, y: 0 }],
  [5, { x: 1_010, y: 0 }],
]);
panMap.segmentEntries = [];
panMap.segmentGrid = new Map();
panMap.gridCellSize = 250;
panMap.buildSpatialIndex();
assert.equal(panMap.segmentEntries[0].mode, "car");
assert.equal(panMap.segmentEntries[0].supportsCars, true);
assert.equal(panMap.segmentEntries[0].totalLanes, 2);
assert.equal(panMap.segmentEntries[1].mode, "pedestrian");

panMap.width = 100;
panMap.height = 100;
panMap.scale = 1;
panMap.centerX = 10;
panMap.centerY = 0;
panMap.zoom = 3;
assert.equal(panMap.visibleSegmentEntries().length, 3);
panMap.zoom = 3.01;
assert.equal(panMap.visibleSegmentEntries().length, 2);

const originalPath2D = globalThis.Path2D;
const createdRoadPaths = [];
globalThis.Path2D = class RecordingPath2D {
  constructor() {
    this.commands = [];
    createdRoadPaths.push(this);
  }

  moveTo(x, y) { this.commands.push(["moveTo", x, y]); }

  lineTo(x, y) { this.commands.push(["lineTo", x, y]); }
};
try {
  panMap.zoom = 3.3;
  const strokedPaths = [];
  const lineDashes = [];
  const panContext = {
    setLineDash(value) { lineDashes.push(value); },
    stroke(path) { strokedPaths.push(path); },
    set strokeStyle(value) { this._strokeStyle = value; },
    set globalAlpha(value) { this._globalAlpha = value; },
    set lineWidth(value) { this._lineWidth = value; },
    set lineCap(value) { this._lineCap = value; },
  };
  panMap.drawOverview(panContext);
  assert.equal(strokedPaths.length, 2);
  assert.equal(
    strokedPaths.reduce((total, path) => total + path.commands.length, 0),
    4,
  );
  assert.equal(createdRoadPaths.length, 2);
  assert.ok(lineDashes.every((dash) => dash.length === 0));
} finally {
  if (originalPath2D === undefined) {
    delete globalThis.Path2D;
  } else {
    globalThis.Path2D = originalPath2D;
  }
}

console.log("local map continuous interpolation/batched overview contract: OK");
