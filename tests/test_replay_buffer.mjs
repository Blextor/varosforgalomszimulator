import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourceUrl = new URL("../src/replay-buffer.js", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const replay = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

assert.equal(replay.REPLAY_SAMPLE_INTERVAL_MS, 250);
assert.equal(replay.REPLAY_WINDOW_MS, 60_000);
assert.equal(replay.REPLAY_MAX_BYTES, 32 * 1024 * 1024);

const car = {
  id: 1,
  mode: "car",
  lat: 47.12345674,
  lng: 19.12345676,
  heading: 350,
  waiting: false,
};
const pedestrian = {
  id: 2,
  mode: "pedestrian",
  lat: 47.5,
  lng: 19.5,
  heading: 10,
  waiting: true,
};

const buffer = replay.createReplayBuffer();
const firstResult = buffer.append([car, pedestrian], {
  timestampMs: 1_000,
  simulationTimeSeconds: 12,
  relocatedAgentIds: [2],
});
assert.equal(firstResult.status, "appended");
assert.equal(firstResult.sequence, 1);
assert.equal(buffer.length, 1);
assert.ok(buffer.frames[0].ids instanceof Uint32Array);
assert.ok(buffer.frames[0].coordinates instanceof Int32Array);
assert.ok(buffer.frames[0].headings instanceof Uint16Array);
assert.ok(buffer.frames[0].flags instanceof Uint8Array);
assert.ok(buffer.byteLength <= replay.REPLAY_MAX_BYTES);

const first = buffer.decode(1);
assert.equal(first.timestampMs, 1_000);
assert.equal(first.simulationTimeSeconds, 12);
assert.equal(first.agents[0].lat, 47.1234567);
assert.equal(first.agents[0].lng, 19.1234568);
assert.equal(first.agents[0].heading, 350);
assert.equal(first.agents[0].waiting, false);
assert.equal(first.agents[0].relocated, false);
assert.equal(first.agents[1].mode, "pedestrian");
assert.equal(first.agents[1].waiting, true);
assert.equal(first.agents[1].relocated, true);

const relocatedCar = {
  ...car,
  lat: 47.2,
  lng: 19.2,
};
const sampledOut = buffer.append([relocatedCar, pedestrian], {
  timestampMs: 1_100,
  relocatedAgentIds: [1],
});
assert.equal(sampledOut.status, "sampled-out");
assert.equal(buffer.length, 1);

const capturedRelocation = buffer.append([relocatedCar, pedestrian], {
  timestampMs: 1_250,
  simulationTimeSeconds: 27,
});
assert.equal(capturedRelocation.status, "appended");
assert.equal(buffer.decode(2).agents[0].relocated, true);

const ordinaryFrame = buffer.append([relocatedCar, pedestrian], {
  timestampMs: 1_500,
  simulationTimeSeconds: 42,
});
assert.equal(ordinaryFrame.status, "appended");
assert.equal(buffer.decode(3).agents[0].relocated, false);

const coalesced = buffer.append([{ ...relocatedCar }, { ...pedestrian }], {
  timestampMs: 1_750,
  simulationTimeSeconds: 42,
});
assert.equal(coalesced.status, "coalesced");
assert.equal(coalesced.sequence, 3);
assert.equal(buffer.length, 3);
assert.equal(buffer.decode(3).sampleCount, 2);
assert.equal(buffer.decode(3).endTimestampMs, 1_750);
assert.equal(buffer.decode(3).endSimulationTimeSeconds, 42);

assert.equal(buffer.seek(0).sequence, 1);
assert.equal(buffer.seek(1_300).sequence, 2);
assert.equal(buffer.seek(99_000).sequence, 3);
assert.equal(buffer.decode(99_000), null);
assert.deepEqual(
  buffer.summaries().map((summary) => summary.sequence),
  [1, 2, 3],
);
assert.equal(buffer.summaries()[2].simulationTimeSeconds, 42);
assert.equal(buffer.summaries()[2].endSimulationTimeSeconds, 42);

const dwellTiming = replay.createReplayBuffer({ sampleIntervalMs: 1 });
dwellTiming.append([car], { timestampMs: 0, simulationTimeSeconds: 0 });
dwellTiming.append([{ ...car, lat: 47.2 }], {
  timestampMs: 1,
  simulationTimeSeconds: 1,
});
const heldButAdvancing = dwellTiming.append([{ ...car, lat: 47.2 }], {
  timestampMs: 11,
  simulationTimeSeconds: 11,
});
dwellTiming.append([{ ...car, lat: 47.3 }], {
  timestampMs: 12,
  simulationTimeSeconds: 12,
});
assert.equal(heldButAdvancing.status, "appended");
assert.equal(dwellTiming.length, 4);
const dwellFrames = [1, 2, 3, 4].map((sequence) => dwellTiming.decode(sequence));
assert.deepEqual(
  dwellFrames.slice(1).map((frame, index) => (
    replay.replayFrameDelayMs(dwellFrames[index], frame)
  )),
  [1_000, 10_000, 1_000],
);
assert.equal(
  replay.replayFrameDelayMs(
    { timestampMs: 1_000 },
    { timestampMs: 1_250 },
  ),
  250,
);
assert.equal(replay.replayFrameDelayMs({}, {}, 400), 400);

const frozenSnapshot = buffer.snapshot();
assert.equal(frozenSnapshot.length, buffer.length);
assert.equal(frozenSnapshot.decode(3).endTimestampMs, 1_750);
buffer.append([{ ...relocatedCar }, { ...pedestrian }], {
  timestampMs: 2_000,
  simulationTimeSeconds: 42,
});
assert.equal(buffer.decode(3).endTimestampMs, 2_000);
assert.equal(frozenSnapshot.decode(3).endTimestampMs, 1_750);
const advancedHeldFrame = buffer.append(
  [{ ...relocatedCar }, { ...pedestrian }],
  { timestampMs: 2_250, simulationTimeSeconds: 57 },
);
assert.equal(advancedHeldFrame.status, "appended");
assert.equal(advancedHeldFrame.sequence, 4);
assert.equal(buffer.length, 4);

const timeBound = replay.createReplayBuffer();
for (let index = 0; index <= 241; index += 1) {
  timeBound.append([{ ...car, lat: car.lat + index / 10_000_000 }], {
    timestampMs: index * 250,
  });
}
assert.equal(timeBound.newestTimestampMs, 60_250);
assert.equal(timeBound.oldestTimestampMs, 250);
assert.ok(timeBound.newestTimestampMs - timeBound.oldestTimestampMs <= 60_000);

const maximumPopulation = Array.from({ length: 5_000 }, (_, index) => ({
  id: index + 1,
  mode: index % 3 === 0 ? "pedestrian" : "car",
  lat: 47.4 + index / 100_000_000,
  lng: 19.0 + index / 100_000_000,
  heading: index % 360,
  waiting: index % 17 === 0,
}));
const populationBound = replay.createReplayBuffer();
for (let index = 0; index <= 240; index += 1) {
  maximumPopulation[0].lat = 47.4 + index / 10_000_000;
  populationBound.append(maximumPopulation, { timestampMs: index * 250 });
}
assert.equal(populationBound.length, 241);
assert.ok(populationBound.byteLength < replay.REPLAY_MAX_BYTES);
assert.ok(populationBound.newestTimestampMs - populationBound.oldestTimestampMs <= 60_000);

const heldFrame = replay.createReplayBuffer({ windowMs: 1_000 });
for (let timestamp = 0; timestamp <= 1_250; timestamp += 250) {
  heldFrame.append([car], { timestampMs: timestamp });
}
assert.equal(heldFrame.length, 5);
assert.equal(heldFrame.oldestTimestampMs, 250);
assert.equal(heldFrame.newestTimestampMs, 1_250);
assert.equal(heldFrame.decode().sampleCount, 1);

const bytesPerSingleAgentFrame = 256 + 4 + 8 + 2 + 1;
const memoryBound = replay.createReplayBuffer({
  maxBytes: bytesPerSingleAgentFrame * 2,
  windowMs: 60_000,
});
for (let index = 0; index < 3; index += 1) {
  memoryBound.append([{ ...car, lat: car.lat + index / 10_000 }], {
    timestampMs: index * 250,
  });
}
assert.equal(memoryBound.length, 2);
assert.equal(memoryBound.oldestSequence, 2);
assert.equal(memoryBound.newestSequence, 3);
assert.equal(memoryBound.byteLength, bytesPerSingleAgentFrame * 2);
assert.ok(memoryBound.byteLength <= memoryBound.maxBytes);

const tooSmall = replay.createReplayBuffer({ maxBytes: bytesPerSingleAgentFrame - 1 });
assert.throws(
  () => tooSmall.append([car], { timestampMs: 0 }),
  /exceeds maxBytes/,
);
assert.equal(tooSmall.length, 0);
assert.equal(tooSmall.byteLength, 0);

assert.throws(
  () => buffer.append([car], { timestampMs: 1_749, force: true }),
  /monotonic/,
);
assert.throws(
  () => replay.createReplayBuffer().append([car, { ...car }], { timestampMs: 0 }),
  /Duplicate replay agent id/,
);

memoryBound.reset();
assert.equal(memoryBound.length, 0);
assert.equal(memoryBound.byteLength, 0);
assert.equal(memoryBound.oldestSequence, null);
assert.equal(memoryBound.newestSequence, null);
const afterReset = memoryBound.append([car], { timestampMs: 10_000 });
assert.equal(afterReset.sequence, 1);

console.log("replay buffer sampling/ring/seek contract: OK");
