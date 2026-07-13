import {
  DEFAULT_AGENT_FRAME_INTERVAL_MS,
  agentTransitionDuration,
  interpolateHeading,
  interpolationProgress,
  runningPollIntervalForAgentCount,
  updateAgentFrameInterval,
} from "./simulation-timing.js";

const HIGHWAY_STYLE = {
  motorway: { color: "#5f796f", width: 2.6, priority: 6 },
  motorway_link: { color: "#597168", width: 2.1, priority: 5 },
  trunk: { color: "#637c72", width: 2.5, priority: 6 },
  trunk_link: { color: "#5a7169", width: 2, priority: 5 },
  primary: { color: "#668177", width: 2.3, priority: 5 },
  primary_link: { color: "#5e766d", width: 1.9, priority: 4 },
  secondary: { color: "#567067", width: 2, priority: 4 },
  tertiary: { color: "#4a625a", width: 1.7, priority: 3 },
  residential: { color: "#354a43", width: 1.2, priority: 2 },
  living_street: { color: "#3c544c", width: 1.2, priority: 2 },
  service: { color: "#2d403a", width: 0.9, priority: 1 },
  pedestrian: { color: "#28504c", width: 1, priority: 1 },
  footway: { color: "#244742", width: 0.8, priority: 0 },
  path: { color: "#233e3a", width: 0.7, priority: 0 },
  steps: { color: "#304b45", width: 0.8, priority: 0 },
};

const DEFAULT_STYLE = { color: "#334941", width: 1, priority: 1 };
const DETAILED_ROAD_MIN_ZOOM = 2.4;
const BASE_CANVAS_MAX_PIXEL_RATIO = 1;
const AGENT_CANVAS_MAX_PIXEL_RATIO = 1.5;
const VIEWPORT_COMMIT_DELAY_MS = 180;
const STATIC_RENDER_TIMEOUT_MS = 2_500;
const LARGE_INDIVIDUAL_AGENT_LIMIT = 3_000;
const LARGE_INDIVIDUAL_AGENT_FRAME_INTERVAL_MS = 1_000 / 30;

const ROAD_MODE_STYLE = {
  car: { color: "#a7704c", alpha: 0.86, dash: [] },
  pedestrian: { color: "#2f8b88", alpha: 0.86, dash: [3, 3] },
  mixed: { color: "#587b6c", alpha: 0.9, dash: [] },
  unknown: { color: "#40514b", alpha: 0.62, dash: [2, 4] },
};

const ROAD_MODE_RENDER_INDEX = Object.freeze({
  car: 0,
  pedestrian: 1,
  mixed: 2,
  unknown: 3,
});

export const UNIFORM_AGENT_COLORS = Object.freeze({
  car: "#ffad5a",
  pedestrian: "#43d9d0",
});

const INDIVIDUAL_AGENT_COLORS = Object.freeze(
  Array.from(
    { length: 16 },
    (_, index) => `hsl(${index * 22.5}, 78%, 66%)`,
  ),
);

export function normalizeAgentColorModes(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    car: source.car === "individual" ? "individual" : "uniform",
    pedestrian: source.pedestrian === "individual" ? "individual" : "uniform",
  };
}

function agentColorIndex(agentId) {
  const numericId = Number(agentId);
  if (Number.isSafeInteger(numericId)) {
    return (Math.imul(numericId >>> 0, 2_654_435_761) >>> 0)
      % INDIVIDUAL_AGENT_COLORS.length;
  }
  let hash = 2_166_136_261;
  for (const character of String(agentId)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash % INDIVIDUAL_AGENT_COLORS.length;
}

export function agentColorFor(agent, colorModes = {}) {
  const mode = agent?.mode === "pedestrian" ? "pedestrian" : "car";
  if (colorModes?.[mode] !== "individual") {
    return UNIFORM_AGENT_COLORS[mode];
  }
  return INDIVIDUAL_AGENT_COLORS[agentColorIndex(agent?.id)];
}

export function agentVisualMetrics(zoom) {
  const normalizedZoom = clamp(Number.isFinite(Number(zoom)) ? Number(zoom) : 1, 0.8, 40);
  const growth = Math.log2(normalizedZoom + 1);
  return {
    carWidth: clamp(5 + growth, 5.8, 10.5),
    carLength: clamp(8.5 + growth * 2.4, 10.5, 21.5),
    pedestrianRadius: clamp(2.75 + growth * 0.48, 3.2, 5.4),
    outlineWidth: clamp(0.45 + growth * 0.04, 0.5, 0.7),
  };
}

export const POI_CATEGORY_STYLE = {
  transit: { label: "Közösségi közlekedés", color: "#66b8ff", priority: 10 },
  parking: { label: "Parkolás", color: "#b89cff", priority: 9 },
  shopping: { label: "Vásárlás", color: "#ffca62", priority: 8 },
  food: { label: "Vendéglátás", color: "#ff8a72", priority: 7 },
  health: { label: "Egészségügy", color: "#ff6f9d", priority: 7 },
  education: { label: "Oktatás", color: "#8fd46b", priority: 6 },
  leisure: { label: "Szabadidő", color: "#56d5b2", priority: 6 },
  service: { label: "Szolgáltatás", color: "#e49be8", priority: 5 },
  tourism: { label: "Turizmus", color: "#e7d083", priority: 5 },
  other: { label: "Egyéb", color: "#aabbb5", priority: 1 },
};

// Fixed metre-based cells keep each LOD's winner independent from the viewport origin.
export const POI_LOD_LEVELS = Object.freeze([
  Object.freeze({ minZoom: 0.95, cellSize: 720, labelCellSize: 0 }),
  Object.freeze({ minZoom: 1.5, cellSize: 300, labelCellSize: 0 }),
  Object.freeze({ minZoom: 3, cellSize: 105, labelCellSize: 0 }),
  Object.freeze({ minZoom: 7, cellSize: 34, labelCellSize: 150 }),
  Object.freeze({ minZoom: 14, cellSize: 15, labelCellSize: 75 }),
  Object.freeze({ minZoom: 28, cellSize: 7, labelCellSize: 36 }),
]);

const PEDESTRIAN_HIGHWAYS = new Set([
  "bridleway",
  "corridor",
  "footway",
  "path",
  "pedestrian",
  "platform",
  "steps",
]);

export function roadModeForSegment(segment) {
  const values = new Set((segment.modes || []).map((mode) => String(mode).toLowerCase()));
  const car = values.has("car") || values.has("motorcar") || values.has("vehicle");
  const pedestrian = values.has("pedestrian") || values.has("ped") || values.has("foot");
  if (car && pedestrian) {
    return "mixed";
  }
  if (car) {
    return "car";
  }
  if (pedestrian) {
    return "pedestrian";
  }
  if (PEDESTRIAN_HIGHWAYS.has(segment.highway)) {
    return "pedestrian";
  }
  return segment.highway ? "mixed" : "unknown";
}

function poiStyle(category) {
  return POI_CATEGORY_STYLE[category] || POI_CATEGORY_STYLE.other;
}

export function poiLodForZoom(zoom) {
  for (let index = POI_LOD_LEVELS.length - 1; index >= 0; index -= 1) {
    if (zoom >= POI_LOD_LEVELS[index].minZoom) {
      return { ...POI_LOD_LEVELS[index], index };
    }
  }
  return null;
}

function poiCellKey(world, cellSize) {
  return `${Math.floor(world.x / cellSize)}:${Math.floor(world.y / cellSize)}`;
}

function comparePoiEntries(left, right) {
  return right.rank - left.rank || left.stableKey.localeCompare(right.stableKey);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function stableRoadRank(value) {
  let hash = 2_166_136_261;
  for (const character of String(value ?? "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash / 4_294_967_296;
}

export function roadLodFraction(priority, zoom) {
  const normalizedPriority = Number(priority);
  const normalizedZoom = Number(zoom);
  if (normalizedPriority >= 2) {
    return 1;
  }
  if (normalizedPriority === 1) {
    return clamp((normalizedZoom - 1.1) / 0.8, 0, 1);
  }
  return clamp((normalizedZoom - 2.4) / 0.8, 0, 1);
}

export function roadVisibleAtZoom(entry, zoom) {
  const fraction = roadLodFraction(entry?.style?.priority, zoom);
  return fraction >= 1 || (fraction > 0 && Number(entry?.lodRank) < fraction);
}

export function viewportPreviewTransform(previousView, nextView, width, height) {
  const ratio = nextView.scale / previousView.scale;
  return {
    ratio,
    translateX: (Number(width) / 2) * (1 - ratio)
      + (previousView.centerX - nextView.centerX) * nextView.scale,
    translateY: (Number(height) / 2) * (1 - ratio)
      + (previousView.centerY - nextView.centerY) * nextView.scale,
  };
}

export function baseOverscanForViewport(width, height) {
  return clamp(
    Math.round(Math.min(Number(width), Number(height)) * 0.5),
    160,
    512,
  );
}

function pointToSegmentDistance(pointX, pointY, startX, startY, endX, endY) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  if (squaredLength === 0) {
    return Math.hypot(pointX - startX, pointY - startY);
  }
  const ratio = clamp(
    ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / squaredLength,
    0,
    1,
  );
  return Math.hypot(pointX - (startX + ratio * deltaX), pointY - (startY + ratio * deltaY));
}

export class LocalTrafficMap {
  constructor(container, network, { onFeatureSelect, agentColorModes } = {}) {
    this.container = container;
    this.network = network;
    this.onFeatureSelect = onFeatureSelect;
    this.nodes = new Map();
    this.nodeWorld = new Map();
    this.segments = network.segments || [];
    this.segmentEntries = [];
    this.segmentGrid = new Map();
    this.gridCellSize = 250;
    this.segmentVisibilityMarks = new Uint32Array(0);
    this.segmentVisibilityGeneration = 0;
    this.pois = (network.pois || []).filter((poi) => (
      Number.isFinite(Number(poi.lat)) && Number.isFinite(Number(poi.lng))
    ));
    this.poiEntries = [];
    this.poiLodIndices = POI_LOD_LEVELS.map(() => ({ markerCells: new Map(), labelCells: new Map() }));
    this.activePoiCategories = new Set(this.pois.map((poi) => poi.category || "other"));
    this.poiVisibilityCache = null;
    this.renderedPois = [];
    this.renderedAgents = [];
    this.agentRenderCache = new Map();
    this.overviewColorBatches = new Map();
    this.waitingAgentScreens = { car: [], pedestrian: [] };
    this.agentColorModes = normalizeAgentColorModes(agentColorModes);
    this.turnEdges = (network.edges || []).filter((edge) => edge.turnLanes?.length);
    this.agents = [];
    this.previousAgents = new Map();
    this.selectedAgentId = null;
    this.selectedRouteMode = null;
    this.selectedRouteToken = null;
    this.selectedRouteIndex = 0;
    this.previousSelectedRouteIndex = 0;
    this.selectedRouteWorldNodes = [];
    this.interpolationResetAgentIds = new Set();
    this.transitionStarted = 0;
    this.lastAgentSnapshotAt = null;
    this.agentFrameIntervalMs = DEFAULT_AGENT_FRAME_INTERVAL_MS;
    this.agentTransitionDurationMs = agentTransitionDuration(this.agentFrameIntervalMs);
    this.agentAnimationActive = false;
    this.animationFrame = null;
    this.lastAgentDrawAt = Number.NEGATIVE_INFINITY;
    this.viewportAnimationFrame = null;
    this.viewportCommitTimer = null;
    this.viewportInteraction = null;
    this.baseRenderView = null;
    this.agentRenderView = null;
    this.staticRenderWorker = null;
    this.staticRenderReady = false;
    this.staticRenderPending = false;
    this.staticRenderPendingRequestId = null;
    this.staticRenderPendingView = null;
    this.staticRenderPendingRevision = null;
    this.staticRenderTimeout = null;
    this.staticRenderQueued = false;
    this.staticRenderRevision = 0;
    this.staticRenderRequestId = 0;
    this.staticRenderMetadata = new Map();
    this.destroyed = false;
    this.dragState = null;
    this.zoom = 1;
    this.scale = 1;
    this.fitScale = 1;
    this.centerX = 0;
    this.centerY = 0;
    this.width = 1;
    this.height = 1;

    const bounds = network.meta?.bounds || this.computeBounds(network.nodes || []);
    this.bounds = bounds;
    this.referenceLatitude = (bounds.south + bounds.north) / 2;
    this.metersPerLongitudeDegree = 111_320 * Math.cos((this.referenceLatitude * Math.PI) / 180);
    this.worldWidth = Math.max(1, (bounds.east - bounds.west) * this.metersPerLongitudeDegree);
    this.worldHeight = Math.max(1, (bounds.north - bounds.south) * 111_320);

    for (const rawNode of network.nodes || []) {
      const id = Number(rawNode.id);
      this.nodes.set(id, rawNode);
      this.nodeWorld.set(id, this.coordinateToWorld(rawNode.lat, rawNode.lng));
    }
    this.buildSpatialIndex();
    this.buildPoiSpatialIndex();

    this.baseCanvas = document.createElement("canvas");
    this.baseCanvas.className = "local-map-canvas local-map-base";
    this.agentCanvas = document.createElement("canvas");
    this.agentCanvas.className = "local-map-canvas local-map-agents";
    this.container.replaceChildren(this.baseCanvas, this.agentCanvas);
    // A desynchronized context may publish a new bitmap before the matching CSS
    // transform reaches Chrome's compositor, which presents as a one-frame snap.
    this.baseContext = this.baseCanvas.getContext("2d", { alpha: false });
    this.agentContext = this.agentCanvas.getContext("2d", { alpha: true });
    this.initializeStaticRenderer();

    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handlePointerCancel = this.handlePointerCancel.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.handleDoubleClick = this.fit.bind(this);
    this.container.addEventListener("pointerdown", this.handlePointerDown);
    this.container.addEventListener("pointermove", this.handlePointerMove);
    this.container.addEventListener("pointerup", this.handlePointerUp);
    this.container.addEventListener("pointercancel", this.handlePointerCancel);
    this.container.addEventListener("wheel", this.handleWheel, { passive: false });
    this.container.addEventListener("dblclick", this.handleDoubleClick);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize(true);
  }

  computeBounds(nodes) {
    const latitudes = nodes.map((node) => Number(node.lat));
    const longitudes = nodes.map((node) => Number(node.lng));
    return {
      south: Math.min(...latitudes),
      north: Math.max(...latitudes),
      west: Math.min(...longitudes),
      east: Math.max(...longitudes),
    };
  }

  coordinateToWorld(latitude, longitude) {
    return {
      x: (Number(longitude) - this.bounds.west) * this.metersPerLongitudeDegree,
      y: (this.bounds.north - Number(latitude)) * 111_320,
    };
  }

  worldToScreen(world) {
    return {
      x: (world.x - this.centerX) * this.scale + this.width / 2,
      y: (world.y - this.centerY) * this.scale + this.height / 2,
    };
  }

  screenToWorld(x, y) {
    return {
      x: this.centerX + (x - this.width / 2) / this.scale,
      y: this.centerY + (y - this.height / 2) / this.scale,
    };
  }

  buildSpatialIndex() {
    const lodRanksByWay = new Map();
    for (const segment of this.segments) {
      const start = this.nodeWorld.get(Number(segment.from));
      const end = this.nodeWorld.get(Number(segment.to));
      if (!start || !end) {
        continue;
      }
      const style = HIGHWAY_STYLE[segment.highway] || DEFAULT_STYLE;
      const mode = roadModeForSegment(segment);
      const modeStyle = ROAD_MODE_STYLE[mode];
      const totalLanes = Math.max(1, Number(segment.totalLanes || 1));
      const wayKey = String(segment.wayId ?? segment.id ?? this.segmentEntries.length);
      if (!lodRanksByWay.has(wayKey)) {
        lodRanksByWay.set(wayKey, stableRoadRank(wayKey));
      }
      const entry = {
        segment,
        start,
        end,
        style,
        mode,
        modeStyle,
        totalLanes,
        supportsCars: mode === "car" || mode === "mixed",
        lodRank: lodRanksByWay.get(wayKey),
        overviewKey: `${modeStyle.color}:${style.width}:${modeStyle.dash.join(",")}`,
        minimumX: Math.min(start.x, end.x),
        maximumX: Math.max(start.x, end.x),
        minimumY: Math.min(start.y, end.y),
        maximumY: Math.max(start.y, end.y),
      };
      const entryIndex = this.segmentEntries.length;
      this.segmentEntries.push(entry);
      const firstColumn = Math.floor(entry.minimumX / this.gridCellSize);
      const lastColumn = Math.floor(entry.maximumX / this.gridCellSize);
      const firstRow = Math.floor(entry.minimumY / this.gridCellSize);
      const lastRow = Math.floor(entry.maximumY / this.gridCellSize);
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        for (let row = firstRow; row <= lastRow; row += 1) {
          const key = `${column}:${row}`;
          if (!this.segmentGrid.has(key)) {
            this.segmentGrid.set(key, []);
          }
          this.segmentGrid.get(key).push(entryIndex);
        }
      }
    }
    this.segmentVisibilityMarks = new Uint32Array(this.segmentEntries.length);
    this.segmentVisibilityGeneration = 0;
  }

  initializeStaticRenderer() {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
      return false;
    }
    try {
      const count = this.segmentEntries.length;
      const segmentGeometry = new Float32Array(count * 4);
      const segmentWidths = new Float32Array(count);
      const segmentPriorities = new Uint8Array(count);
      const segmentModes = new Uint8Array(count);
      const segmentLanes = new Uint8Array(count);
      const segmentLodRanks = new Float32Array(count);
      const segmentCarSupport = new Uint8Array(count);
      for (let index = 0; index < count; index += 1) {
        const entry = this.segmentEntries[index];
        const offset = index * 4;
        segmentGeometry[offset] = entry.start.x;
        segmentGeometry[offset + 1] = entry.start.y;
        segmentGeometry[offset + 2] = entry.end.x;
        segmentGeometry[offset + 3] = entry.end.y;
        segmentWidths[index] = entry.style.width;
        segmentPriorities[index] = entry.style.priority;
        segmentModes[index] = ROAD_MODE_RENDER_INDEX[entry.mode]
          ?? ROAD_MODE_RENDER_INDEX.unknown;
        segmentLanes[index] = clamp(entry.totalLanes, 1, 255);
        segmentLodRanks[index] = entry.lodRank;
        segmentCarSupport[index] = entry.supportsCars ? 1 : 0;
      }

      const turnGeometryValues = [];
      const turnLaneValues = [];
      const turnDirectionValues = [];
      for (const edge of this.turnEdges) {
        const start = this.nodeWorld.get(Number(edge.from));
        const end = this.nodeWorld.get(Number(edge.to));
        if (!start || !end) {
          continue;
        }
        const laneCount = Math.max(1, Number(edge.lanes || edge.turnLanes.length));
        const visibleLaneCount = Math.min(laneCount, edge.turnLanes.length);
        for (let laneIndex = 0; laneIndex < visibleLaneCount; laneIndex += 1) {
          const tokens = (edge.turnLanes[laneIndex] || []).map((token) => String(token).toLowerCase());
          let directions = 0;
          if (tokens.some((token) => token === "through" || token === "straight")) {
            directions |= 1;
          }
          if (tokens.some((token) => token.includes("left"))) {
            directions |= 2;
          }
          if (tokens.some((token) => token.includes("right"))) {
            directions |= 4;
          }
          if (directions === 0) {
            continue;
          }
          turnGeometryValues.push(start.x, start.y, end.x, end.y);
          turnLaneValues.push(laneIndex, laneCount);
          turnDirectionValues.push(directions);
        }
      }
      const turnGeometry = new Float32Array(turnGeometryValues);
      const turnLaneData = new Uint8Array(turnLaneValues);
      const turnDirections = new Uint8Array(turnDirectionValues);

      const worker = new Worker(
        new URL("./static-map-worker.js", import.meta.url),
        { type: "module", name: "ujbuda-static-map" },
      );
      this.staticRenderWorker = worker;
      worker.addEventListener("message", (event) => {
        if (worker !== this.staticRenderWorker) {
          event.data?.bitmap?.close?.();
          return;
        }
        this.handleStaticRendererMessage(event);
      });
      worker.addEventListener("error", () => {
        if (this.destroyed || worker !== this.staticRenderWorker) {
          return;
        }
        this.fallbackFromStaticRendererFailure();
      });
      const arrays = {
        segmentGeometry,
        segmentWidths,
        segmentPriorities,
        segmentModes,
        segmentLanes,
        segmentLodRanks,
        segmentCarSupport,
        turnGeometry,
        turnLaneData,
        turnDirections,
      };
      worker.postMessage(
        { type: "initialize", ...arrays },
        Object.values(arrays).map((array) => array.buffer),
      );
      this.staticRenderTimeout = setTimeout(
        () => this.handleStaticRendererInitializationTimeout(worker),
        STATIC_RENDER_TIMEOUT_MS,
      );
      return true;
    } catch {
      this.disableStaticRenderer();
      return false;
    }
  }

  handleStaticRendererInitializationTimeout(worker) {
    if (
      this.destroyed
      || worker !== this.staticRenderWorker
      || this.staticRenderReady
    ) {
      return;
    }
    this.fallbackFromStaticRendererFailure();
  }

  disableStaticRenderer() {
    if (this.staticRenderTimeout !== null) {
      clearTimeout(this.staticRenderTimeout);
      this.staticRenderTimeout = null;
    }
    this.staticRenderWorker?.terminate();
    this.staticRenderWorker = null;
    this.staticRenderReady = false;
    this.staticRenderPending = false;
    this.staticRenderPendingRequestId = null;
    this.staticRenderPendingView = null;
    this.staticRenderPendingRevision = null;
    this.staticRenderQueued = false;
    this.staticRenderMetadata.clear();
  }

  fallbackFromStaticRendererFailure() {
    const needsFallbackCommit = Boolean(this.viewportInteraction);
    const deferUntilGestureEnd = needsFallbackCommit && this.viewportGestureActive();
    this.disableStaticRenderer();
    if (deferUntilGestureEnd) {
      // Keep transforming the last coherent pair of layers. Pointer-up or the
      // wheel idle timer will perform the single main-thread fallback commit.
      this.applyViewportTransform();
    } else if (needsFallbackCommit) {
      this.finishViewportInteraction();
    } else {
      this.drawBase();
    }
  }

  staticViewSnapshot() {
    return {
      width: this.width,
      height: this.height,
      padding: this.baseOverscan || 0,
      pixelRatio: this.basePixelRatio || this.pixelRatio || 1,
      centerX: this.centerX,
      centerY: this.centerY,
      scale: this.scale,
      zoom: this.zoom,
    };
  }

  staticPoiPayload(view) {
    const level = poiLodForZoom(view.zoom);
    if (!level || !this.activePoiCategories.size) {
      return { payload: [], entries: [], radius: 0 };
    }
    const entries = this.visiblePoiEntries(level, view.padding + 30);
    const payload = entries.map((entry) => {
      const name = String(entry.poi.name || "").trim();
      return {
        x: entry.world.x,
        y: entry.world.y,
        color: poiStyle(entry.category).color,
        name,
        label: Boolean(name && this.isPoiLabelWinner(entry, level)),
      };
    });
    return {
      payload,
      entries,
      radius: clamp(2.4 + Math.log2(view.zoom + 1) * 0.45, 3, 5.2),
    };
  }

  requestStaticRender() {
    if (!this.staticRenderReady || !this.staticRenderWorker) {
      return false;
    }
    if (this.staticRenderPending) {
      if (
        this.staticRenderPendingRevision === this.staticRenderRevision
        && this.staticViewMatches(this.staticRenderPendingView)
      ) {
        return true;
      }
      this.staticRenderQueued = true;
      return true;
    }
    const requestId = ++this.staticRenderRequestId;
    const view = this.staticViewSnapshot();
    const pois = this.staticPoiPayload(view);
    this.staticRenderMetadata.set(requestId, {
      entries: pois.entries,
      radius: pois.radius,
      revision: this.staticRenderRevision,
    });
    this.staticRenderPending = true;
    this.staticRenderPendingRequestId = requestId;
    this.staticRenderPendingView = view;
    this.staticRenderPendingRevision = this.staticRenderRevision;
    try {
      this.staticRenderWorker.postMessage({
        type: "render",
        requestId,
        view,
        pois: pois.payload,
      });
      this.staticRenderTimeout = setTimeout(
        () => this.handleStaticRenderTimeout(requestId),
        STATIC_RENDER_TIMEOUT_MS,
      );
      return true;
    } catch {
      this.disableStaticRenderer();
      return false;
    }
  }

  handleStaticRenderTimeout(requestId) {
    if (
      this.destroyed
      || !this.staticRenderPending
      || this.staticRenderPendingRequestId !== requestId
    ) {
      return;
    }
    this.fallbackFromStaticRendererFailure();
  }

  handleStaticRendererMessage(event) {
    const message = event.data || {};
    if (this.destroyed) {
      message.bitmap?.close?.();
      return;
    }
    if (message.type === "ready") {
      if (this.staticRenderTimeout !== null) {
        clearTimeout(this.staticRenderTimeout);
        this.staticRenderTimeout = null;
      }
      this.staticRenderReady = true;
      if (this.viewportGestureActive()) {
        this.staticRenderQueued = true;
        return;
      }
      this.requestStaticRender();
      return;
    }
    if (message.type === "error") {
      if (
        message.requestId !== null
        && message.requestId !== undefined
        && message.requestId !== this.staticRenderPendingRequestId
      ) {
        return;
      }
      this.fallbackFromStaticRendererFailure();
      return;
    }
    if (message.type !== "rendered") {
      return;
    }
    if (message.requestId !== this.staticRenderPendingRequestId) {
      this.staticRenderMetadata.delete(message.requestId);
      message.bitmap?.close?.();
      return;
    }

    if (this.staticRenderTimeout !== null) {
      clearTimeout(this.staticRenderTimeout);
      this.staticRenderTimeout = null;
    }
    this.staticRenderPending = false;
    this.staticRenderPendingRequestId = null;
    this.staticRenderPendingView = null;
    this.staticRenderPendingRevision = null;
    const metadata = this.staticRenderMetadata.get(message.requestId);
    this.staticRenderMetadata.delete(message.requestId);
    for (const requestId of this.staticRenderMetadata.keys()) {
      if (requestId < message.requestId) {
        this.staticRenderMetadata.delete(requestId);
      }
    }
    const view = message.view;
    const compatibleSize = view
      && view.width === this.width
      && view.height === this.height
      && view.padding === this.baseOverscan
      && Math.abs(view.pixelRatio - this.basePixelRatio) < 1e-9;
    const contentCurrent = metadata?.revision === this.staticRenderRevision;
    const viewCurrent = compatibleSize && contentCurrent && this.staticViewMatches(view);
    const gestureActive = this.viewportGestureActive();
    const canAccept = compatibleSize
      && contentCurrent
      && message.bitmap
      && viewCurrent
      && !gestureActive;
    if (!canAccept) {
      message.bitmap?.close?.();
      this.staticRenderQueued = true;
      if (this.viewportInteraction) {
        this.applyViewportTransform();
      }
      if (gestureActive) {
        return;
      }
      this.staticRenderQueued = false;
      const followupScheduled = this.requestStaticRender();
      if (!followupScheduled) {
        if (this.viewportInteraction) {
          this.finishViewportInteraction();
        } else {
          this.drawBase();
        }
      }
      return;
    }

    try {
      const context = this.baseContext;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.drawImage(
        message.bitmap,
        0,
        0,
        this.baseCanvas.width,
        this.baseCanvas.height,
      );
      this.baseRenderView = view;
      this.refreshRenderedPois(metadata?.entries || [], view, metadata?.radius || 0);
    } catch {
      this.fallbackFromStaticRendererFailure();
      return;
    } finally {
      message.bitmap.close?.();
    }

    this.staticRenderQueued = false;
    if (this.viewportInteraction) {
      this.commitViewportInteraction();
    } else {
      this.baseCanvas.style.transform = "none";
    }
  }

  staticViewMatches(view) {
    if (!view) {
      return false;
    }
    return (
      Math.abs(view.centerX - this.centerX) < 1e-6
      && Math.abs(view.centerY - this.centerY) < 1e-6
      && Math.abs(view.scale - this.scale) < Math.max(1e-12, this.scale * 1e-9)
      && Math.abs(view.zoom - this.zoom) < 1e-9
    );
  }

  refreshRenderedPois(entries, view, radius) {
    this.renderedPois = entries.map((entry) => ({
      poi: entry.poi,
      screen: {
        x: (entry.world.x - view.centerX) * view.scale + view.width / 2,
        y: (entry.world.y - view.centerY) * view.scale + view.height / 2,
      },
      radius: radius + 5,
    }));
  }

  buildPoiSpatialIndex() {
    this.poiEntries = [];
    this.poiLodIndices = POI_LOD_LEVELS.map(() => ({ markerCells: new Map(), labelCells: new Map() }));
    const ranked = this.pois.map((poi) => {
      const category = poi.category || "other";
      const world = this.coordinateToWorld(poi.lat, poi.lng);
      const style = poiStyle(category);
      const rawWeight = Number(poi.weight || 0);
      const fallbackKey = [
        poi.osmType || "",
        poi.osmId || "",
        Number(poi.lat).toFixed(7),
        Number(poi.lng).toFixed(7),
        poi.name || "",
        poi.subtype || "",
        category,
      ].join("|");
      return {
        poi,
        category,
        world,
        rank: (Number.isFinite(rawWeight) ? rawWeight : 0) + style.priority,
        stableKey: String(poi.id ?? fallbackKey),
      };
    }).sort(comparePoiEntries);

    for (const entry of ranked) {
      this.poiEntries.push(entry);
      for (let index = 0; index < POI_LOD_LEVELS.length; index += 1) {
        const level = POI_LOD_LEVELS[index];
        const markerCells = this.poiLodIndices[index].markerCells;
        const markerKey = poiCellKey(entry.world, level.cellSize);
        if (!markerCells.has(markerKey)) {
          markerCells.set(markerKey, []);
        }
        markerCells.get(markerKey).push(entry);

        if (level.labelCellSize > 0 && String(entry.poi.name || "").trim()) {
          const labelCells = this.poiLodIndices[index].labelCells;
          const labelKey = poiCellKey(entry.world, level.labelCellSize);
          if (!labelCells.has(labelKey)) {
            labelCells.set(labelKey, []);
          }
          labelCells.get(labelKey).push(entry);
        }
      }
    }
  }

  visibleSegmentEntries(paddingPixels = 40) {
    if (this.zoom <= 3) {
      return this.segmentEntries;
    }
    const first = this.screenToWorld(-paddingPixels, -paddingPixels);
    const last = this.screenToWorld(this.width + paddingPixels, this.height + paddingPixels);
    const minimumX = Math.min(first.x, last.x);
    const maximumX = Math.max(first.x, last.x);
    const minimumY = Math.min(first.y, last.y);
    const maximumY = Math.max(first.y, last.y);
    const firstColumn = Math.floor(minimumX / this.gridCellSize);
    const lastColumn = Math.floor(maximumX / this.gridCellSize);
    const firstRow = Math.floor(minimumY / this.gridCellSize);
    const lastRow = Math.floor(maximumY / this.gridCellSize);
    this.segmentVisibilityGeneration = (this.segmentVisibilityGeneration + 1) >>> 0;
    if (this.segmentVisibilityGeneration === 0) {
      this.segmentVisibilityMarks.fill(0);
      this.segmentVisibilityGeneration = 1;
    }
    const generation = this.segmentVisibilityGeneration;
    const entries = [];
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      for (let row = firstRow; row <= lastRow; row += 1) {
        for (const index of this.segmentGrid.get(`${column}:${row}`) || []) {
          if (this.segmentVisibilityMarks[index] === generation) {
            continue;
          }
          this.segmentVisibilityMarks[index] = generation;
          entries.push(this.segmentEntries[index]);
        }
      }
    }
    return entries;
  }

  visiblePoiEntries(level, paddingPixels = 30) {
    if (!level || !this.poiEntries.length || !this.activePoiCategories.size) {
      return [];
    }
    const first = this.screenToWorld(-paddingPixels, -paddingPixels);
    const last = this.screenToWorld(this.width + paddingPixels, this.height + paddingPixels);
    const minimumX = Math.min(first.x, last.x);
    const maximumX = Math.max(first.x, last.x);
    const minimumY = Math.min(first.y, last.y);
    const maximumY = Math.max(first.y, last.y);
    const firstColumn = Math.floor(minimumX / level.cellSize);
    const lastColumn = Math.floor(maximumX / level.cellSize);
    const firstRow = Math.floor(minimumY / level.cellSize);
    const lastRow = Math.floor(maximumY / level.cellSize);
    const categoryKey = JSON.stringify([...this.activePoiCategories].sort());
    const cacheKey = `${level.index}:${firstColumn}:${lastColumn}:${firstRow}:${lastRow}:${categoryKey}`;
    if (this.poiVisibilityCache?.key === cacheKey) {
      return this.poiVisibilityCache.entries;
    }
    const markerCells = this.poiLodIndices[level.index].markerCells;
    const entries = [];
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      for (let row = firstRow; row <= lastRow; row += 1) {
        const candidates = markerCells.get(`${column}:${row}`);
        const winner = candidates?.find((entry) => this.activePoiCategories.has(entry.category));
        if (winner) {
          entries.push(winner);
        }
      }
    }
    entries.sort(comparePoiEntries);
    this.poiVisibilityCache = { key: cacheKey, entries };
    return entries;
  }

  isPoiLabelWinner(entry, level) {
    if (!level?.labelCellSize) {
      return false;
    }
    const labelCells = this.poiLodIndices[level.index].labelCells;
    const candidates = labelCells.get(poiCellKey(entry.world, level.labelCellSize));
    return candidates?.find((candidate) => this.activePoiCategories.has(candidate.category)) === entry;
  }

  setPoiCategories(categories) {
    this.activePoiCategories = new Set(categories);
    this.poiVisibilityCache = null;
    this.staticRenderRevision = Number(this.staticRenderRevision || 0) + 1;
    if (this.viewportInteraction && this.viewportGestureActive()) {
      this.staticRenderQueued = true;
      return;
    }
    if (this.staticRenderReady && this.requestStaticRender()) {
      return;
    }
    if (this.viewportInteraction) {
      this.finishViewportInteraction({ redraw: false });
    }
    this.drawBase();
  }

  resize(initial = false) {
    if (this.viewportInteraction) {
      this.finishViewportInteraction({ redraw: false });
    }
    const rectangle = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rectangle.width));
    this.height = Math.max(1, Math.round(rectangle.height));
    this.containerLeft = rectangle.left;
    this.containerTop = rectangle.top;
    const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.basePixelRatio = Math.min(devicePixelRatio, BASE_CANVAS_MAX_PIXEL_RATIO);
    this.agentPixelRatio = Math.min(devicePixelRatio, AGENT_CANVAS_MAX_PIXEL_RATIO);
    // The static canvas deliberately extends beyond the viewport. During a gesture
    // Chrome can move this already-rasterized image on the compositor without
    // exposing an empty strip or rebuilding tens of thousands of road segments.
    this.baseOverscan = baseOverscanForViewport(this.width, this.height);
    const baseWidth = this.width + this.baseOverscan * 2;
    const baseHeight = this.height + this.baseOverscan * 2;
    const resizeCanvas = (canvas, width, height, pixelRatio) => {
      const backingWidth = Math.round(width * pixelRatio);
      const backingHeight = Math.round(height * pixelRatio);
      if (canvas.width !== backingWidth) {
        canvas.width = backingWidth;
      }
      if (canvas.height !== backingHeight) {
        canvas.height = backingHeight;
      }
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    resizeCanvas(this.baseCanvas, baseWidth, baseHeight, this.basePixelRatio);
    resizeCanvas(this.agentCanvas, this.width, this.height, this.agentPixelRatio);
    this.baseCanvas.style.left = `${-this.baseOverscan}px`;
    this.baseCanvas.style.top = `${-this.baseOverscan}px`;
    this.baseCanvas.style.transformOrigin = `${this.baseOverscan}px ${this.baseOverscan}px`;
    this.agentCanvas.style.left = "0px";
    this.agentCanvas.style.top = "0px";
    this.agentCanvas.style.transformOrigin = "0 0";
    // Kept as an alias for tests and integrations written before the canvases
    // received separate pixel-density budgets.
    this.pixelRatio = this.agentPixelRatio;
    if (initial || !Number.isFinite(this.fitScale)) {
      this.fit();
    } else {
      this.fitScale = Math.min(
        (this.width * 0.92) / this.worldWidth,
        (this.height * 0.92) / this.worldHeight,
      );
      this.scale = this.fitScale * this.zoom;
      this.drawBase();
      this.drawAgents(performance.now());
    }
  }

  fit() {
    const renderAsynchronously = Boolean(this.staticRenderReady && this.baseRenderView);
    if (renderAsynchronously) {
      this.beginViewportInteraction();
    } else if (this.viewportInteraction) {
      this.finishViewportInteraction({ redraw: false });
    }
    this.fitScale = Math.min(
      (this.width * 0.92) / this.worldWidth,
      (this.height * 0.92) / this.worldHeight,
    );
    this.zoom = 1;
    this.scale = this.fitScale;
    this.centerX = this.worldWidth / 2;
    this.centerY = this.worldHeight / 2;
    if (renderAsynchronously) {
      this.applyViewportTransform();
      this.finishViewportInteraction();
      return;
    }
    this.drawBase();
    this.drawAgents(performance.now());
  }

  handlePointerDown(event) {
    this.container.setPointerCapture(event.pointerId);
    this.dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      viewChanged: false,
    };
  }

  handlePointerMove(event) {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - this.dragState.lastX;
    const deltaY = event.clientY - this.dragState.lastY;
    if (Math.hypot(event.clientX - this.dragState.startX, event.clientY - this.dragState.startY) > 3) {
      this.dragState.moved = true;
    }
    this.dragState.lastX = event.clientX;
    this.dragState.lastY = event.clientY;
    if (deltaX === 0 && deltaY === 0) {
      return;
    }
    this.beginViewportInteraction();
    this.dragState.viewChanged = true;
    this.centerX -= deltaX / this.scale;
    this.centerY -= deltaY / this.scale;
    this.scheduleViewportDraw();
  }

  handlePointerUp(event) {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) {
      return;
    }
    const viewChanged = this.dragState.viewChanged;
    if (!this.dragState.moved && !viewChanged) {
      const rectangle = this.container.getBoundingClientRect();
      this.inspectAt(event.clientX - rectangle.left, event.clientY - rectangle.top);
    }
    this.dragState = null;
    if (this.container.hasPointerCapture(event.pointerId)) {
      this.container.releasePointerCapture(event.pointerId);
    }
    if (viewChanged) {
      this.finishViewportInteraction();
    }
  }

  handlePointerCancel(event) {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) {
      return;
    }
    this.dragState = null;
    if (this.container.hasPointerCapture(event.pointerId)) {
      this.container.releasePointerCapture(event.pointerId);
    }
    this.finishViewportInteraction();
  }

  handleWheel(event) {
    event.preventDefault();
    this.beginViewportInteraction();
    // The panel can move without a ResizeObserver notification (scroll/layout).
    // Re-read the rect so zoom remains anchored under the actual cursor.
    const rectangle = this.container.getBoundingClientRect();
    this.containerLeft = rectangle.left;
    this.containerTop = rectangle.top;
    const cursorX = event.clientX - rectangle.left;
    const cursorY = event.clientY - rectangle.top;
    const worldBefore = this.screenToWorld(cursorX, cursorY);
    const factor = Math.exp(-event.deltaY * 0.0014);
    this.zoom = clamp(this.zoom * factor, 0.8, 40);
    this.scale = this.fitScale * this.zoom;
    this.centerX = worldBefore.x - (cursorX - this.width / 2) / this.scale;
    this.centerY = worldBefore.y - (cursorY - this.height / 2) / this.scale;
    this.scheduleViewportDraw();
    this.scheduleViewportCommit();
  }

  beginViewportInteraction() {
    if (this.viewportCommitTimer !== null) {
      clearTimeout(this.viewportCommitTimer);
      this.viewportCommitTimer = null;
    }
    this.agentAnimationActive = false;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    if (this.viewportInteraction) {
      return;
    }
    this.viewportInteraction = {
      centerX: this.centerX,
      centerY: this.centerY,
      scale: this.scale,
    };
    this.container.classList.add("viewport-interacting");
  }

  scheduleViewportCommit() {
    if (this.viewportCommitTimer !== null) {
      clearTimeout(this.viewportCommitTimer);
    }
    this.viewportCommitTimer = setTimeout(() => {
      this.viewportCommitTimer = null;
      this.finishViewportInteraction();
    }, VIEWPORT_COMMIT_DELAY_MS);
  }

  applyViewportTransform() {
    if (!this.viewportInteraction) {
      return;
    }
    // Exact commits keep both canvases in the same source view. Reusing one
    // matrix also prevents sub-pixel compositor rounding from separating agents
    // from the underlying road while zooming.
    const sourceView = this.baseRenderView || this.agentRenderView || this.viewportInteraction;
    const transform = viewportPreviewTransform(
      sourceView,
      this,
      this.width,
      this.height,
    );
    const matrix = `matrix(${transform.ratio}, 0, 0, ${transform.ratio}, ${transform.translateX}, ${transform.translateY})`;
    this.baseCanvas.style.transform = matrix;
    this.agentCanvas.style.transform = matrix;
  }

  finishViewportInteraction({ redraw = true } = {}) {
    if (this.viewportCommitTimer !== null) {
      clearTimeout(this.viewportCommitTimer);
      this.viewportCommitTimer = null;
    }
    if (!this.viewportInteraction) {
      return;
    }
    if (this.viewportAnimationFrame !== null) {
      cancelAnimationFrame(this.viewportAnimationFrame);
      this.viewportAnimationFrame = null;
    }
    if (!redraw) {
      this.completeViewportInteraction();
      return;
    }
    if (this.staticRenderReady && this.staticViewMatches(this.baseRenderView)) {
      this.commitViewportInteraction();
      return;
    }
    this.staticRenderQueued = false;
    if (this.staticRenderReady && this.requestStaticRender()) {
      this.applyViewportTransform();
      return;
    }
    this.drawBase();
    this.commitViewportInteraction();
  }

  commitViewportInteraction() {
    const timestamp = performance.now();
    this.previousAgents = new Map(this.agents.map((agent) => [agent.id, agent]));
    this.agentAnimationActive = false;
    this.transitionStarted = timestamp;
    this.previousSelectedRouteIndex = this.selectedRouteIndex;
    this.interpolationResetAgentIds.clear();
    // Base bitmap, agent pixels and both transform resets stay in one browser
    // rendering transaction. Until this point both old layers keep the same CSS
    // preview transform, so agents cannot drift away from their roads.
    this.drawAgents(timestamp);
    this.completeViewportInteraction();
  }

  completeViewportInteraction() {
    this.viewportInteraction = null;
    this.container.classList.remove("viewport-interacting");
    this.baseCanvas.style.transform = "none";
    this.agentCanvas.style.transform = "none";
  }

  viewportGestureActive() {
    return Boolean(this.dragState?.viewChanged || this.viewportCommitTimer != null);
  }

  scheduleViewportDraw() {
    if (this.viewportAnimationFrame !== null) {
      return;
    }
    this.viewportAnimationFrame = requestAnimationFrame((timestamp) => {
      this.viewportAnimationFrame = null;
      if (this.viewportInteraction) {
        this.applyViewportTransform();
        return;
      }
      this.drawBase();
      if (this.animationFrame === null) {
        this.drawAgents(timestamp);
      }
    });
  }

  segmentScreenPoints(segmentOrEntry) {
    const start = segmentOrEntry.start
      || this.nodeWorld.get(Number(segmentOrEntry.from));
    const end = segmentOrEntry.end
      || this.nodeWorld.get(Number(segmentOrEntry.to));
    if (!start || !end) {
      return null;
    }
    return { start: this.worldToScreen(start), end: this.worldToScreen(end) };
  }

  visible(points, padding = 20) {
    return !(
      Math.max(points.start.x, points.end.x) < -padding
      || Math.min(points.start.x, points.end.x) > this.width + padding
      || Math.max(points.start.y, points.end.y) < -padding
      || Math.min(points.start.y, points.end.y) > this.height + padding
    );
  }

  drawBase() {
    const context = this.baseContext;
    if (!context) {
      return;
    }
    const padding = this.baseOverscan || 0;
    const pixelRatio = this.basePixelRatio || this.pixelRatio || 1;
    context.setTransform(
      pixelRatio,
      0,
      0,
      pixelRatio,
      padding * pixelRatio,
      padding * pixelRatio,
    );
    context.fillStyle = "#111b18";
    context.fillRect(
      -padding,
      -padding,
      this.width + padding * 2,
      this.height + padding * 2,
    );

    if (this.zoom < DETAILED_ROAD_MIN_ZOOM) {
      this.drawOverview(context, padding);
    } else {
      this.drawDetailedRoads(context, padding);
    }
    if (this.zoom >= 7) {
      this.drawTurnArrows(context, padding);
    }
    this.drawPois(context, padding);
    this.baseRenderView = this.staticViewSnapshot();
  }

  drawOverview(context, padding = 0) {
    const groups = new Map();
    for (const entry of this.visibleSegmentEntries(padding + 40)) {
      const style = entry.style;
      if (!roadVisibleAtZoom(entry, this.zoom)) {
        continue;
      }
      const startX = (entry.start.x - this.centerX) * this.scale + this.width / 2;
      const startY = (entry.start.y - this.centerY) * this.scale + this.height / 2;
      const endX = (entry.end.x - this.centerX) * this.scale + this.width / 2;
      const endY = (entry.end.y - this.centerY) * this.scale + this.height / 2;
      if (
        Math.max(startX, endX) < -padding - 20
        || Math.min(startX, endX) > this.width + padding + 20
        || Math.max(startY, endY) < -padding - 20
        || Math.min(startY, endY) > this.height + padding + 20
      ) {
        continue;
      }
      if (!groups.has(entry.overviewKey)) {
        groups.set(entry.overviewKey, {
          style,
          modeStyle: entry.modeStyle,
          path: new Path2D(),
        });
      }
      const path = groups.get(entry.overviewKey).path;
      path.moveTo(startX, startY);
      path.lineTo(endX, endY);
    }
    for (const { style, modeStyle, path } of groups.values()) {
      context.strokeStyle = modeStyle.color;
      context.globalAlpha = modeStyle.alpha;
      context.lineWidth = style.width;
      context.lineCap = "butt";
      // At district overview scale color already separates the modes. Avoiding
      // tens of thousands of tiny dash caps removes a large Chrome raster cost.
      context.setLineDash([]);
      context.stroke(path);
    }
    context.setLineDash([]);
    context.globalAlpha = 1;
  }

  drawDetailedRoads(context, padding = 0) {
    const laneWidth = clamp(1.35 + Math.sqrt(this.zoom) * 0.55, 2, 5.2);
    const roadGroups = new Map();
    const laneDividerGroups = new Map();
    for (const entry of this.visibleSegmentEntries(padding + 40)) {
      if (!roadVisibleAtZoom(entry, this.zoom)) {
        continue;
      }
      const startX = (entry.start.x - this.centerX) * this.scale + this.width / 2;
      const startY = (entry.start.y - this.centerY) * this.scale + this.height / 2;
      const endX = (entry.end.x - this.centerX) * this.scale + this.width / 2;
      const endY = (entry.end.y - this.centerY) * this.scale + this.height / 2;
      if (
        Math.max(startX, endX) < -padding - 40
        || Math.min(startX, endX) > this.width + padding + 40
        || Math.max(startY, endY) < -padding - 40
        || Math.min(startY, endY) > this.height + padding + 40
      ) {
        continue;
      }
      const roadWidth = entry.supportsCars
        ? Math.max(entry.style.width * 1.4, entry.totalLanes * laneWidth)
        : Math.max(1.3, entry.style.width * 1.2);
      const groupKey = `${entry.mode}:${roadWidth}`;
      if (!roadGroups.has(groupKey)) {
        roadGroups.set(groupKey, {
          modeStyle: entry.modeStyle,
          roadWidth,
          path: new Path2D(),
        });
      }
      const roadPath = roadGroups.get(groupKey).path;
      roadPath.moveTo(startX, startY);
      roadPath.lineTo(endX, endY);

      if (entry.supportsCars && this.zoom >= 3.5 && entry.totalLanes > 1) {
        const deltaX = endX - startX;
        const deltaY = endY - startY;
        const length = Math.hypot(deltaX, deltaY);
        if (length > 1) {
          const normalX = -deltaY / length;
          const normalY = deltaX / length;
          if (!laneDividerGroups.has(entry.modeStyle.alpha)) {
            laneDividerGroups.set(entry.modeStyle.alpha, new Path2D());
          }
          const dividerPath = laneDividerGroups.get(entry.modeStyle.alpha);
          for (let lane = 1; lane < entry.totalLanes; lane += 1) {
            const offset = (lane - entry.totalLanes / 2) * laneWidth;
            dividerPath.moveTo(startX + normalX * offset, startY + normalY * offset);
            dividerPath.lineTo(endX + normalX * offset, endY + normalY * offset);
          }
        }
      }
    }

    context.lineCap = "butt";
    for (const { roadWidth, path } of roadGroups.values()) {
      context.setLineDash([]);
      context.strokeStyle = "#07100f";
      context.lineWidth = roadWidth + 2.2;
      context.globalAlpha = 0.95;
      context.stroke(path);
    }
    for (const { modeStyle, roadWidth, path } of roadGroups.values()) {
      context.strokeStyle = modeStyle.color;
      context.lineWidth = roadWidth;
      context.globalAlpha = modeStyle.alpha;
      context.setLineDash(modeStyle.dash);
      context.stroke(path);
    }

    context.strokeStyle = "rgba(224, 239, 233, 0.34)";
    context.lineWidth = 0.65;
    context.setLineDash([4, 5]);
    for (const [alpha, path] of laneDividerGroups) {
      context.globalAlpha = alpha;
      context.stroke(path);
    }
    context.setLineDash([]);
    context.globalAlpha = 1;
  }

  drawPois(context, padding = 0) {
    this.renderedPois = [];
    const level = poiLodForZoom(this.zoom);
    if (!level || !this.activePoiCategories.size) {
      return;
    }

    const radius = clamp(2.4 + Math.log2(this.zoom + 1) * 0.45, 3, 5.2);
    const markerGroups = new Map();
    const markerOutline = new Path2D();
    const labels = [];
    for (const entry of this.visiblePoiEntries(level, padding + 30)) {
      const screen = this.worldToScreen(entry.world);
      if (
        screen.x < -padding - 20
        || screen.y < -padding - 20
        || screen.x > this.width + padding + 20
        || screen.y > this.height + padding + 20
      ) {
        continue;
      }

      const name = String(entry.poi.name || "").trim();
      if (name && this.isPoiLabelWinner(entry, level)) {
        labels.push({ name, screen });
      }
      if (!markerGroups.has(entry.category)) {
        markerGroups.set(entry.category, { style: poiStyle(entry.category), path: new Path2D() });
      }
      markerOutline.moveTo(screen.x + radius + 2, screen.y);
      markerOutline.arc(screen.x, screen.y, radius + 2, 0, Math.PI * 2);
      const markerPath = markerGroups.get(entry.category).path;
      markerPath.moveTo(screen.x + radius, screen.y);
      markerPath.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      this.renderedPois.push({ poi: entry.poi, screen, radius: radius + 5 });
    }

    if (!this.renderedPois.length) {
      return;
    }

    context.save();
    context.globalAlpha = 0.96;
    context.fillStyle = "rgba(5, 14, 12, 0.88)";
    context.fill(markerOutline);

    context.strokeStyle = "rgba(237, 248, 243, 0.7)";
    context.lineWidth = 0.7;
    for (const { style, path } of markerGroups.values()) {
      context.fillStyle = style.color;
      context.fill(path);
      context.stroke(path);
    }

    context.font = "600 10px 'Segoe UI', system-ui, sans-serif";
    for (const { name, screen } of labels) {
      const label = name.length > 30 ? `${name.slice(0, 29)}…` : name;
      const textWidth = context.measureText(label).width;
      const labelX = screen.x + radius + 5;
      const labelY = screen.y + 3.5;
      context.fillStyle = "rgba(5, 14, 12, 0.82)";
      context.fillRect(labelX - 3, labelY - 10, textWidth + 6, 14);
      context.fillStyle = "rgba(237, 248, 243, 0.9)";
      context.fillText(label, labelX, labelY);
    }
    context.restore();
  }

  drawTurnArrows(context, padding = 0) {
    const laneWidth = clamp(1.35 + Math.sqrt(this.zoom) * 0.55, 2, 5.2);
    for (const edge of this.turnEdges) {
      const startWorld = this.nodeWorld.get(Number(edge.from));
      const endWorld = this.nodeWorld.get(Number(edge.to));
      if (!startWorld || !endWorld) {
        continue;
      }
      const start = this.worldToScreen(startWorld);
      const end = this.worldToScreen(endWorld);
      const points = { start, end };
      if (!this.visible(points, padding + 30)) {
        continue;
      }
      const deltaX = end.x - start.x;
      const deltaY = end.y - start.y;
      const length = Math.hypot(deltaX, deltaY);
      if (length < 24) {
        continue;
      }
      const angle = Math.atan2(deltaY, deltaX);
      const normalX = -deltaY / length;
      const normalY = deltaX / length;
      const laneCount = Math.max(1, Number(edge.lanes || edge.turnLanes.length));
      for (let laneIndex = 0; laneIndex < Math.min(laneCount, edge.turnLanes.length); laneIndex += 1) {
        const tokens = edge.turnLanes[laneIndex] || [];
        const offset = (laneIndex - (laneCount - 1) / 2) * laneWidth;
        const x = start.x + deltaX * 0.78 + normalX * offset;
        const y = start.y + deltaY * 0.78 + normalY * offset;
        this.drawTurnSymbol(context, x, y, angle, tokens);
      }
    }
  }

  drawTurnSymbol(context, x, y, angle, tokens) {
    const directions = new Set(tokens);
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    context.strokeStyle = "rgba(237, 248, 243, 0.86)";
    context.fillStyle = "rgba(237, 248, 243, 0.86)";
    context.lineWidth = 1;
    context.lineCap = "round";
    const drawHead = (tipX, tipY, directionAngle) => {
      context.save();
      context.translate(tipX, tipY);
      context.rotate(directionAngle);
      context.beginPath();
      context.moveTo(0, 0);
      context.lineTo(-2.8, -1.8);
      context.lineTo(-2.8, 1.8);
      context.closePath();
      context.fill();
      context.restore();
    };
    if (directions.has("through") || directions.has("straight")) {
      context.beginPath();
      context.moveTo(-4, 0);
      context.lineTo(5, 0);
      context.stroke();
      drawHead(5, 0, 0);
    }
    if ([...directions].some((token) => token.includes("left"))) {
      context.beginPath();
      context.moveTo(-4, 0);
      context.lineTo(0, 0);
      context.quadraticCurveTo(3, 0, 3, -3);
      context.lineTo(3, -5);
      context.stroke();
      drawHead(3, -5, -Math.PI / 2);
    }
    if ([...directions].some((token) => token.includes("right"))) {
      context.beginPath();
      context.moveTo(-4, 0);
      context.lineTo(0, 0);
      context.quadraticCurveTo(3, 0, 3, 3);
      context.lineTo(3, 5);
      context.stroke();
      drawHead(3, 5, Math.PI / 2);
    }
    context.restore();
  }

  pointInRenderedView(x, y, renderView) {
    if (!this.viewportInteraction || !renderView) {
      return { x, y };
    }
    const transform = viewportPreviewTransform(
      renderView,
      this,
      this.width,
      this.height,
    );
    return {
      x: (x - transform.translateX) / transform.ratio,
      y: (y - transform.translateY) / transform.ratio,
    };
  }

  inspectAt(x, y) {
    const agentPoint = this.pointInRenderedView(x, y, this.agentRenderView);
    const poiPoint = this.pointInRenderedView(x, y, this.baseRenderView);
    let nearestAgent = null;
    const metrics = agentVisualMetrics(this.zoom);
    let nearestAgentDistance = Math.max(
      12,
      Math.hypot(metrics.carWidth / 2, metrics.carLength / 2)
        + metrics.outlineWidth + 2,
      metrics.pedestrianRadius + metrics.outlineWidth + 2,
    );
    for (const entry of this.renderedAgents) {
      const distance = Math.hypot(
        agentPoint.x - entry.screen.x,
        agentPoint.y - entry.screen.y,
      );
      if (distance < nearestAgentDistance) {
        nearestAgent = entry.agent;
        nearestAgentDistance = distance;
      }
    }
    if (nearestAgent) {
      this.onFeatureSelect?.({ type: "agent", agent: nearestAgent });
      return;
    }

    let nearestPoi = null;
    let nearestPoiDistance = Number.POSITIVE_INFINITY;
    for (const entry of this.renderedPois) {
      const distance = Math.hypot(
        poiPoint.x - entry.screen.x,
        poiPoint.y - entry.screen.y,
      );
      if (distance <= Math.max(10, entry.radius) && distance < nearestPoiDistance) {
        nearestPoi = entry.poi;
        nearestPoiDistance = distance;
      }
    }
    if (nearestPoi) {
      this.onFeatureSelect?.({ type: "poi", poi: nearestPoi });
      return;
    }

    let best = null;
    let bestDistance = 11;
    for (const entry of this.visibleSegmentEntries(15)) {
      const segment = entry.segment;
      const points = this.segmentScreenPoints(entry);
      if (!points || !this.visible(points, 15)) {
        continue;
      }
      const distance = pointToSegmentDistance(
        x,
        y,
        points.start.x,
        points.start.y,
        points.end.x,
        points.end.y,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = segment;
      }
    }
    this.onFeatureSelect?.(best ? { type: "segment", segment: best } : null);
  }

  setAgents(
    nextAgents,
    {
      animate = true,
      observeInterval = animate,
      resetTiming = false,
      snapAgentIds = null,
      transitionDurationMs = null,
    } = {},
  ) {
    const now = performance.now();
    const unchanged = this.agentFramesEqual(nextAgents);
    const animationWasActive = this.agentAnimationActive || this.animationFrame !== null;
    if (
      unchanged
      && !resetTiming
      && snapAgentIds === null
      && transitionDurationMs === null
    ) {
      if (observeInterval && nextAgents.length > 0 && this.lastAgentSnapshotAt !== null) {
        this.agentFrameIntervalMs = updateAgentFrameInterval(
          this.agentFrameIntervalMs,
          now - this.lastAgentSnapshotAt,
        );
      }
      if (observeInterval && nextAgents.length > 0) {
        this.lastAgentSnapshotAt = now;
      }
      // Preserve non-visual fields, but do not restart a 60 fps transition when
      // every rendered position and heading is identical (common in queues).
      this.agents = nextAgents;
      return;
    }
    if (resetTiming) {
      this.lastAgentSnapshotAt = null;
      this.agentFrameIntervalMs = runningPollIntervalForAgentCount(nextAgents.length);
      this.agentRenderCache?.clear();
    }
    this.previousAgents = animate && !resetTiming
      ? this.captureInterpolatedAgents(now)
      : new Map();
    for (const agent of nextAgents) {
      if (agent.relocated) {
        this.interpolationResetAgentIds.add(String(agent.id));
      }
    }
    if (snapAgentIds) {
      for (const id of snapAgentIds) {
        this.interpolationResetAgentIds.add(String(id));
      }
    }
    for (const id of this.previousAgents.keys()) {
      if (this.interpolationResetAgentIds.has(String(id))) {
        this.previousAgents.delete(id);
      }
    }
    this.agents = nextAgents;
    if (nextAgents.length === 0) {
      this.previousAgents.clear();
      this.agentRenderCache?.clear();
      this.lastAgentSnapshotAt = null;
      this.agentFrameIntervalMs = DEFAULT_AGENT_FRAME_INTERVAL_MS;
    } else if (observeInterval && this.lastAgentSnapshotAt !== null) {
      this.agentFrameIntervalMs = updateAgentFrameInterval(
        this.agentFrameIntervalMs,
        now - this.lastAgentSnapshotAt,
      );
    }
    if (observeInterval && nextAgents.length > 0) {
      this.lastAgentSnapshotAt = now;
    }
    const explicitTransitionDuration = Number(transitionDurationMs);
    this.agentTransitionDurationMs = (
      transitionDurationMs !== null
      && transitionDurationMs !== undefined
      && Number.isFinite(explicitTransitionDuration)
      && explicitTransitionDuration >= 0
    )
      ? explicitTransitionDuration
      : agentTransitionDuration(this.agentFrameIntervalMs);
    this.agentAnimationActive = Boolean(animate && nextAgents.length > 0);
    this.transitionStarted = now;
    if (this.viewportInteraction) {
      this.agentAnimationActive = false;
      return;
    }
    if (!animate && unchanged && !resetTiming && !animationWasActive) {
      return;
    }
    this.scheduleAgentDraw();
  }

  setAgentColorModes(nextModes = {}) {
    const normalized = normalizeAgentColorModes({
      ...this.agentColorModes,
      ...nextModes,
    });
    if (
      normalized.car === this.agentColorModes.car
      && normalized.pedestrian === this.agentColorModes.pedestrian
    ) {
      return false;
    }
    this.agentColorModes = normalized;
    this.scheduleAgentDraw();
    return true;
  }

  agentFramesEqual(nextAgents) {
    if (nextAgents.length !== this.agents.length) {
      return false;
    }
    for (let index = 0; index < nextAgents.length; index += 1) {
      const current = this.agents[index];
      const next = nextAgents[index];
      if (
        current.id !== next.id
        || current.mode !== next.mode
        || current.lat !== next.lat
        || current.lng !== next.lng
        || current.heading !== next.heading
        || Boolean(current.waiting) !== Boolean(next.waiting)
      ) {
        return false;
      }
    }
    return true;
  }

  resetAgentTiming() {
    this.lastAgentSnapshotAt = null;
    this.agentFrameIntervalMs = runningPollIntervalForAgentCount(this.agents.length);
    this.agentTransitionDurationMs = agentTransitionDuration(this.agentFrameIntervalMs);
    this.agentAnimationActive = false;
    this.previousAgents = new Map(this.agents.map((agent) => [agent.id, agent]));
    this.transitionStarted = performance.now();
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  freezeAgentTransition(timestamp = performance.now()) {
    const normalizedTimestamp = Number(timestamp);
    const now = Number.isFinite(normalizedTimestamp)
      ? normalizedTimestamp
      : performance.now();
    const frozenAgents = this.captureInterpolatedAgents(now);
    this.agents = this.agents.map((agent) => frozenAgents.get(agent.id) || agent);
    this.previousAgents = new Map(this.agents.map((agent) => [agent.id, agent]));
    this.agentAnimationActive = false;
    this.transitionStarted = now;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.scheduleAgentDraw();
    return this.agents;
  }

  captureInterpolatedAgents(timestamp) {
    if (this.agents.length === 0) {
      return new Map();
    }
    const progress = interpolationProgress(
      timestamp,
      this.transitionStarted,
      this.agentTransitionDurationMs,
    );
    const captured = new Map();
    for (const agent of this.agents) {
      const start = this.interpolationStartAgent(agent);
      if (start === agent) {
        captured.set(agent.id, agent);
        continue;
      }
      captured.set(agent.id, {
        ...agent,
        lat: start.lat + (agent.lat - start.lat) * progress,
        lng: start.lng + (agent.lng - start.lng) * progress,
        heading: interpolateHeading(start.heading, agent.heading, progress),
      });
    }
    return captured;
  }

  setSelectedAgentRoute(agentId, route = null) {
    if (agentId === null || agentId === undefined || route === null) {
      this.selectedAgentId = null;
      this.selectedRouteMode = null;
      this.selectedRouteToken = null;
      this.selectedRouteIndex = 0;
      this.previousSelectedRouteIndex = 0;
      this.selectedRouteWorldNodes = [];
      this.scheduleAgentDraw();
      return true;
    }

    const nextAgentId = String(agentId);
    const routeAgentId = route.agentId === null || route.agentId === undefined
      ? nextAgentId
      : String(route.agentId);
    const routeMatchesAgent = routeAgentId === nextAgentId;
    const nextToken = routeMatchesAgent && route.token !== undefined
      ? route.token
      : null;
    const sameRoute = routeMatchesAgent && (
      this.selectedAgentId === nextAgentId
      && this.selectedRouteToken === nextToken
    );

    if (!sameRoute) {
      this.selectedRouteWorldNodes = [];
      const routeDiscontinuity = (
        this.selectedAgentId === nextAgentId
        && this.selectedRouteToken !== null
        && nextToken !== this.selectedRouteToken
      );
      if (routeDiscontinuity) {
        this.interpolationResetAgentIds.add(nextAgentId);
        for (const id of this.previousAgents.keys()) {
          if (String(id) === nextAgentId) {
            this.previousAgents.delete(id);
            break;
          }
        }
      }
    }

    if (
      routeMatchesAgent
      && Array.isArray(route.nodeIds)
      && (!sameRoute || this.selectedRouteWorldNodes.length === 0)
    ) {
      const worldNodes = [];
      for (const nodeId of route.nodeIds) {
        const world = this.nodeWorld.get(Number(nodeId));
        if (!world) {
          worldNodes.length = 0;
          break;
        }
        worldNodes.push(world);
      }
      this.selectedRouteWorldNodes = worldNodes;
    }

    const routeIndex = Number(route.routeIndex);
    const normalizedRouteIndex = Number.isFinite(routeIndex)
      ? Math.max(0, Math.trunc(routeIndex))
      : 0;
    this.previousSelectedRouteIndex = sameRoute
      ? this.selectedRouteIndex
      : normalizedRouteIndex;
    this.selectedAgentId = nextAgentId;
    this.selectedRouteMode = routeMatchesAgent ? route.mode : null;
    this.selectedRouteToken = nextToken;
    this.selectedRouteIndex = normalizedRouteIndex;
    this.scheduleAgentDraw();
    return nextToken === null || this.selectedRouteWorldNodes.length >= 2;
  }

  scheduleAgentDraw() {
    if (this.viewportInteraction || this.animationFrame !== null) {
      return;
    }
    const animate = (timestamp) => {
      this.animationFrame = null;
      if (this.viewportInteraction) {
        this.agentAnimationActive = false;
        return;
      }
      const transitionFinished = (
        !this.agentAnimationActive
        || timestamp - this.transitionStarted >= this.agentTransitionDurationMs
      );
      const individualColors = (
        this.agentColorModes.car === "individual"
        || this.agentColorModes.pedestrian === "individual"
      );
      const minimumInterval = (
        individualColors && this.agents.length >= LARGE_INDIVIDUAL_AGENT_LIMIT
      )
        ? LARGE_INDIVIDUAL_AGENT_FRAME_INTERVAL_MS
        : 0;
      const elapsedSinceDraw = Number.isFinite(this.lastAgentDrawAt)
        ? timestamp - this.lastAgentDrawAt
        : Number.POSITIVE_INFINITY;
      if (
        transitionFinished
        // rAF timestamps can land a tiny fraction below the mathematical
        // 33.333 ms boundary; a half-ms tolerance keeps 60 Hz at 30 FPS.
        || elapsedSinceDraw + 0.5 >= minimumInterval
      ) {
        this.drawAgents(timestamp);
      }
      if (!transitionFinished) {
        this.animationFrame = requestAnimationFrame(animate);
      } else {
        this.agentAnimationActive = false;
      }
    };
    this.animationFrame = requestAnimationFrame(animate);
  }

  drawAgents(timestamp) {
    const context = this.agentContext;
    if (!context) {
      return;
    }
    const pixelRatio = this.agentPixelRatio || this.pixelRatio || 1;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    this.renderedAgents.length = 0;
    const progress = interpolationProgress(
      timestamp,
      this.transitionStarted,
      this.agentTransitionDurationMs,
    );
    const metrics = agentVisualMetrics(this.zoom);
    const cullingMargin = Math.ceil(Math.max(
      Math.hypot(metrics.carWidth / 2, metrics.carLength / 2),
      metrics.pedestrianRadius,
    ) + metrics.outlineWidth + 2);
    let selectedEntry = null;
    for (const agent of this.agents) {
      let entry = this.agentRenderCache.get(agent.id);
      if (!entry) {
        entry = { agent, screen: { x: 0, y: 0, heading: 0 } };
        this.agentRenderCache.set(agent.id, entry);
      } else {
        entry.agent = agent;
      }
      const screen = this.interpolatedAgentScreen(agent, progress, entry.screen);
      if (
        this.selectedAgentId !== null
        && String(agent.id) === this.selectedAgentId
      ) {
        selectedEntry = entry;
      }
      if (
        screen.x < -cullingMargin
        || screen.y < -cullingMargin
        || screen.x > this.width + cullingMargin
        || screen.y > this.height + cullingMargin
      ) {
        continue;
      }
      this.renderedAgents.push(entry);
    }
    if (selectedEntry) {
      this.drawSelectedRoute(context, selectedEntry.screen, progress);
    }
    this.drawOverviewAgents(context, metrics);
    this.interpolationResetAgentIds.clear();
    this.agentRenderView = {
      width: this.width,
      height: this.height,
      centerX: this.centerX,
      centerY: this.centerY,
      scale: this.scale,
      zoom: this.zoom,
    };
    this.lastAgentDrawAt = timestamp;
  }

  interpolationStartAgent(agent) {
    const resetInterpolation = this.interpolationResetAgentIds.size > 0
      && this.interpolationResetAgentIds.has(String(agent.id));
    const previous = resetInterpolation ? null : this.previousAgents.get(agent.id);
    const teleported = previous && (
      Math.abs(previous.lat - agent.lat) > 0.006 || Math.abs(previous.lng - agent.lng) > 0.009
    );
    return !previous || teleported ? agent : previous;
  }

  interpolatedAgentScreen(agent, progress, target = null) {
    const start = this.interpolationStartAgent(agent);
    const latitude = start.lat + (agent.lat - start.lat) * progress;
    const longitude = start.lng + (agent.lng - start.lng) * progress;
    const screen = target || this.worldToScreen(this.coordinateToWorld(latitude, longitude));
    if (target) {
      const worldX = (Number(longitude) - this.bounds.west) * this.metersPerLongitudeDegree;
      const worldY = (this.bounds.north - Number(latitude)) * 111_320;
      screen.x = (worldX - this.centerX) * this.scale + this.width / 2;
      screen.y = (worldY - this.centerY) * this.scale + this.height / 2;
    }
    screen.heading = interpolateHeading(start.heading, agent.heading, progress);
    return screen;
  }

  drawAgent(context, agent, screen, metrics = agentVisualMetrics(this.zoom)) {
    if (
      this.selectedAgentId !== null
      && String(agent.id) === this.selectedAgentId
    ) {
      this.drawSelectedAgentHalo(context, screen.x, screen.y, agent.mode);
    }
    const color = agentColorFor(agent, this.agentColorModes);
    if (agent.mode === "car") {
      this.drawCar(
        context,
        screen.x,
        screen.y,
        screen.heading,
        agent.waiting,
        color,
        metrics,
      );
    } else {
      this.drawPedestrian(
        context,
        screen.x,
        screen.y,
        agent.waiting,
        color,
        metrics,
      );
    }
  }

  drawOverviewAgents(context, metrics = agentVisualMetrics(this.zoom)) {
    const colorBatches = this.overviewColorBatches || new Map();
    this.overviewColorBatches = colorBatches;
    const waitingScreens = this.waitingAgentScreens || { car: [], pedestrian: [] };
    this.waitingAgentScreens = waitingScreens;
    waitingScreens.car.length = 0;
    waitingScreens.pedestrian.length = 0;
    for (const batch of colorBatches.values()) {
      batch.carScreens.length = 0;
      batch.pedestrianScreens.length = 0;
    }
    let selected = null;
    let activeColorBatchCount = 0;
    for (const entry of this.renderedAgents) {
      if (
        this.selectedAgentId !== null
        && String(entry.agent.id) === this.selectedAgentId
      ) {
        selected = entry;
        continue;
      }
      const mode = entry.agent.mode === "pedestrian" ? "pedestrian" : "car";
      const color = agentColorFor(entry.agent, this.agentColorModes);
      let batch = colorBatches.get(color);
      if (!batch) {
        batch = { color, carScreens: [], pedestrianScreens: [] };
        colorBatches.set(color, batch);
      }
      if (batch.carScreens.length === 0 && batch.pedestrianScreens.length === 0) {
        activeColorBatchCount += 1;
      }
      const screens = mode === "car" ? batch.carScreens : batch.pedestrianScreens;
      screens.push(entry.screen);
      if (entry.agent.waiting) {
        waitingScreens[mode].push(entry.screen);
      }
    }

    context.save();
    const supportsCombinedPaths = (
      activeColorBatchCount > 2
      && typeof Path2D !== "undefined"
      && typeof Path2D.prototype?.addPath === "function"
    );
    if (supportsCombinedPaths) {
      const outlinePath = new Path2D();
      for (const batch of colorBatches.values()) {
        if (batch.carScreens.length === 0 && batch.pedestrianScreens.length === 0) {
          continue;
        }
        const colorPath = new Path2D();
        this.appendOverviewAgentShapes(colorPath, "car", batch.carScreens, metrics);
        this.appendOverviewAgentShapes(
          colorPath,
          "pedestrian",
          batch.pedestrianScreens,
          metrics,
        );
        context.globalAlpha = 0.96;
        context.fillStyle = batch.color;
        context.fill(colorPath);
        outlinePath.addPath(colorPath);
      }
      if (waitingScreens.car.length > 0 || waitingScreens.pedestrian.length > 0) {
        const waitingPath = new Path2D();
        this.appendOverviewAgentShapes(waitingPath, "car", waitingScreens.car, metrics);
        this.appendOverviewAgentShapes(
          waitingPath,
          "pedestrian",
          waitingScreens.pedestrian,
          metrics,
        );
        context.globalAlpha = 0.24;
        context.fillStyle = "#07100f";
        context.fill(waitingPath);
      }
      context.globalAlpha = 0.96;
      context.strokeStyle = "rgba(7, 16, 15, 0.82)";
      context.lineWidth = metrics.outlineWidth * 2;
      context.stroke(outlinePath);
    } else {
      for (const batch of colorBatches.values()) {
        if (batch.carScreens.length === 0 && batch.pedestrianScreens.length === 0) {
          continue;
        }
        context.beginPath();
        this.appendOverviewAgentShapes(context, "car", batch.carScreens, metrics);
        this.appendOverviewAgentShapes(
          context,
          "pedestrian",
          batch.pedestrianScreens,
          metrics,
        );
        context.globalAlpha = 0.96;
        context.fillStyle = batch.color;
        context.fill();
        context.strokeStyle = "rgba(7, 16, 15, 0.82)";
        context.lineWidth = metrics.outlineWidth * 2;
        context.stroke();
      }
      if (waitingScreens.car.length > 0 || waitingScreens.pedestrian.length > 0) {
        context.beginPath();
        this.appendOverviewAgentShapes(context, "car", waitingScreens.car, metrics);
        this.appendOverviewAgentShapes(
          context,
          "pedestrian",
          waitingScreens.pedestrian,
          metrics,
        );
        context.globalAlpha = 0.24;
        context.fillStyle = "#07100f";
        context.fill();
      }
    }
    context.restore();

    if (selected) {
      this.drawAgent(context, selected.agent, selected.screen, metrics);
    }
  }

  appendOverviewAgentShapes(context, mode, screens, metrics) {
    if (mode === "car") {
      const halfWidth = metrics.carWidth / 2;
      const halfLength = metrics.carLength / 2;
      for (const screen of screens) {
        const heading = Number.isFinite(Number(screen.heading))
          ? Number(screen.heading)
          : 0;
        const angle = (heading * Math.PI) / 180;
        const lateralX = Math.cos(angle) * halfWidth;
        const lateralY = Math.sin(angle) * halfWidth;
        const longitudinalX = -Math.sin(angle) * halfLength;
        const longitudinalY = Math.cos(angle) * halfLength;
        context.moveTo(
          screen.x - lateralX - longitudinalX,
          screen.y - lateralY - longitudinalY,
        );
        context.lineTo(
          screen.x + lateralX - longitudinalX,
          screen.y + lateralY - longitudinalY,
        );
        context.lineTo(
          screen.x + lateralX + longitudinalX,
          screen.y + lateralY + longitudinalY,
        );
        context.lineTo(
          screen.x - lateralX + longitudinalX,
          screen.y - lateralY + longitudinalY,
        );
        context.closePath();
      }
      return;
    }
    for (const screen of screens) {
      context.moveTo(screen.x + metrics.pedestrianRadius, screen.y);
      context.arc(
        screen.x,
        screen.y,
        metrics.pedestrianRadius,
        0,
        Math.PI * 2,
      );
    }
  }

  drawSelectedRoute(context, currentScreen, progress = 1) {
    if (this.selectedRouteWorldNodes.length < 2) {
      return;
    }
    const visualRouteIndex = progress < 1
      ? this.previousSelectedRouteIndex
      : this.selectedRouteIndex;
    const firstRemainingNode = clamp(
      visualRouteIndex + 1,
      1,
      this.selectedRouteWorldNodes.length,
    );
    if (firstRemainingNode >= this.selectedRouteWorldNodes.length) {
      return;
    }

    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(currentScreen.x, currentScreen.y);
    for (let index = firstRemainingNode; index < this.selectedRouteWorldNodes.length; index += 1) {
      const screen = this.worldToScreen(this.selectedRouteWorldNodes[index]);
      context.lineTo(screen.x, screen.y);
    }

    const routeWidth = clamp(2.2 + Math.log2(this.zoom + 1) * 0.42, 2.5, 4.8);
    context.setLineDash([]);
    context.globalAlpha = 0.9;
    context.strokeStyle = "rgba(5, 13, 12, 0.94)";
    context.lineWidth = routeWidth + 3.2;
    context.stroke();

    context.globalAlpha = 0.96;
    context.strokeStyle = this.selectedRouteMode === "pedestrian" ? "#43d9d0" : "#ffad5a";
    context.lineWidth = routeWidth;
    context.setLineDash(this.selectedRouteMode === "pedestrian" ? [8, 6] : []);
    context.stroke();
    context.restore();
  }

  drawSelectedAgentHalo(context, x, y, mode) {
    const pedestrian = mode === "pedestrian";
    const radius = clamp(
      (pedestrian ? 6.5 : 8) + Math.log2(this.zoom + 1) * 0.7,
      pedestrian ? 7 : 8.5,
      pedestrian ? 12 : 14,
    );
    context.save();
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = pedestrian ? "rgba(67, 217, 208, 0.2)" : "rgba(255, 173, 90, 0.2)";
    context.fill();
    context.strokeStyle = pedestrian ? "#8bfff8" : "#ffd09a";
    context.lineWidth = 2;
    context.stroke();
    context.restore();
  }

  drawCar(
    context,
    x,
    y,
    heading,
    waiting,
    color = UNIFORM_AGENT_COLORS.car,
    metrics = agentVisualMetrics(this.zoom),
  ) {
    context.save();
    context.translate(x, y);
    context.rotate((heading * Math.PI) / 180);
    context.globalAlpha = waiting ? 0.72 : 0.96;
    context.fillStyle = color;
    context.fillRect(
      -metrics.carWidth / 2,
      -metrics.carLength / 2,
      metrics.carWidth,
      metrics.carLength,
    );
    context.strokeStyle = "rgba(7, 16, 15, 0.82)";
    context.lineWidth = metrics.outlineWidth * 2;
    context.strokeRect(
      -metrics.carWidth / 2,
      -metrics.carLength / 2,
      metrics.carWidth,
      metrics.carLength,
    );
    context.restore();
  }

  drawPedestrian(
    context,
    x,
    y,
    waiting,
    color = UNIFORM_AGENT_COLORS.pedestrian,
    metrics = agentVisualMetrics(this.zoom),
  ) {
    context.save();
    context.globalAlpha = waiting ? 0.72 : 0.96;
    context.beginPath();
    context.arc(
      x,
      y,
      metrics.pedestrianRadius + metrics.outlineWidth,
      0,
      Math.PI * 2,
    );
    context.fillStyle = "rgba(7, 16, 15, 0.82)";
    context.fill();
    context.beginPath();
    context.arc(x, y, metrics.pedestrianRadius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.restore();
  }

  destroy() {
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.disableStaticRenderer();
    if (this.viewportCommitTimer !== null) {
      clearTimeout(this.viewportCommitTimer);
    }
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
    }
    if (this.viewportAnimationFrame !== null) {
      cancelAnimationFrame(this.viewportAnimationFrame);
    }
    this.container.classList.remove("viewport-interacting");
    this.container.removeEventListener("pointerdown", this.handlePointerDown);
    this.container.removeEventListener("pointermove", this.handlePointerMove);
    this.container.removeEventListener("pointerup", this.handlePointerUp);
    this.container.removeEventListener("pointercancel", this.handlePointerCancel);
    this.container.removeEventListener("wheel", this.handleWheel);
    this.container.removeEventListener("dblclick", this.handleDoubleClick);
  }
}
