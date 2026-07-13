import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

let messageHandler = null;
const postedMessages = [];
globalThis.self = {
  addEventListener(type, handler) {
    if (type === "message") {
      messageHandler = handler;
    }
  },
  postMessage(message) {
    postedMessages.push(message);
  },
};

let strokeCount = 0;
class FakePath2D {
  moveTo() {}

  lineTo() {}

  arc() {}
}
globalThis.Path2D = FakePath2D;

const fakeContext = {
  setTransform() {},
  fillRect() {},
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
  fillText() {},
  measureText() { return { width: 0 }; },
  set fillStyle(value) {},
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
    pois: [],
  },
});
const rendered = postedMessages.at(-1);
assert.equal(rendered.type, "rendered");
assert.equal(rendered.requestId, 7);
assert.equal(rendered.bitmap.type, "fake-bitmap");
assert.equal(strokeCount, 3);

console.log("static map worker render/transfer contract: OK");
