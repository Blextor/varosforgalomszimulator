import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourceUrl = new URL("../src/state-protocol.js", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const protocol = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

const fullWire = {
  v: 2,
  k: "f",
  r: 1,
  c: true,
  run: true,
  speed: 15,
  sid: "server-a",
  epoch: 1,
  catalog: true,
  s: { cars: 2, pedestrians: 1, elapsedSeconds: 2 },
  g: { car: { viableAnchors: 10 }, pedestrian: { viableAnchors: 12 } },
  a: [
    [1, 0, 474_000_000, 190_000_000, 900, 0],
    [2, 1, 474_000_100, 190_000_100, 450, 0],
    [4, 0, 474_000_400, 190_000_400, 1800, 1],
  ],
  t: [1, 2, 4],
  z: [
    1,
    ["origin", "Indulás", "shopping", "poi", 15],
    ["destination", "Érkezés", "transit", "gateway", 0],
  ],
  q: { agentId: 1, mode: "car", token: "route", routeIndex: 0, nodeIds: [1, 2] },
};

const emptyCache = protocol.createStateProtocolCache();
const full = protocol.reduceSimulationState(fullWire, emptyCache);
assert.equal(full.compact, true);
assert.equal(full.cache.revision, 1);
assert.equal(full.payload.agents.length, 3);
assert.equal(full.payload.agents[0].lat, 47.4);
assert.equal(full.payload.agents[0].originPoi.name, "Indulás");
assert.equal(full.payload.agents.every((agent) => agent.relocated), true);
assert.deepEqual(full.payload.selectedRoute.nodeIds, [1, 2]);

const oldAgentOne = full.cache.agents.get(1);
const deltaWire = {
  v: 2,
  k: "d",
  b: 1,
  r: 2,
  c: true,
  run: true,
  speed: 15,
  sid: "server-a",
  epoch: 1,
  s: { cars: 2, pedestrians: 1, elapsedSeconds: 3 },
  p: [[1, 474_000_010, 190_000_020]],
  u: [[4, 474_000_410, 190_000_420, 1810, 0]],
  n: [[3, 1, 474_000_300, 190_000_300, 2700, 0]],
  x: [2],
  t: [4],
  z: [1, ["origin", "Új indulás", "food", "poi", 20], null],
  q: { agentId: 1, mode: "car", token: "route", routeIndex: 1 },
};
const delta = protocol.reduceSimulationState(deltaWire, full.cache);
assert.equal(delta.cache.revision, 2);
assert.deepEqual([...delta.cache.agents.keys()], [1, 4, 3]);
assert.equal(delta.cache.agents.get(1).lat, 47.400001);
assert.equal(delta.cache.agents.get(1).lng, 19.000002);
assert.equal(delta.cache.agents.get(1).originPoi.name, "Új indulás");
assert.equal(delta.cache.agents.get(4).heading, 181);
assert.equal(delta.cache.agents.get(4).waiting, false);
assert.equal(delta.cache.agents.get(1).relocated, false);
assert.equal(delta.cache.agents.get(4).relocated, true);
assert.equal(delta.cache.agents.get(3).relocated, false);
assert.notEqual(delta.cache.agents.get(1), oldAgentOne);
assert.equal(oldAgentOne.lat, 47.4);
assert.equal(oldAgentOne.relocated, true);

assert.throws(
  () => protocol.reduceSimulationState({ ...deltaWire, b: 0 }, full.cache),
  protocol.StateProtocolError,
);
assert.throws(
  () => protocol.reduceSimulationState({ ...deltaWire, epoch: 2 }, full.cache),
  protocol.StateProtocolError,
);
assert.throws(
  () => protocol.reduceSimulationState({ ...deltaWire, p: [[99, 1, 2]] }, full.cache),
  protocol.StateProtocolError,
);
assert.throws(
  () => protocol.reduceSimulationState({ ...deltaWire, t: [99] }, full.cache),
  protocol.StateProtocolError,
);
assert.throws(
  () => protocol.reduceSimulationState({ ...deltaWire, t: [4, 4] }, full.cache),
  protocol.StateProtocolError,
);
assert.throws(
  () => protocol.reduceSimulationState({ ...deltaWire, t: "4" }, full.cache),
  protocol.StateProtocolError,
);
assert.equal(full.cache.agents.size, 3);
assert.equal(full.cache.agents.get(1), oldAgentOne);

const settled = protocol.reduceSimulationState(
  {
    v: 2,
    k: "d",
    b: 2,
    r: 3,
    c: true,
    run: true,
    speed: 15,
    sid: "server-a",
    epoch: 1,
    s: { cars: 2, pedestrians: 1, elapsedSeconds: 4 },
  },
  delta.cache,
);
assert.equal(settled.payload.agents.every((agent) => !agent.relocated), true);
assert.equal(delta.cache.agents.get(4).relocated, true);

const nextEpoch = protocol.reduceSimulationState(
  { ...fullWire, r: 1, epoch: 2, z: null, q: null },
  settled.cache,
);
assert.equal(nextEpoch.cache.simulationEpoch, 2);
assert.equal(nextEpoch.cache.revision, 1);
assert.equal(nextEpoch.payload.agents.every((agent) => agent.relocated), true);

const compatibleFullWire = { ...fullWire, r: 2 };
delete compatibleFullWire.t;
const compatibleFull = protocol.reduceSimulationState(
  compatibleFullWire,
  protocol.createStateProtocolCache(),
);
assert.equal(
  compatibleFull.payload.agents.every((agent) => agent.relocated === false),
  true,
);

const legacy = { configured: true, running: false, agents: [] };
const legacyResult = protocol.reduceSimulationState(legacy, delta.cache);
assert.equal(legacyResult.compact, false);
assert.equal(legacyResult.payload, legacy);
assert.equal(legacyResult.cache.revision, null);

console.log("state protocol full/delta/resync contract: OK");
