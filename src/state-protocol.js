export const STATE_PROTOCOL_VERSION = 2;

export class StateProtocolError extends Error {}

export function createStateProtocolCache() {
  return {
    revision: null,
    serverInstanceId: null,
    simulationEpoch: null,
    routing: null,
    routeCatalogLoaded: false,
    agents: new Map(),
  };
}

function requireRow(row, length, label) {
  if (!Array.isArray(row) || row.length !== length) {
    throw new StateProtocolError(`Érvénytelen ${label} sor.`);
  }
  return row;
}

function finiteInteger(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw new StateProtocolError(`Érvénytelen ${label}.`);
  }
  return value;
}

function decodePosition(value, label) {
  return finiteInteger(value, label) / 10_000_000;
}

function decodeHeading(value) {
  return finiteInteger(value, "irányszög") / 10;
}

function decodeWaiting(value) {
  if (value !== 0 && value !== 1) {
    throw new StateProtocolError("Érvénytelen várakozási jelző.");
  }
  return value === 1;
}

function decodePoi(raw) {
  if (raw === null) {
    return null;
  }
  requireRow(raw, 5, "helyszín");
  return {
    id: raw[0],
    name: String(raw[1] ?? ""),
    category: String(raw[2] ?? "other"),
    kind: String(raw[3] ?? "poi"),
    snapDistanceMeters: finiteInteger(raw[4], "illesztési távolság") / 10,
  };
}

function decodeFullAgent(row) {
  requireRow(row, 6, "ágens");
  const id = finiteInteger(row[0], "ágensazonosító");
  if (id <= 0 || (row[1] !== 0 && row[1] !== 1)) {
    throw new StateProtocolError("Érvénytelen ágensazonosító vagy közlekedési mód.");
  }
  return {
    id,
    mode: row[1] === 0 ? "car" : "pedestrian",
    lat: decodePosition(row[2], "szélesség"),
    lng: decodePosition(row[3], "hosszúság"),
    heading: decodeHeading(row[4]),
    waiting: decodeWaiting(row[5]),
    relocated: false,
    originPoi: null,
    destinationPoi: null,
  };
}

function decodeFull(wire) {
  if (!Array.isArray(wire.a)) {
    throw new StateProtocolError("A teljes állapot ágenslistája hiányzik.");
  }
  const agents = new Map();
  for (const row of wire.a) {
    const agent = decodeFullAgent(row);
    if (agents.has(agent.id)) {
      throw new StateProtocolError("Ismétlődő ágensazonosító a teljes állapotban.");
    }
    agents.set(agent.id, agent);
  }
  return agents;
}

function updateAgent(agents, id, changes) {
  const current = agents.get(id);
  if (!current) {
    throw new StateProtocolError("A delta ismeretlen ágenst frissít.");
  }
  agents.set(id, { ...current, ...changes });
}

function applyDelta(wire, cache) {
  if (
    cache.revision === null
    || wire.b !== cache.revision
    || wire.sid !== cache.serverInstanceId
    || wire.epoch !== cache.simulationEpoch
  ) {
    throw new StateProtocolError("A delta alapverziója nem egyezik a helyi állapottal.");
  }
  const agents = new Map(cache.agents);
  for (const [id, agent] of agents) {
    if (agent.relocated === true) {
      agents.set(id, { ...agent, relocated: false });
    }
  }
  for (const rawId of wire.x || []) {
    const id = finiteInteger(rawId, "törölt ágensazonosító");
    if (!agents.delete(id)) {
      throw new StateProtocolError("A delta ismeretlen ágenst töröl.");
    }
  }
  for (const row of wire.n || []) {
    const agent = decodeFullAgent(row);
    if (agents.has(agent.id)) {
      throw new StateProtocolError("A delta már létező ágenst ad hozzá.");
    }
    agents.set(agent.id, agent);
  }
  for (const row of wire.p || []) {
    requireRow(row, 3, "pozíciódelta");
    const id = finiteInteger(row[0], "ágensazonosító");
    updateAgent(agents, id, {
      lat: decodePosition(row[1], "szélesség"),
      lng: decodePosition(row[2], "hosszúság"),
    });
  }
  for (const row of wire.u || []) {
    requireRow(row, 5, "mozgásdelta");
    const id = finiteInteger(row[0], "ágensazonosító");
    updateAgent(agents, id, {
      lat: decodePosition(row[1], "szélesség"),
      lng: decodePosition(row[2], "hosszúság"),
      heading: decodeHeading(row[3]),
      waiting: decodeWaiting(row[4]),
    });
  }
  return agents;
}

function applyRelocations(agents, rawRelocations) {
  if (rawRelocations === undefined) {
    return;
  }
  if (!Array.isArray(rawRelocations)) {
    throw new StateProtocolError("Érvénytelen áthelyezési lista.");
  }
  const seen = new Set();
  for (const rawId of rawRelocations) {
    const id = finiteInteger(rawId, "áthelyezett ágensazonosító");
    if (id <= 0 || seen.has(id)) {
      throw new StateProtocolError("Érvénytelen vagy ismétlődő áthelyezett ágensazonosító.");
    }
    const current = agents.get(id);
    if (!current) {
      throw new StateProtocolError("Az áthelyezési lista ismeretlen ágenst tartalmaz.");
    }
    seen.add(id);
    agents.set(id, { ...current, relocated: true });
  }
}

function applySelectedAgentDetails(agents, rawDetails) {
  if (rawDetails === undefined || rawDetails === null) {
    return;
  }
  requireRow(rawDetails, 3, "kiválasztott ágens");
  const id = finiteInteger(rawDetails[0], "kiválasztott ágensazonosító");
  updateAgent(agents, id, {
    originPoi: decodePoi(rawDetails[1]),
    destinationPoi: decodePoi(rawDetails[2]),
  });
}

export function reduceSimulationState(wire, previousCache) {
  if (!wire || wire.v !== STATE_PROTOCOL_VERSION) {
    return {
      payload: wire,
      cache: createStateProtocolCache(),
      compact: false,
    };
  }
  if (wire.k !== "f" && wire.k !== "d") {
    throw new StateProtocolError("Ismeretlen állapotcsomag-típus.");
  }
  const revision = finiteInteger(wire.r, "állapotverzió");
  if (revision < 0) {
    throw new StateProtocolError("Negatív állapotverzió.");
  }
  const simulationEpoch = finiteInteger(wire.epoch, "szimulációs epoch");
  if (simulationEpoch < 0) {
    throw new StateProtocolError("Negatív szimulációs epoch.");
  }
  if (wire.k === "d" && revision <= wire.b) {
    throw new StateProtocolError("A delta állapotverziója nem növekszik.");
  }
  const agents = wire.k === "f"
    ? decodeFull(wire)
    : applyDelta(wire, previousCache);
  applySelectedAgentDetails(agents, wire.z);
  applyRelocations(agents, wire.t);

  const routing = wire.k === "f" ? (wire.g || {}) : previousCache.routing;
  const routeCatalogLoaded = wire.k === "f"
    ? Boolean(wire.catalog)
    : previousCache.routeCatalogLoaded;
  const cache = {
    revision,
    serverInstanceId: wire.sid || null,
    simulationEpoch,
    routing,
    routeCatalogLoaded,
    agents,
  };
  const payload = {
    configured: Boolean(wire.c),
    running: Boolean(wire.run),
    speedMultiplier: wire.speed,
    routeCatalogLoaded,
    serverInstanceId: wire.sid,
    simulationEpoch,
    agents: [...agents.values()],
    stats: wire.s,
    routing,
    error: wire.e,
  };
  if (Object.hasOwn(wire, "q")) {
    payload.selectedRoute = wire.q;
  }
  return { payload, cache, compact: true };
}
