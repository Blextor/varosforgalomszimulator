import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

let messageHandler = null;
const postedMessages = [];
const postedTransfers = [];
globalThis.self = {
  addEventListener(type, handler) {
    if (type === "message") {
      messageHandler = handler;
    }
  },
  postMessage(message, transfer = []) {
    postedMessages.push(message);
    postedTransfers.push(transfer);
  },
};

let strokeCount = 0;
let fillTextCount = 0;
let currentFillStyle = null;
const fillRectCalls = [];
class FakePath2D {
  moveTo() {}

  lineTo() {}

  arc() {}
}
globalThis.Path2D = FakePath2D;

const fakeContext = {
  setTransform() {},
  fillRect(...values) { fillRectCalls.push({ style: currentFillStyle, values }); },
  setLineDash() {},
  stroke() { strokeCount += 1; },
  fill() {},
  save() {},
  restore() {},
  beginPath() {},
  moveTo() {},
  lineTo() {},
  quadraticCurveTo() {},
  closePath() {},
  translate() {},
  rotate() {},
  fillText() { fillTextCount += 1; },
  measureText() { return { width: 0 }; },
  set fillStyle(value) { currentFillStyle = value; },
  set strokeStyle(value) {},
  set globalAlpha(value) {},
  set lineWidth(value) {},
  set lineCap(value) {},
  set font(value) {},
};

globalThis.OffscreenCanvas = class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return fakeContext;
  }

  transferToImageBitmap() {
    return { type: "fake-bitmap" };
  }
};

const workerSource = await readFile(
  new URL("../src/static-map-worker.js", import.meta.url),
  "utf8",
);
await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`);
assert.equal(typeof messageHandler, "function");

messageHandler({
  data: {
    type: "initialize",
    segmentGeometry: new Float32Array([0, 0, 10, 0]),
    segmentWidths: new Float32Array([2]),
    segmentPriorities: new Uint8Array([5]),
    segmentModes: new Uint8Array([0]),
    segmentLanes: new Uint8Array([2]),
    segmentLodRanks: new Float32Array([0]),
    segmentCarSupport: new Uint8Array([1]),
    turnGeometry: new Float32Array(0),
    turnLaneData: new Uint8Array(0),
    turnDirections: new Uint8Array(0),
  },
});
assert.equal(postedMessages.at(-1).type, "ready");

messageHandler({
  data: {
    type: "render",
    requestId: 7,
    view: {
      width: 100,
      height: 80,
      padding: 20,
      pixelRatio: 1.25,
      centerX: 5,
      centerY: 0,
      scale: 5,
      zoom: 4,
    },
    pois: [{ x: 5, y: 0, color: "#ffffff", name: "Fixed-size label" }],
  },
});
const rendered = postedMessages.at(-1);
assert.equal(rendered.type, "rendered");
assert.equal(rendered.requestId, 7);
assert.equal(rendered.bitmap.type, "fake-bitmap");
assert.deepEqual(postedTransfers.at(-1), [rendered.bitmap]);
assert.equal(strokeCount, 4);
assert.equal(fillTextCount, 0, "POI labels must stay off the zoom-scaled static bitmap");
assert.deepEqual(fillRectCalls.at(-1), {
  style: "#111b18",
  values: [-20, -20, 140, 120],
});

messageHandler({
  data: {
    type: "render",
    requestId: 8,
    view: rendered.view,
    pois: [],
  },
});
const secondRendered = postedMessages.at(-1);
assert.equal(secondRendered.requestId, 8);
assert.notEqual(secondRendered.bitmap, rendered.bitmap);
assert.deepEqual(postedTransfers.at(-1), [secondRendered.bitmap]);

const backgroundCallStart = fillRectCalls.length;
messageHandler({
  data: {
    type: "render",
    requestId: 9,
    view: rendered.view,
    pois: [],
    mapBounds: { worldWidth: 10, worldHeight: 10 },
  },
});
assert.equal(postedMessages.at(-1).requestId, 9);
assert.deepEqual(fillRectCalls.slice(backgroundCallStart), [
  { style: "#000000", values: [-20, -20, 140, 120] },
  { style: "#111b18", values: [25, 40, 50, 50] },
]);

const segmentModeReads = new Set();
const turnDirectionReads = new Set();
const trackedValues = (values, reads) => new Proxy(values, {
  get(target, property, receiver) {
    if (/^\d+$/.test(String(property))) {
      reads.add(Number(property));
    }
    return Reflect.get(target, property, receiver);
  },
});
messageHandler({
  data: {
    type: "initialize",
    segmentGeometry: new Float32Array([
      0, 0, 10, 0,
      10_000, 0, 10_010, 0,
    ]),
    segmentWidths: new Float32Array([2, 2]),
    segmentPriorities: new Uint8Array([5, 5]),
    segmentModes: trackedValues([0, 0], segmentModeReads),
    segmentLanes: new Uint8Array([1, 1]),
    segmentLodRanks: new Float32Array([0, 0]),
    segmentCarSupport: new Uint8Array([1, 1]),
    turnGeometry: new Float32Array([
      0, 0, 10, 0,
      10_000, 0, 10_010, 0,
    ]),
    turnLaneData: new Uint8Array([0, 1, 0, 1]),
    turnDirections: trackedValues([1, 1], turnDirectionReads),
  },
});
assert.equal(postedMessages.at(-1).type, "ready");

segmentModeReads.clear();
turnDirectionReads.clear();
messageHandler({
  data: {
    type: "render",
    requestId: 10,
    view: {
      width: 100,
      height: 80,
      padding: 20,
      pixelRatio: 1,
      centerX: 5,
      centerY: 0,
      scale: 5,
      zoom: 8,
    },
    pois: [],
  },
});
assert.equal(postedMessages.at(-1).requestId, 10);
assert.deepEqual([...segmentModeReads], [0]);
assert.deepEqual([...turnDirectionReads], [0]);

console.log("static map worker render/grid/bounds contract: OK");
