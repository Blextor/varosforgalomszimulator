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
assert.equal(localMapModule.agentPixelRatioForLoad(1.5, 2_999, {
  car: "individual",
  pedestrian: "individual",
}), 1.5);
assert.equal(localMapModule.agentPixelRatioForLoad(1.5, 3_000, {
  car: "individual",
  pedestrian: "uniform",
}), 1);
assert.equal(localMapModule.agentPixelRatioForLoad(2, 5_000, {
  car: "uniform",
  pedestrian: "uniform",
}), 1.5);
assert.equal(localMapModule.agentPixelRatioForLoad(1.5, 2_999, {
  car: "individual",
  pedestrian: "uniform",
}, 1), 1);
assert.equal(localMapModule.agentPixelRatioForLoad(1.5, 2_499, {
  car: "individual",
  pedestrian: "uniform",
}, 1), 1.5);

assert.deepEqual(localMapModule.normalizeStaticRenderOptions({
  prepareAllLayers: true,
  renderFullMap: 1,
}), {
  prepareAllLayers: true,
  renderFullMap: false,
});
assert.equal(localMapModule.staticRenderProfileForZoom(0.81).zoom, 0.8);
assert.equal(localMapModule.staticRenderProfileForZoom(6.8).zoom, 3.5);
assert.equal(localMapModule.staticRenderProfileForZoom(7).zoom, 7);
assert.equal(localMapModule.staticRenderProfileForZoom(40).zoom, 40);
assert.equal(localMapModule.trafficLoadColor(0), "hsl(120.0 78% 48%)");
assert.equal(localMapModule.trafficLoadColor(50), "hsl(60.0 78% 48%)");
assert.equal(localMapModule.trafficLoadColor(100), "hsl(0.0 78% 48%)");

const compactFullMapPlan = localMapModule.boundedFullMapTilePlan(
  7_346.7,
  6_805.1,
  0.1,
  { maxTiles: 48 },
);
assert.equal(compactFullMapPlan.limited, false);
assert.ok(compactFullMapPlan.tileCount <= 48);
assert.ok(compactFullMapPlan.firstColumn < 0);
assert.ok(compactFullMapPlan.firstRow < 0);
const boundedFullMapPlan = localMapModule.boundedFullMapTilePlan(
  7_346.7,
  6_805.1,
  4,
  { maxTiles: 48 },
);
assert.equal(boundedFullMapPlan.limited, true);
assert.ok(boundedFullMapPlan.scale < 4);
assert.ok(boundedFullMapPlan.tileCount <= 48);

const staticModeStatuses = [];
const staticModeMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(staticModeMap, {
  staticRenderOptions: { prepareAllLayers: false, renderFullMap: false },
  staticTileGeneration: 0,
  staticTileCache: new Map(),
  staticTileCacheBytes: 0,
  staticTileQueue: [],
  staticTileQueuedKeys: new Set(),
  staticTilePlanKeys: new Set(),
  staticTileCompletedKeys: new Set(),
  staticTileDetailLevels: new Map(),
  staticTileFullLevels: new Map(),
  staticFullMapLayer: { style: {}, replaceChildren() {}, hidden: false },
  staticTileLayer: { style: {}, replaceChildren() {}, hidden: false },
  viewportLayer: { style: {} },
  agentCanvas: { style: {} },
  onStaticPreparationChange(status) { staticModeStatuses.push(status); },
});
assert.deepEqual(staticModeMap.setStaticRenderOptions({ prepareAllLayers: true }), {
  prepareAllLayers: true,
  renderFullMap: false,
});
assert.equal(staticModeMap.staticTileFailed, true);
assert.equal(staticModeStatuses.at(-1).phase, "fallback");
staticModeMap.setStaticRenderOptions({});
assert.equal(staticModeStatuses.at(-1).phase, "idle");
assert.equal(staticModeMap.staticFullMapLayer.hidden, true);
assert.equal(staticModeMap.staticTileLayer.hidden, true);

const staleTileMap = Object.create(localMapModule.LocalTrafficMap.prototype);
let staleTilePumps = 0;
Object.assign(staleTileMap, {
  destroyed: false,
  staticTileGeneration: 2,
  staticTileTimeout: { type: "old-generation-timeout" },
  staticTilePending: {
    requestId: 7,
    job: { generation: 1 },
  },
  pumpStaticTileQueue() { staleTilePumps += 1; },
});
staleTileMap.handleStaticTileTimeout(7);
assert.equal(staleTileMap.staticTilePending, null);
assert.equal(staleTileMap.staticTileFailed, undefined);
assert.equal(staleTilePumps, 1);

const boundedQueueMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(boundedQueueMap, {
  staticTileGeneration: 1,
  staticTilePlanKeys: new Set(),
  staticTileCompletedKeys: new Set(),
  staticTileQueuedKeys: new Set(),
  staticTileQueue: [],
  staticTileCache: new Map(),
  staticTileCacheBytes: 0,
  staticTilePending: null,
  staticTilePlanLimited: false,
});
let acceptedTileJobs = 0;
for (let index = 0; index < 300; index += 1) {
  acceptedTileJobs += Number(boundedQueueMap.queueStaticTileJob({
    key: `tile-${index}`,
    generation: 1,
    priority: 0,
  }, { pump: false }));
}
assert.ok(acceptedTileJobs < 300);
assert.equal(boundedQueueMap.staticTilePlanKeys.size, acceptedTileJobs);
assert.equal(boundedQueueMap.staticTileQueue.length, acceptedTileJobs);
assert.equal(boundedQueueMap.staticTilePlanLimited, true);

const clippedSlotMap = Object.create(localMapModule.LocalTrafficMap.prototype);
clippedSlotMap.worldWidth = 7_346.7;
clippedSlotMap.worldHeight = 6_805.1;
const clippedSlot = { style: {} };
const clippedCanvas = { style: {} };
const clippedEntry = {
  job: { column: -1, row: -1 },
  slot: clippedSlot,
  canvas: clippedCanvas,
};
assert.equal(clippedSlotMap.configureStaticTileSlot(clippedEntry, {
  kind: "full",
  scale: 0.1,
}), true);
assert.equal(clippedSlot.style.left, "-28px");
assert.equal(clippedSlot.style.top, "-28px");
assert.equal(clippedSlot.style.width, "28px");
assert.equal(clippedSlot.style.height, "28px");

let tileFallbackDraws = 0;
let tileBitmapCloses = 0;
const tileCanvases = [];
const tileFallbackDocument = {
  createElement(type) {
    if (type === "canvas") {
      const canvas = {
        style: {},
        getContext(kind) {
          if (canvas === tileCanvases[0] && kind === "bitmaprenderer") {
            return { transferFromImageBitmap() { throw new Error("lost bitmap presenter"); } };
          }
          if (canvas === tileCanvases[1] && kind === "2d") {
            return { drawImage() { tileFallbackDraws += 1; } };
          }
          return null;
        },
      };
      tileCanvases.push(canvas);
      return canvas;
    }
    return { style: {}, append(child) { this.child = child; } };
  },
};
const tileFallbackMap = Object.create(localMapModule.LocalTrafficMap.prototype);
tileFallbackMap.container = { ownerDocument: tileFallbackDocument };
const tileFallbackEntry = tileFallbackMap.createStaticTileEntry({
  key: "fallback-tile",
  column: 0,
  row: 0,
}, {
  width: 608,
  height: 608,
  close() { tileBitmapCloses += 1; },
});
assert.equal(tileCanvases.length, 2);
assert.equal(tileFallbackEntry.canvas, tileCanvases[1]);
assert.equal(tileCanvases[0].width, 0);
assert.equal(tileFallbackDraws, 1);
assert.equal(tileBitmapCloses, 1);

const largeViewportPlanMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(largeViewportPlanMap, {
  staticRenderOptions: { prepareAllLayers: true, renderFullMap: true },
  staticTileReady: true,
  staticTileWorker: {},
  staticTileGeneration: 1,
  staticRenderRevision: 0,
  staticTileCache: new Map(),
  staticTileCacheBytes: 0,
  staticTileQueue: [],
  staticTileQueuedKeys: new Set(),
  staticTilePlanKeys: new Set(),
  staticTileCompletedKeys: new Set(),
  staticTileDetailLevels: new Map(),
  staticTileFullLevels: new Map(),
  staticTilePending: null,
  staticTilePlanLimited: false,
  zoom: 40,
  fitScale: 0.1,
  scale: 4,
  width: 3_840,
  height: 2_160,
  centerX: 7_346.7 / 2,
  centerY: 6_805.1 / 2,
  worldWidth: 7_346.7,
  worldHeight: 6_805.1,
  updateStaticTilePresentation() {},
  notifyStaticPreparation() {},
  pumpStaticTileQueue() {},
});
assert.equal(largeViewportPlanMap.rebuildStaticTilePreparation(), true);
assert.equal(
  largeViewportPlanMap.staticTileFullLevels.size,
  localMapModule.STATIC_RENDER_PROFILES.length,
);
assert.ok(largeViewportPlanMap.staticTilePlanKeys.size < 200);
const activeFullLevel = largeViewportPlanMap.staticTileFullLevels.get("z40");
for (const job of largeViewportPlanMap.staticTileJobsForRange(
  activeFullLevel,
  activeFullLevel.range,
  5,
)) {
  assert.equal(largeViewportPlanMap.staticTilePlanKeys.has(job.key), true);
}

const originalWindow = globalThis.window;
globalThis.window = { devicePixelRatio: 1 };
try {
  const resizeGuardMap = Object.create(localMapModule.LocalTrafficMap.prototype);
  Object.assign(resizeGuardMap, {
    width: 100,
    height: 80,
    devicePixelRatio: 1,
    viewportInteraction: null,
    container: {
      getBoundingClientRect: () => ({ width: 100, height: 80, left: 12, top: 34 }),
    },
  });
  resizeGuardMap.drawBase = () => assert.fail("unchanged resize must not redraw base");
  resizeGuardMap.drawAgents = () => assert.fail("unchanged resize must not redraw agents");
  resizeGuardMap.resize(false);
  assert.equal(resizeGuardMap.containerLeft, 12);
  assert.equal(resizeGuardMap.containerTop, 34);
} finally {
  if (originalWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = originalWindow;
  }
}

const viewportMap = Object.create(localMapModule.LocalTrafficMap.prototype);
viewportMap.viewportInteraction = { centerX: 0, centerY: 0, scale: 1 };
viewportMap.centerX = 10;
viewportMap.centerY = 0;
viewportMap.scale = 2;
viewportMap.width = 100;
viewportMap.height = 80;
viewportMap.baseCanvas = { style: {} };
viewportMap.agentCanvas = { style: {} };
viewportMap.viewportLayer = { style: {} };
viewportMap.baseRenderView = viewportMap.viewportInteraction;
viewportMap.agentRenderView = { centerX: 4, centerY: 2, scale: 1 };
viewportMap.viewportAnimationFrame = null;
let viewportBaseDraws = 0;
let viewportAgentDraws = 0;
viewportMap.drawBase = () => { viewportBaseDraws += 1; };
viewportMap.drawAgents = () => { viewportAgentDraws += 1; };
let viewportWorkerRequests = 0;
viewportMap.staticRenderReady = true;
viewportMap.requestStaticRender = () => { viewportWorkerRequests += 1; return true; };
viewportMap.applyViewportTransform();
assert.equal(viewportMap.viewportLayer.style.transform, "matrix(2, 0, 0, 2, -70, -40)");
assert.equal(viewportMap.baseCanvas.style.transform, undefined);
assert.equal(viewportMap.agentCanvas.style.transform, "matrix(2, 0, 0, 2, -62, -36)");

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
  assert.equal(viewportMap.viewportLayer.style.transform, "matrix(2, 0, 0, 2, -70, -40)");
  assert.equal(viewportMap.agentCanvas.style.transform, "matrix(2, 0, 0, 2, -62, -36)");
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
let bitmapDrawArgumentCount = 0;
workerMap.baseCanvas = { width: 175, height: 150, style: {} };
workerMap.agentCanvas = { style: {} };
workerMap.viewportLayer = { style: {} };
workerMap.scheduleViewportDraw = () => {};
workerMap.baseContext = {
  setTransform() {},
  clearRect() {},
  drawImage(...args) {
    bitmapDraws += 1;
    bitmapDrawArgumentCount = args.length;
  },
  set globalAlpha(value) {},
};

let rendererTransfers = 0;
let rendererBitmapCloses = 0;
const rendererPresenterMap = Object.create(localMapModule.LocalTrafficMap.prototype);
rendererPresenterMap.baseBitmapContext = {
  transferFromImageBitmap() { rendererTransfers += 1; },
};
rendererPresenterMap.baseContext = {
  drawImage() { assert.fail("bitmaprenderer must avoid the 2D copy"); },
};
assert.equal(rendererPresenterMap.presentBaseBitmap({
  close() { rendererBitmapCloses += 1; },
}), true);
assert.equal(rendererTransfers, 1);
assert.equal(rendererBitmapCloses, 0);

let stagedTransfers = 0;
const stagedBitmap = { close() { assert.fail("successful transfer consumes the bitmap"); } };
const stagedSurface = {
  width: 1,
  height: 1,
  transferToImageBitmap() { return stagedBitmap; },
};
const stagedPresenterMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(stagedPresenterMap, {
  baseCanvas: { width: 175, height: 150 },
  baseRenderCanvas: stagedSurface,
  baseContext: {},
  baseBitmapContext: {
    transferFromImageBitmap(bitmap) {
      assert.equal(bitmap, stagedBitmap);
      stagedTransfers += 1;
    },
  },
});
assert.equal(stagedPresenterMap.prepareBaseRenderSurface(), stagedPresenterMap.baseContext);
assert.equal(stagedSurface.width, 175);
assert.equal(stagedSurface.height, 150);
assert.equal(stagedPresenterMap.presentBaseRenderSurface(), true);
assert.equal(stagedTransfers, 1);
assert.equal(stagedSurface.width, 1);
assert.equal(stagedSurface.height, 1);

let replacementDrawArgumentCount = 0;
let replacementBitmapCloses = 0;
let installedReplacement = null;
const replacementContext = {
  setTransform() {},
  drawImage(...args) { replacementDrawArgumentCount = args.length; },
  set globalAlpha(value) {},
};
const replacementParent = {
  replaceChild(replacement, previousCanvas) {
    assert.equal(previousCanvas, failingPresenterMap.baseCanvas);
    installedReplacement = replacement;
    replacement.parentNode = this;
  },
};
const replacementDocument = {
  createElement(type) {
    assert.equal(type, "canvas");
    return {
      className: "",
      width: 0,
      height: 0,
      style: {},
      getContext: () => replacementContext,
      parentNode: null,
    };
  },
};
const failingPresenterMap = Object.create(localMapModule.LocalTrafficMap.prototype);
failingPresenterMap.baseCanvas = {
  ownerDocument: replacementDocument,
  parentNode: replacementParent,
  className: "local-map-canvas local-map-base",
  width: 175,
  height: 150,
  style: { width: "140px", height: "120px", left: "-20px", top: "-20px" },
};
failingPresenterMap.baseBitmapContext = {
  transferFromImageBitmap() { throw new Error("lost bitmap presenter"); },
};
failingPresenterMap.baseRenderCanvas = { width: 175, height: 150 };
failingPresenterMap.baseContext = null;
assert.equal(failingPresenterMap.presentBaseBitmap({
  close() { replacementBitmapCloses += 1; },
}), true);
assert.equal(installedReplacement, failingPresenterMap.baseCanvas);
assert.equal(failingPresenterMap.baseBitmapContext, null);
assert.equal(failingPresenterMap.baseRenderCanvas, null);
assert.equal(replacementDrawArgumentCount, 3);
assert.equal(replacementBitmapCloses, 1);

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
timeoutMap.scheduleViewportDraw = () => { timeoutPreviewUpdates += 1; };
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
  viewportLayer: { style: {} },
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
fallbackMap.scheduleViewportDraw = () => {};
fallbackMap.fallbackFromStaticRendererFailure();
assert.equal(fallbackBaseDraws, 0);
assert.equal(fallbackAgentDraws, 0);
assert.ok(fallbackMap.viewportInteraction);
fallbackMap.dragState = null;
fallbackMap.finishViewportInteraction();
assert.equal(fallbackBaseDraws, 1);
assert.equal(fallbackAgentDraws, 1);
assert.equal(fallbackMap.viewportInteraction, null);
assert.equal(fallbackMap.viewportLayer.style.transform, "matrix(1, 0, 0, 1, 0, 0)");
assert.equal(fallbackMap.baseCanvas.style.transform, undefined);
assert.equal(fallbackMap.agentCanvas.style.transform, "matrix(1, 0, 0, 1, 0, 0)");

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
gestureMap.animationFrame = 17;
gestureMap.viewportCommitTimer = null;
gestureMap.viewportInteraction = null;
gestureMap.centerX = 10;
gestureMap.centerY = 20;
gestureMap.scale = 3;
gestureMap.container = { classList: { add() {}, remove() {} } };
gestureMap.viewportLayer = { style: {} };
const viewportInteractionChanges = [];
gestureMap.onViewportInteractionChange = (interacting) => {
  viewportInteractionChanges.push(interacting);
};
gestureMap.beginViewportInteraction();
assert.equal(gestureMap.agents[0], gestureTarget);
assert.equal(gestureMap.agents[0].lat, 47.001);
assert.equal(gestureMap.agentAnimationActive, true);
assert.equal(gestureMap.animationFrame, 17);
assert.deepEqual(viewportInteractionChanges, [true]);
assert.equal(gestureMap.isViewportInteracting(), true);
gestureMap.completeViewportInteraction();
assert.deepEqual(viewportInteractionChanges, [true, false]);
assert.equal(gestureMap.isViewportInteracting(), false);
assert.equal(gestureMap.viewportLayer.style.transform, "matrix(1, 0, 0, 1, 0, 0)");

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
  previousAgents: new Map([[1, { id: 1 }]]),
  agentAnimationActive: true,
  transitionStarted: 123,
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
commitMap.viewportLayer = { style: {} };
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
assert.equal(commitMap.viewportLayer.style.transform, "matrix(1, 0, 0, 1, 0, 0)");
assert.equal(commitMap.baseCanvas.style.transform, undefined);
assert.equal(commitMap.agentCanvas.style.transform, "matrix(1, 0, 0, 1, 0, 0)");
assert.equal(commitAgentDraws, 1);
assert.equal(commitMap.previousSelectedRouteIndex, 1);
assert.equal(commitMap.previousAgents.size, 1);
assert.equal(commitMap.agentAnimationActive, true);
assert.equal(commitMap.transitionStarted, 123);
assert.equal(commitBaseDraws, 0);
assert.equal(bitmapDraws, bitmapDrawsBeforeCommit + 1);
assert.equal(bitmapDrawArgumentCount, 3);

const wheelMap = Object.create(localMapModule.LocalTrafficMap.prototype);
let wheelRectReads = 0;
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
    getBoundingClientRect: () => {
      wheelRectReads += 1;
      return { left: 100, top: 50 };
    },
    classList: { add() {}, remove() {} },
  },
});
let wheelAnchor = null;
wheelMap.screenToWorld = (x, y) => {
  wheelAnchor = { x, y };
  return { x: 10, y: 20 };
};
wheelMap.scheduleViewportDraw = () => {};
let wheelCommitSchedules = 0;
wheelMap.scheduleViewportCommit = () => {
  wheelCommitSchedules += 1;
  wheelMap.viewportCommitTimer = 1;
};
wheelMap.handleWheel({
  preventDefault() {},
  clientX: 150,
  clientY: 90,
  deltaY: 0,
});
assert.deepEqual(wheelAnchor, { x: 50, y: 40 });
assert.equal(wheelMap.containerLeft, 100);
assert.equal(wheelMap.containerTop, 50);
wheelMap.handleWheel({
  preventDefault() {},
  clientX: 160,
  clientY: 100,
  deltaY: 0,
});
assert.equal(wheelRectReads, 1);
assert.equal(wheelCommitSchedules, 2);
wheelMap.dragState = { viewChanged: true };
wheelMap.handleWheel({
  preventDefault() {},
  clientX: 160,
  clientY: 100,
  deltaY: 0,
});
assert.equal(wheelCommitSchedules, 2);

const nativeWheelPerformanceDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "performance",
);
const nativeWheelSetTimeout = globalThis.setTimeout;
let wheelTimerNow = 0;
let wheelTimerCallback = null;
const wheelTimerDelays = [];
try {
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => wheelTimerNow },
  });
  globalThis.setTimeout = (callback, delay) => {
    wheelTimerCallback = callback;
    wheelTimerDelays.push(delay);
    return { type: "wheel-idle" };
  };
  const wheelTimerMap = Object.create(localMapModule.LocalTrafficMap.prototype);
  Object.assign(wheelTimerMap, {
    viewportCommitTimer: null,
    viewportCommitDeadline: null,
    viewportInteraction: { centerX: 0, centerY: 0, scale: 1 },
  });
  let wheelIdleCommits = 0;
  wheelTimerMap.finishViewportInteraction = () => { wheelIdleCommits += 1; };
  wheelTimerMap.scheduleViewportCommit();
  wheelTimerNow = 50;
  wheelTimerMap.scheduleViewportCommit();
  assert.equal(wheelTimerDelays.length, 1);
  wheelTimerNow = 180;
  wheelTimerCallback();
  assert.equal(wheelIdleCommits, 0);
  assert.equal(wheelTimerDelays.length, 2);
  assert.equal(Math.round(wheelTimerDelays[1]), 50);
  wheelTimerNow = 230;
  wheelTimerCallback();
  assert.equal(wheelIdleCommits, 1);
} finally {
  globalThis.setTimeout = nativeWheelSetTimeout;
  Object.defineProperty(globalThis, "performance", nativeWheelPerformanceDescriptor);
}

const deferredResolutionMap = Object.create(localMapModule.LocalTrafficMap.prototype);
let deferredResolutionWrites = 0;
const deferredAgentCanvas = {
  _width: 300,
  _height: 200,
  style: {},
  get width() { return this._width; },
  set width(value) { this._width = value; deferredResolutionWrites += 1; },
  get height() { return this._height; },
  set height(value) { this._height = value; deferredResolutionWrites += 1; },
};
Object.assign(deferredResolutionMap, {
  agents: new Array(3_000),
  agentColorModes: { car: "individual", pedestrian: "uniform" },
  agentPixelRatio: 1.5,
  pixelRatio: 1.5,
  devicePixelRatio: 1.5,
  width: 200,
  height: 100,
  agentCanvas: deferredAgentCanvas,
  viewportInteraction: { centerX: 0, centerY: 0, scale: 1 },
  pendingAgentResolutionSync: false,
});
assert.equal(deferredResolutionMap.syncAgentCanvasResolution(), false);
assert.equal(deferredResolutionWrites, 0);
assert.equal(deferredResolutionMap.pendingAgentResolutionSync, true);
deferredResolutionMap.viewportInteraction = null;
assert.equal(deferredResolutionMap.syncAgentCanvasResolution(), true);
assert.equal(deferredResolutionMap.agentPixelRatio, 1);
assert.equal(deferredResolutionWrites, 2);

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
  assert.equal(scheduledAgentDraws.length, 12);
  for (let index = 1; index < scheduledAgentDraws.length - 1; index += 1) {
    assert.ok(scheduledAgentDraws[index] - scheduledAgentDraws[index - 1] <= 17);
  }
  assert.ok(scheduledAgentDraws.at(-1) >= 176);
  assert.equal(schedulerMap.agentAnimationActive, false);
  assert.equal(schedulerMap.animationFrame, null);

  scheduledAgentDraws.length = 0;
  schedulerMap.agentAnimationActive = true;
  schedulerMap.transitionStarted = 0;
  schedulerMap.lastAgentDrawAt = Number.NEGATIVE_INFINITY;
  schedulerMap.agentDrawDurationMs = 12;
  schedulerMap.scheduleAgentDraw();
  for (let frame = 0; frame < 20 && queuedAgentFrame; frame += 1) {
    const callback = queuedAgentFrame;
    queuedAgentFrame = null;
    callback(frame * (1_000 / 60));
  }
  assert.equal(scheduledAgentDraws.length, 7);
  assert.ok(scheduledAgentDraws.at(-1) >= 176);
  assert.equal(schedulerMap.agentAnimationActive, false);

  scheduledAgentDraws.length = 0;
  schedulerMap.agentAnimationActive = true;
  schedulerMap.transitionStarted = 0;
  schedulerMap.lastAgentDrawAt = Number.NEGATIVE_INFINITY;
  schedulerMap.viewportInteraction = { centerX: 0, centerY: 0, scale: 1 };
  schedulerMap.scheduleAgentDraw();
  assert.equal(typeof queuedAgentFrame, "function");
  const viewportAnimationCallback = queuedAgentFrame;
  queuedAgentFrame = null;
  viewportAnimationCallback(0);
  assert.deepEqual(scheduledAgentDraws, [0]);
  assert.equal(typeof queuedAgentFrame, "function");
  schedulerMap.agentDrawDurationMs = 0;
  const sameTimestampCallback = queuedAgentFrame;
  queuedAgentFrame = null;
  sameTimestampCallback(0);
  assert.deepEqual(scheduledAgentDraws, [0]);
} finally {
  if (schedulerRequestAnimationFrame === undefined) {
    delete globalThis.requestAnimationFrame;
  } else {
    globalThis.requestAnimationFrame = schedulerRequestAnimationFrame;
  }
}

const hitMap = Object.create(localMapModule.LocalTrafficMap.prototype);
const hitAgent = { id: 91, mode: "car" };
Object.assign(hitMap, {
  viewportInteraction: { centerX: 0, centerY: 0, scale: 1 },
  baseRenderView: { centerX: 0, centerY: 0, scale: 1 },
  centerX: 20,
  centerY: 0,
  scale: 4,
  zoom: 1,
  width: 100,
  height: 80,
  renderedAgents: [{ agent: hitAgent, screen: { x: 50, y: 40 } }],
  renderedPois: [],
});
let hitFeature = null;
hitMap.onFeatureSelect = (feature) => { hitFeature = feature; };
hitMap.inspectAt(50, 40);
assert.equal(hitFeature?.type, "agent");
assert.equal(hitFeature?.agent, hitAgent);

const poiRebaseMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(poiRebaseMap, {
  activePoiCategories: new Set(),
  poiVisibilityCache: {},
  staticRenderRevision: 0,
  staticRenderReady: false,
  viewportInteraction: { centerX: 0, centerY: 0, scale: 1 },
  viewportCommitTimer: null,
  viewportCommitDeadline: null,
  viewportAnimationFrame: null,
  viewportLayer: { style: {} },
  agentCanvas: { style: {} },
});
poiRebaseMap.viewportGestureActive = () => false;
let poiRebaseBaseDraws = 0;
let poiRebaseAgentDraws = 0;
poiRebaseMap.drawBase = () => { poiRebaseBaseDraws += 1; };
poiRebaseMap.drawAgents = () => { poiRebaseAgentDraws += 1; };
poiRebaseMap.setPoiCategories(["parking"]);
assert.deepEqual([...poiRebaseMap.activePoiCategories], ["parking"]);
assert.equal(poiRebaseMap.viewportInteraction, null);
assert.equal(poiRebaseBaseDraws, 1);
assert.equal(poiRebaseAgentDraws, 1);
assert.equal(poiRebaseMap.agentCanvas.style.transform, "matrix(1, 0, 0, 1, 0, 0)");

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

const curveMetersPerLongitudeDegree = 111_320 * Math.cos(47 * Math.PI / 180);
const curvePrevious = {
  id: 9,
  mode: "car",
  lat: 47,
  lng: 19,
  heading: 90,
  waiting: false,
};
const curveCurrent = {
  ...curvePrevious,
  lat: curvePrevious.lat + 10 / 111_320,
  lng: curvePrevious.lng + 10 / curveMetersPerLongitudeDegree,
  heading: 0,
};
const curveMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(curveMap, {
  agents: [curveCurrent],
  previousAgents: new Map([[curvePrevious.id, curvePrevious]]),
  interpolationResetAgentIds: new Set(),
  transitionStarted: 0,
  agentTransitionDurationMs: 100,
  agentCurveInterpolationActive: true,
  metersPerLongitudeDegree: curveMetersPerLongitudeDegree,
});
const curveCaptured = curveMap.captureInterpolatedAgents(50).get(curveCurrent.id);
const curveLinearLatitude = (curvePrevious.lat + curveCurrent.lat) / 2;
const curveLinearLongitude = (curvePrevious.lng + curveCurrent.lng) / 2;
assert.ok(curveCaptured.lat < curveLinearLatitude);
assert.ok(curveCaptured.lng > curveLinearLongitude);
assert.ok(Math.abs(curveCaptured.heading - 45) < 1e-6);

curveMap.previousAgents = new Map([[
  curvePrevious.id,
  { ...curvePrevious, waiting: true },
]]);
curveMap.agents = [{ ...curveCurrent, waiting: true }];
const queuedPose = curveMap.captureInterpolatedAgents(50).get(curveCurrent.id);
assert.ok(Math.abs(queuedPose.lat - curveLinearLatitude) < 1e-12);
assert.ok(Math.abs(queuedPose.lng - curveLinearLongitude) < 1e-12);
assert.equal(queuedPose.heading, 45);

curveMap.previousAgents = new Map([[curvePrevious.id, curvePrevious]]);
curveMap.agents = [{ ...curveCurrent, relocated: true }];
curveMap.interpolationResetAgentIds = new Set([String(curveCurrent.id)]);
const relocatedPose = curveMap.captureInterpolatedAgents(50).get(curveCurrent.id);
assert.equal(relocatedPose.lat, curveCurrent.lat);
assert.equal(relocatedPose.lng, curveCurrent.lng);
assert.equal(relocatedPose.heading, curveCurrent.heading);

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
lifecycleMap.syncAgentCanvasResolution = () => false;
let scheduledDraws = 0;
lifecycleMap.scheduleAgentDraw = () => { scheduledDraws += 1; };
lifecycleMap.setAgents([current], { animate: false, resetTiming: true });
assert.equal(lifecycleMap.previousAgents.size, 0);
assert.equal(lifecycleMap.lastAgentSnapshotAt, null);
assert.equal(lifecycleMap.agentFrameIntervalMs, 125);
assert.equal(lifecycleMap.agentTransitionDurationMs, 125);
assert.equal(lifecycleMap.agentCurveInterpolationActive, false);
assert.equal(lifecycleMap.agentAnimationActive, false);
assert.equal(scheduledDraws, 1);

lifecycleMap.setAgents([{ ...current }], { animate: false });
assert.equal(scheduledDraws, 1);
lifecycleMap.agentAnimationActive = false;
lifecycleMap.setAgents([{ ...current }], { animate: true, observeInterval: false });
assert.equal(lifecycleMap.agentAnimationActive, false);
assert.equal(scheduledDraws, 1);

const interactingAgentMap = Object.create(localMapModule.LocalTrafficMap.prototype);
Object.assign(interactingAgentMap, {
  agents: [previous],
  previousAgents: new Map([[previous.id, previous]]),
  interpolationResetAgentIds: new Set(),
  viewportInteraction: { centerX: 0, centerY: 0, scale: 1 },
  lastAgentSnapshotAt: 100,
  agentFrameIntervalMs: 160,
  agentTransitionDurationMs: 176,
  agentAnimationActive: true,
  transitionStarted: 0,
});
interactingAgentMap.syncAgentCanvasResolution = () => false;
let interactionCaptures = 0;
interactingAgentMap.captureInterpolatedAgents = () => {
  interactionCaptures += 1;
  return new Map([[previous.id, previous]]);
};
interactingAgentMap.animationFrame = null;
let interactionDrawSchedules = 0;
interactingAgentMap.scheduleAgentDraw = () => { interactionDrawSchedules += 1; };
interactingAgentMap.setAgents([current], { animate: true, observeInterval: true });
assert.equal(interactionCaptures, 1);
assert.equal(interactingAgentMap.agents[0], current);
assert.equal(interactingAgentMap.previousAgents.size, 1);
assert.equal(interactingAgentMap.agentAnimationActive, true);
assert.equal(interactingAgentMap.agentCurveInterpolationActive, true);
assert.equal(interactionDrawSchedules, 1);

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
replayMap.syncAgentCanvasResolution = () => false;
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
  assert.equal(replayMap.agentCurveInterpolationActive, false);
  replayNow += 6_000;
  const frozenAgents = replayMap.freezeAgentTransition(replayNow);
  assert.equal(frozenAgents[0].lat, 47.0001);
  assert.equal(frozenAgents[0].lng, 19.0001);
  assert.equal(frozenAgents[0].heading, 0);
  assert.equal(replayMap.agentAnimationActive, false);
  assert.equal(replayMap.agentCurveInterpolationActive, false);

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
  assert.equal(replayMap.agentTransitionDurationMs, 160);
  assert.equal(replayMap.agentCurveInterpolationActive, false);
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
appearanceMap.syncAgentCanvasResolution = () => false;
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
