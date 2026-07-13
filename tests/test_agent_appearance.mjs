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
const localMap = await import(
  `data:text/javascript;base64,${Buffer.from(rewrittenLocalMapSource).toString("base64")}`
);

const zoomLevels = [0.8, 0.95, 1.5, 3, 3.01, 7, 14, 28, 40];
const metrics = zoomLevels.map((zoom) => localMap.agentVisualMetrics(zoom));
for (const current of [
  localMap.agentVisualMetrics(undefined),
  localMap.agentVisualMetrics(Number.NaN),
  ...metrics,
]) {
  for (const value of Object.values(current)) {
    assert.equal(Number.isFinite(value), true);
  }
  assert.ok(current.carWidth >= 5.8 && current.carWidth <= 10.5);
  assert.ok(current.carLength >= 10.5 && current.carLength <= 21.5);
  assert.ok(current.pedestrianRadius >= 3.2 && current.pedestrianRadius <= 5.4);
  assert.ok(current.outlineWidth >= 0.5 && current.outlineWidth <= 0.7);
  assert.ok(current.carLength / current.carWidth >= 1.75);
  assert.ok(2 * (current.pedestrianRadius + current.outlineWidth) >= 7.4);
}

for (let index = 1; index < metrics.length; index += 1) {
  for (const key of Object.keys(metrics[index])) {
    assert.ok(metrics[index][key] >= metrics[index - 1][key]);
  }
}
for (const key of Object.keys(metrics[3])) {
  assert.ok(Math.abs(metrics[4][key] - metrics[3][key]) < 0.05);
}

for (const zoom of [0.95, 1.5, 3]) {
  const current = localMap.agentVisualMetrics(zoom);
  const poiRadius = Math.min(
    5.2,
    Math.max(3, 2.4 + Math.log2(zoom + 1) * 0.45),
  );
  const poiVisibleDiameter = 2 * (poiRadius + 2);
  assert.ok(current.carLength + 2 * current.outlineWidth >= poiVisibleDiameter);
  assert.ok(
    2 * (current.pedestrianRadius + current.outlineWidth)
      >= poiVisibleDiameter * 0.7,
  );
}

const car = { id: 17, mode: "car" };
const pedestrian = { id: 18, mode: "pedestrian" };
assert.equal(localMap.agentColorFor(car), "#ffad5a");
assert.equal(localMap.agentColorFor(pedestrian), "#43d9d0");
const individualModes = { car: "individual", pedestrian: "individual" };
assert.equal(
  localMap.agentColorFor(car, individualModes),
  localMap.agentColorFor({ ...car }, individualModes),
);
assert.equal(
  new Set(
    Array.from({ length: 16 }, (_, index) => (
      localMap.agentColorFor({ id: index + 1, mode: "car" }, individualModes)
    )),
  ).size,
  16,
);
assert.notEqual(localMap.agentColorFor(car, individualModes), "#ffad5a");
assert.equal(
  localMap.agentColorFor(pedestrian, { car: "individual", pedestrian: "uniform" }),
  "#43d9d0",
);

const headingMap = Object.create(localMap.LocalTrafficMap.prototype);
const headingMetrics = localMap.agentVisualMetrics(1.5);
const headingPolygons = [];
let headingPolygon = null;
headingMap.appendOverviewAgentShapes(
  {
    moveTo(x, y) { headingPolygon = [{ x, y }]; },
    lineTo(x, y) { headingPolygon.push({ x, y }); },
    closePath() { headingPolygons.push(headingPolygon); },
  },
  "car",
  [
    { x: 0, y: 0, heading: 0 },
    { x: 10, y: 10, heading: 45 },
    { x: 20, y: 20, heading: 90 },
    { x: 30, y: 30, heading: Number.NaN },
  ],
  headingMetrics,
);
assert.equal(headingPolygons.length, 4);
const extent = (polygon, key) => (
  Math.max(...polygon.map((point) => point[key]))
  - Math.min(...polygon.map((point) => point[key]))
);
assert.ok(Math.abs(extent(headingPolygons[0], "x") - headingMetrics.carWidth) < 1e-10);
assert.ok(Math.abs(extent(headingPolygons[0], "y") - headingMetrics.carLength) < 1e-10);
assert.ok(Math.abs(extent(headingPolygons[1], "x") - extent(headingPolygons[1], "y")) < 1e-10);
assert.ok(Math.abs(extent(headingPolygons[2], "x") - headingMetrics.carLength) < 1e-10);
assert.ok(Math.abs(extent(headingPolygons[2], "y") - headingMetrics.carWidth) < 1e-10);
assert.ok(Math.abs(extent(headingPolygons[3], "x") - headingMetrics.carWidth) < 1e-10);
assert.ok(Math.abs(extent(headingPolygons[3], "y") - headingMetrics.carLength) < 1e-10);
for (const polygon of headingPolygons) {
  assert.equal(polygon.length, 4);
  assert.equal(
    polygon.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
    true,
  );
  const sideLength = (start, end) => Math.hypot(
    end.x - start.x,
    end.y - start.y,
  );
  assert.ok(Math.abs(sideLength(polygon[0], polygon[1]) - headingMetrics.carWidth) < 1e-10);
  assert.ok(Math.abs(sideLength(polygon[1], polygon[2]) - headingMetrics.carLength) < 1e-10);
}

const detailedMap = Object.create(localMap.LocalTrafficMap.prototype);
detailedMap.zoom = 7;
const detailedMetrics = localMap.agentVisualMetrics(detailedMap.zoom);
const detailedOperations = [];
const detailedContext = {
  save() {},
  restore() {},
  translate() {},
  rotate() {},
  fillRect(x, y, width, height) {
    detailedOperations.push({
      type: "fill",
      x,
      y,
      width,
      height,
      style: this._fillStyle,
    });
  },
  strokeRect(x, y, width, height) {
    detailedOperations.push({
      type: "stroke",
      x,
      y,
      width,
      height,
      style: this._strokeStyle,
      lineWidth: this._lineWidth,
    });
  },
  set globalAlpha(value) { this._globalAlpha = value; },
  set fillStyle(value) { this._fillStyle = value; },
  set strokeStyle(value) { this._strokeStyle = value; },
  set lineWidth(value) { this._lineWidth = value; },
};
detailedMap.drawCar(
  detailedContext,
  0,
  0,
  45,
  false,
  "#ffad5a",
  detailedMetrics,
);
assert.deepEqual(detailedOperations.map((operation) => operation.type), ["fill", "stroke"]);
assert.equal(detailedOperations[0].style, "#ffad5a");
assert.equal(detailedOperations[1].style, "rgba(7, 16, 15, 0.82)");
assert.equal(detailedOperations[1].lineWidth, detailedMetrics.outlineWidth * 2);
assert.equal(detailedOperations[0].width, detailedMetrics.carWidth);
assert.equal(detailedOperations[0].height, detailedMetrics.carLength);
assert.equal(detailedOperations[1].width, detailedMetrics.carWidth);
assert.equal(detailedOperations[1].height, detailedMetrics.carLength);

const pedestrianOperations = [];
const pedestrianContext = {
  save() {},
  restore() {},
  beginPath() {},
  arc(x, y, radius) {
    pedestrianOperations.push({ type: "arc", x, y, radius });
  },
  fill() {
    pedestrianOperations.push({ type: "fill", style: this._fillStyle });
  },
  set globalAlpha(value) { this._globalAlpha = value; },
  set fillStyle(value) { this._fillStyle = value; },
};
detailedMap.drawPedestrian(
  pedestrianContext,
  4,
  5,
  false,
  "#43d9d0",
  detailedMetrics,
);
assert.deepEqual(
  pedestrianOperations.map((operation) => operation.type),
  ["arc", "fill", "arc", "fill"],
);
assert.equal(
  pedestrianOperations[0].radius,
  detailedMetrics.pedestrianRadius + detailedMetrics.outlineWidth,
);
assert.equal(pedestrianOperations[1].style, "rgba(7, 16, 15, 0.82)");
assert.equal(pedestrianOperations[2].radius, detailedMetrics.pedestrianRadius);
assert.equal(pedestrianOperations[3].style, "#43d9d0");

const overviewMap = Object.create(localMap.LocalTrafficMap.prototype);
overviewMap.zoom = 1.5;
overviewMap.selectedAgentId = null;
overviewMap.agentColorModes = individualModes;
overviewMap.renderedAgents = Array.from({ length: 5_000 }, (_, index) => ({
  agent: {
    id: index + 1,
    mode: index % 2 === 0 ? "car" : "pedestrian",
    waiting: index % 7 === 0,
  },
  screen: {
    x: index % 100,
    y: Math.floor(index / 100),
    heading: index % 360,
  },
}));
let fillCount = 0;
let strokeCount = 0;
let batchCount = 0;
let carPolygonCount = 0;
let pedestrianArcCount = 0;
let lastStrokePath = null;
const paintOperations = [];
const originalPath2D = globalThis.Path2D;
class TestPath2D {
  constructor() {
    this.addedPaths = [];
  }

  moveTo() {}
  lineTo() {}
  closePath() { carPolygonCount += 1; }
  arc() { pedestrianArcCount += 1; }
  addPath(path) { this.addedPaths.push(path); }
}
globalThis.Path2D = TestPath2D;
const context = {
  save() {},
  restore() {},
  beginPath() { batchCount += 1; },
  moveTo() {},
  lineTo() {},
  closePath() { carPolygonCount += 1; },
  arc() { pedestrianArcCount += 1; },
  fill() { fillCount += 1; paintOperations.push("fill"); },
  stroke(path) {
    strokeCount += 1;
    lastStrokePath = path;
    paintOperations.push("stroke");
  },
  set globalAlpha(value) { this._globalAlpha = value; },
  set fillStyle(value) { this._fillStyle = value; },
  set strokeStyle(value) { this._strokeStyle = value; },
  set lineWidth(value) { this._lineWidth = value; },
};
overviewMap.drawOverviewAgents(context);
const waitingCarCount = overviewMap.renderedAgents.filter((entry) => (
  entry.agent.mode === "car" && entry.agent.waiting
)).length;
const waitingPedestrianCount = overviewMap.renderedAgents.filter((entry) => (
  entry.agent.mode === "pedestrian" && entry.agent.waiting
)).length;
assert.equal(carPolygonCount, 2_500 + waitingCarCount);
assert.equal(pedestrianArcCount, 2_500 + waitingPedestrianCount);
assert.equal(batchCount, 0);
assert.equal(fillCount, 17);
assert.equal(strokeCount, 1);
assert.ok(batchCount <= 17, `Túl sok rajzolási batch: ${batchCount}`);

assert.equal(lastStrokePath.addedPaths.length, 16);
assert.equal(paintOperations.at(-1), "stroke");

const batchCache = overviewMap.overviewColorBatches;
const cachedScreenArrays = [...batchCache.values()].map((batch) => [
  batch.carScreens,
  batch.pedestrianScreens,
]);
overviewMap.drawOverviewAgents(context);
assert.equal(overviewMap.overviewColorBatches, batchCache);
assert.equal(overviewMap.waitingAgentScreens.car.length > 0, true);
assert.equal(overviewMap.waitingAgentScreens.pedestrian.length > 0, true);
assert.deepEqual(
  [...batchCache.values()].map((batch) => [
    batch.carScreens,
    batch.pedestrianScreens,
  ]),
  cachedScreenArrays,
);
overviewMap.agentColorModes = { car: "uniform", pedestrian: "uniform" };
const uniformFillStart = fillCount;
const uniformStrokeStart = strokeCount;
const uniformBatchStart = batchCount;
overviewMap.drawOverviewAgents(context);
assert.equal(fillCount - uniformFillStart, 3);
assert.equal(strokeCount - uniformStrokeStart, 2);
assert.equal(batchCount - uniformBatchStart, 3);
if (originalPath2D === undefined) {
  delete globalThis.Path2D;
} else {
  globalThis.Path2D = originalPath2D;
}

console.log("agent appearance scaling/color/batching contract: OK");
