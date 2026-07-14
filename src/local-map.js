import {
  DEFAULT_AGENT_FRAME_INTERVAL_MS,
  agentTransitionDuration,
  interpolateGeographicPose,
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
const LARGE_INDIVIDUAL_AGENT_MAX_PIXEL_RATIO = 1;
const VIEWPORT_COMMIT_DELAY_MS = 180;
const STATIC_RENDER_TIMEOUT_MS = 2_500;
const STATIC_TILE_RENDER_TIMEOUT_MS = 10_000;
const STATIC_TILE_SIZE = 512;
const STATIC_TILE_PADDING = 48;
const STATIC_TILE_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const STATIC_TILE_BITMAP_BYTES = (
  STATIC_TILE_SIZE + STATIC_TILE_PADDING * 2
) ** 2 * 4;
const STATIC_TILE_CACHE_MAX_ENTRIES = Math.max(
  1,
  Math.floor(STATIC_TILE_CACHE_MAX_BYTES / STATIC_TILE_BITMAP_BYTES),
);
const STATIC_FULL_MAP_MAX_TILES = 48;
const STATIC_FULL_MAP_MARGIN_PIXELS = 28;
const LARGE_INDIVIDUAL_AGENT_LIMIT = 3_000;
const LARGE_INDIVIDUAL_AGENT_UPSCALE_LIMIT = 2_500;
const LARGE_INDIVIDUAL_AGENT_SLOW_DRAW_MS = 8;
const LARGE_INDIVIDUAL_AGENT_FRAME_INTERVAL_MS = 1_000 / 30;
const IDENTITY_VIEWPORT_TRANSFORM = "matrix(1, 0, 0, 1, 0, 0)";

export const STATIC_RENDER_PROFILES = Object.freeze([
  0.8,
  0.95,
  1.5,
  1.9,
  2.4,
  3.2,
  3.5,
  7,
  14,
  28,
  40,
].map((zoom) => Object.freeze({ id: `z${zoom}`, zoom })));

export function normalizeStaticRenderOptions(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    prepareAllLayers: source.prepareAllLayers === true,
    renderFullMap: source.renderFullMap === true,
  };
}

export function staticRenderProfileForZoom(zoom) {
  const normalizedZoom = clamp(Number(zoom) || 1, 0.8, 40);
  let selected = STATIC_RENDER_PROFILES[0];
  for (const profile of STATIC_RENDER_PROFILES) {
    if (profile.zoom > normalizedZoom + 1e-9) {
      break;
    }
    selected = profile;
  }
  return selected;
}

function fullMapTileRange(worldWidth, worldHeight, scale, tileSize, marginPixels) {
  const firstColumn = Math.floor(-marginPixels / tileSize);
  const firstRow = Math.floor(-marginPixels / tileSize);
  const lastColumn = Math.ceil((worldWidth * scale + marginPixels) / tileSize) - 1;
  const lastRow = Math.ceil((worldHeight * scale + marginPixels) / tileSize) - 1;
  return {
    firstColumn,
    lastColumn,
    firstRow,
    lastRow,
    tileCount: Math.max(1, lastColumn - firstColumn + 1)
      * Math.max(1, lastRow - firstRow + 1),
  };
}

export function boundedFullMapTilePlan(
  worldWidth,
  worldHeight,
  desiredScale,
  {
    maxTiles = STATIC_FULL_MAP_MAX_TILES,
    tileSize = STATIC_TILE_SIZE,
    marginPixels = STATIC_FULL_MAP_MARGIN_PIXELS,
  } = {},
) {
  const width = Math.max(1, Number(worldWidth) || 1);
  const height = Math.max(1, Number(worldHeight) || 1);
  const targetScale = Math.max(1e-6, Number(desiredScale) || 1e-6);
  const tileLimit = Math.max(4, Math.floor(Number(maxTiles) || 4));
  let range = fullMapTileRange(width, height, targetScale, tileSize, marginPixels);
  if (range.tileCount <= tileLimit) {
    return { ...range, scale: targetScale, limited: false };
  }

  let lower = 1e-6;
  let upper = targetScale;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const candidate = (lower + upper) / 2;
    const candidateRange = fullMapTileRange(
      width,
      height,
      candidate,
      tileSize,
      marginPixels,
    );
    if (candidateRange.tileCount <= tileLimit) {
      lower = candidate;
      range = candidateRange;
    } else {
      upper = candidate;
    }
  }
  return { ...range, scale: lower, limited: true };
}

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

export function trafficLoadColor(loadPercent) {
  const load = clamp(Number(loadPercent) || 0, 0, 100);
  const hue = 120 * (1 - load / 100);
  return `hsl(${hue.toFixed(1)} 78% 48%)`;
}

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

export function agentPixelRatioForLoad(
  devicePixelRatio,
  agentCount = 0,
  colorModes = {},
  currentPixelRatio = null,
) {
  const numericPixelRatio = Number(devicePixelRatio);
  const availablePixelRatio = Number.isFinite(numericPixelRatio) && numericPixelRatio > 0
    ? Math.min(numericPixelRatio, 2)
    : 1;
  const individualColors = (
    colorModes?.car === "individual"
    || colorModes?.pedestrian === "individual"
  );
  const numericAgentCount = Number(agentCount);
  const numericCurrentPixelRatio = Number(currentPixelRatio);
  const reducedForLargeIndividualLoad = (
    currentPixelRatio !== null
    && currentPixelRatio !== undefined
    && Number.isFinite(numericCurrentPixelRatio)
    && numericCurrentPixelRatio <= LARGE_INDIVIDUAL_AGENT_MAX_PIXEL_RATIO
    && numericAgentCount >= LARGE_INDIVIDUAL_AGENT_UPSCALE_LIMIT
  );
  const maximumPixelRatio = (
    individualColors
    && (
      numericAgentCount >= LARGE_INDIVIDUAL_AGENT_LIMIT
      || reducedForLargeIndividualLoad
    )
  )
    ? LARGE_INDIVIDUAL_AGENT_MAX_PIXEL_RATIO
    : AGENT_CANVAS_MAX_PIXEL_RATIO;
  return Math.min(availablePixelRatio, maximumPixelRatio);
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
  constructor(
    container,
    network,
    {
      onFeatureSelect,
      onViewportInteractionChange,
      onStaticPreparationChange,
      agentColorModes,
      staticRenderOptions,
    } = {},
  ) {
    this.container = container;
    this.network = network;
    this.onFeatureSelect = onFeatureSelect;
    this.onViewportInteractionChange = onViewportInteractionChange;
    this.onStaticPreparationChange = onStaticPreparationChange;
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
    this.trafficHeatmapEnabled = false;
    this.segmentStatistics = new Map();
    this.heatmapRenderView = null;
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
    this.agentCurveInterpolationActive = false;
    this.agentAnimationActive = false;
    this.animationFrame = null;
    this.lastAgentDrawAt = Number.NEGATIVE_INFINITY;
    this.agentDrawDurationMs = null;
    this.viewportAnimationFrame = null;
    this.viewportCommitTimer = null;
    this.viewportCommitDeadline = null;
    this.viewportInteraction = null;
    this.pendingAgentResolutionSync = false;
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
    this.staticRenderOptions = normalizeStaticRenderOptions(staticRenderOptions);
    this.staticTileWorker = null;
    this.staticTileReady = false;
    this.staticTileFailed = false;
    this.staticTileTimeout = null;
    this.staticTileRequestId = 0;
    this.staticTilePending = null;
    this.staticTileQueue = [];
    this.staticTileQueuedKeys = new Set();
    this.staticTileCache = new Map();
    this.staticTileCacheBytes = 0;
    this.staticTileGeneration = 0;
    this.staticTilePlanKeys = new Set();
    this.staticTileCompletedKeys = new Set();
    this.staticTilePlanLimited = false;
    this.staticTileLastStatusPhase = null;
    this.staticTileLastProgressNotificationAt = Number.NEGATIVE_INFINITY;
    this.staticTilePreparationRefreshTimer = null;
    this.staticTileDetailLevels = new Map();
    this.staticTileFullLevels = new Map();
    this.staticTileDetailSignature = null;
    this.staticTileFullSignature = null;
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
    this.heatmapCanvas = document.createElement("canvas");
    this.heatmapCanvas.className = "local-map-canvas local-map-heatmap";
    this.heatmapCanvas.style.zIndex = "4";
    this.heatmapCanvas.hidden = true;
    this.poiLabelCanvas = document.createElement("canvas");
    this.poiLabelCanvas.className = "local-map-canvas local-map-poi-labels";
    this.poiLabelCanvas.style.zIndex = "5";
    this.agentCanvas = document.createElement("canvas");
    this.agentCanvas.className = "local-map-canvas local-map-agents";
    this.agentCanvas.style.zIndex = "6";
    this.agentCanvas.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
    this.viewportLayer = document.createElement("div");
    this.viewportLayer.className = "local-map-viewport-layer";
    this.viewportLayer.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
    this.viewportLayer.append(this.baseCanvas);
    this.staticFullMapLayer = document.createElement("div");
    this.staticFullMapLayer.className = "local-map-tile-layer local-map-full-map-layer";
    this.staticFullMapLayer.hidden = true;
    this.staticTileLayer = document.createElement("div");
    this.staticTileLayer.className = "local-map-tile-layer local-map-detail-tile-layer";
    this.staticTileLayer.hidden = true;
    // The static road bitmap stays on the compositor-only viewport layer. The
    // dynamic agent canvas is a sibling so it can keep drawing in the current
    // view while the base layer is panned or zoomed.
    this.container.replaceChildren(
      this.staticFullMapLayer,
      this.viewportLayer,
      this.staticTileLayer,
      this.heatmapCanvas,
      this.poiLabelCanvas,
      this.agentCanvas,
    );
    this.baseBitmapContext = null;
    this.baseRenderCanvas = null;
    this.baseContext = null;
    this.initializeBaseCanvasContext();
    this.heatmapContext = this.heatmapCanvas.getContext("2d", { alpha: true });
    this.poiLabelContext = this.poiLabelCanvas.getContext("2d", { alpha: true });
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
    this.syncStaticTileRenderer();
  }

  initializeBaseCanvasContext() {
    // ImageBitmapRenderingContext uses transfer semantics instead of copying a
    // worker bitmap through CanvasRenderingContext2D.drawImage(). Keep a small
    // OffscreenCanvas 2D surface for the rare main-thread fallback path.
    if (typeof OffscreenCanvas !== "undefined") {
      try {
        const renderCanvas = new OffscreenCanvas(1, 1);
        const renderContext = renderCanvas.getContext("2d", { alpha: false });
        if (
          renderContext
          && typeof renderCanvas.transferToImageBitmap === "function"
        ) {
          const bitmapContext = this.baseCanvas.getContext(
            "bitmaprenderer",
            { alpha: false },
          );
          if (bitmapContext?.transferFromImageBitmap) {
            this.baseRenderCanvas = renderCanvas;
            this.baseBitmapContext = bitmapContext;
            this.baseContext = renderContext;
            return true;
          }
        }
      } catch {
        // Capability fallback below intentionally retains the 2D canvas path.
      }
    }
    this.baseContext = this.baseCanvas.getContext("2d", { alpha: false });
    return false;
  }

  replaceBitmapPresenterWith2d(source = null) {
    const oldCanvas = this.baseCanvas;
    const ownerDocument = oldCanvas?.ownerDocument || globalThis.document;
    if (!oldCanvas || !ownerDocument?.createElement) {
      return false;
    }
    try {
      const replacement = ownerDocument.createElement("canvas");
      replacement.className = oldCanvas.className;
      replacement.width = oldCanvas.width;
      replacement.height = oldCanvas.height;
      replacement.style.width = oldCanvas.style.width;
      replacement.style.height = oldCanvas.style.height;
      replacement.style.left = oldCanvas.style.left;
      replacement.style.top = oldCanvas.style.top;
      const context = replacement.getContext("2d", { alpha: false });
      if (!context || !oldCanvas.parentNode?.replaceChild) {
        return false;
      }
      if (source) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalAlpha = 1;
        context.drawImage(source, 0, 0);
      }
      // Paint while detached. Only publish the replacement after the exact
      // fallback frame is ready, so even a source draw failure cannot flash a
      // blank base layer.
      oldCanvas.parentNode.replaceChild(replacement, oldCanvas);
      try {
        this.baseBitmapContext?.transferFromImageBitmap?.(null);
      } catch {
        // A lost presenter may also reject explicit output release.
      }
      this.baseCanvas = replacement;
      this.baseBitmapContext = null;
      this.baseRenderCanvas = null;
      this.baseContext = context;
      return true;
    } catch {
      return false;
    }
  }

  presentBaseBitmap(bitmap) {
    if (!bitmap) {
      return false;
    }
    let transferred = false;
    try {
      if (this.baseBitmapContext?.transferFromImageBitmap) {
        try {
          this.baseBitmapContext.transferFromImageBitmap(bitmap);
          transferred = true;
          return true;
        } catch {
          // Context mode is permanent. Replace the DOM canvas once and keep all
          // later worker frames on the proven 2D capability fallback.
          return this.replaceBitmapPresenterWith2d(bitmap);
        }
      }
      const context = this.baseContext;
      if (!context) {
        return false;
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.drawImage(bitmap, 0, 0);
      return true;
    } finally {
      // transferFromImageBitmap detaches the source. drawImage and failed
      // presentation paths retain ownership and must release it explicitly.
      if (!transferred) {
        bitmap.close?.();
      }
    }
  }

  prepareBaseRenderSurface() {
    const renderCanvas = this.baseRenderCanvas;
    if (!renderCanvas) {
      return this.baseContext;
    }
    if (renderCanvas.width !== this.baseCanvas.width) {
      renderCanvas.width = this.baseCanvas.width;
    }
    if (renderCanvas.height !== this.baseCanvas.height) {
      renderCanvas.height = this.baseCanvas.height;
    }
    return this.baseContext;
  }

  presentBaseRenderSurface() {
    const renderCanvas = this.baseRenderCanvas;
    if (!renderCanvas) {
      return true;
    }
    try {
      const bitmap = renderCanvas.transferToImageBitmap();
      return this.presentBaseBitmap(bitmap);
    } catch {
      // If staging transfer itself fails, preserve the just-rendered frame while
      // permanently falling back to a normal DOM 2D canvas.
      return this.replaceBitmapPresenterWith2d(renderCanvas);
    } finally {
      if (this.baseRenderCanvas === renderCanvas) {
        // Do not retain a third full-size backing store between static renders.
        renderCanvas.width = 1;
        renderCanvas.height = 1;
      }
    }
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

  createStaticRendererArrays() {
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
    return {
      segmentGeometry,
      segmentWidths,
      segmentPriorities,
      segmentModes,
      segmentLanes,
      segmentLodRanks,
      segmentCarSupport,
      turnGeometry: new Float32Array(turnGeometryValues),
      turnLaneData: new Uint8Array(turnLaneValues),
      turnDirections: new Uint8Array(turnDirectionValues),
    };
  }

  initializeStaticRenderer() {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
      return false;
    }
    try {
      const arrays = this.createStaticRendererArrays();

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
      this.scheduleViewportDraw();
    } else if (needsFallbackCommit) {
      this.finishViewportInteraction();
    } else {
      this.drawBase();
    }
  }

  staticTileModeEnabled() {
    return Boolean(
      this.staticRenderOptions?.prepareAllLayers
      || this.staticRenderOptions?.renderFullMap
    );
  }

  notifyStaticPreparation(phase, extra = {}) {
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (
      phase === "preparing"
      && this.staticTileLastStatusPhase === "preparing"
      && now - this.staticTileLastProgressNotificationAt < 100
    ) {
      return;
    }
    this.staticTileLastStatusPhase = phase;
    if (phase === "preparing") {
      this.staticTileLastProgressNotificationAt = now;
    }
    try {
      this.onStaticPreparationChange?.({
        phase,
        completed: this.staticTileCompletedKeys?.size || 0,
        total: this.staticTilePlanKeys?.size || 0,
        estimatedBytes: (this.staticTilePlanKeys?.size || 0) * STATIC_TILE_BITMAP_BYTES,
        limited: Boolean(this.staticTilePlanLimited),
        options: normalizeStaticRenderOptions(this.staticRenderOptions),
        ...extra,
      });
    } catch {
      // A status renderer must never be able to stop map interaction.
    }
  }

  setStaticRenderOptions(nextOptions = {}) {
    const normalized = normalizeStaticRenderOptions(nextOptions);
    const previous = normalizeStaticRenderOptions(this.staticRenderOptions);
    if (
      previous.prepareAllLayers === normalized.prepareAllLayers
      && previous.renderFullMap === normalized.renderFullMap
    ) {
      return normalized;
    }
    this.staticRenderOptions = normalized;
    this.staticRenderRevision = Number(this.staticRenderRevision || 0) + 1;
    this.staticTileFailed = false;
    this.staticTileGeneration = Number(this.staticTileGeneration || 0) + 1;
    this.resetStaticTilePlan({ clearCache: true });
    if (!this.staticTileModeEnabled()) {
      this.disableStaticTileRenderer({ clearCache: true });
      this.notifyStaticPreparation("idle");
      this.refreshStaticBaseForRenderOptions();
      return normalized;
    }
    this.syncStaticTileRenderer();
    this.refreshStaticBaseForRenderOptions();
    return normalized;
  }

  refreshStaticBaseForRenderOptions() {
    if (this.destroyed) {
      return false;
    }
    if (this.viewportInteraction && this.viewportGestureActive()) {
      this.staticRenderQueued = true;
      return true;
    }
    if (this.staticRenderReady && this.requestStaticRender()) {
      return true;
    }
    if (!this.viewportInteraction && this.baseContext) {
      return this.drawBase() !== false;
    }
    return false;
  }

  syncStaticTileRenderer() {
    if (!this.staticTileModeEnabled()) {
      this.disableStaticTileRenderer({ clearCache: true });
      this.notifyStaticPreparation("idle");
      return false;
    }
    if (this.staticTileFailed) {
      this.notifyStaticPreparation("fallback");
      return false;
    }
    if (this.staticTileWorker) {
      if (this.staticTileReady) {
        this.rebuildStaticTilePreparation();
      } else {
        this.notifyStaticPreparation("initializing");
      }
      return true;
    }
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
      this.staticTileFailed = true;
      this.notifyStaticPreparation("fallback");
      return false;
    }
    try {
      const arrays = this.createStaticRendererArrays();
      const worker = new Worker(
        new URL("./static-map-worker.js", import.meta.url),
        { type: "module", name: "ujbuda-static-map-cache" },
      );
      this.staticTileWorker = worker;
      this.staticTileReady = false;
      worker.addEventListener("message", (event) => {
        if (worker !== this.staticTileWorker) {
          event.data?.bitmap?.close?.();
          return;
        }
        this.handleStaticTileRendererMessage(event);
      });
      worker.addEventListener("error", () => {
        if (!this.destroyed && worker === this.staticTileWorker) {
          this.failStaticTileRenderer();
        }
      });
      worker.postMessage(
        { type: "initialize", ...arrays },
        Object.values(arrays).map((array) => array.buffer),
      );
      this.staticTileTimeout = setTimeout(() => {
        if (!this.destroyed && worker === this.staticTileWorker && !this.staticTileReady) {
          this.failStaticTileRenderer();
        }
      }, STATIC_TILE_RENDER_TIMEOUT_MS);
      this.notifyStaticPreparation("initializing");
      return true;
    } catch {
      this.failStaticTileRenderer();
      return false;
    }
  }

  disableStaticTileRenderer({ clearCache = true } = {}) {
    if (this.staticTileTimeout !== null && this.staticTileTimeout !== undefined) {
      clearTimeout(this.staticTileTimeout);
      this.staticTileTimeout = null;
    }
    if (this.staticTilePreparationRefreshTimer !== null) {
      clearTimeout(this.staticTilePreparationRefreshTimer);
      this.staticTilePreparationRefreshTimer = null;
    }
    this.staticTileWorker?.terminate?.();
    this.staticTileWorker = null;
    this.staticTileReady = false;
    this.staticTilePending = null;
    this.staticTileQueue = [];
    this.staticTileQueuedKeys?.clear?.();
    this.staticTilePlanKeys?.clear?.();
    this.staticTileCompletedKeys?.clear?.();
    if (clearCache) {
      this.clearStaticTileCache();
    }
    this.resetStaticTileLayers();
  }

  failStaticTileRenderer() {
    this.staticTileFailed = true;
    this.disableStaticTileRenderer({ clearCache: true });
    this.notifyStaticPreparation("fallback");
  }

  resetStaticTilePlan({ clearCache = false } = {}) {
    if (this.staticTilePreparationRefreshTimer !== null) {
      clearTimeout(this.staticTilePreparationRefreshTimer);
      this.staticTilePreparationRefreshTimer = null;
    }
    this.staticTileQueue = [];
    this.staticTileQueuedKeys?.clear?.();
    this.staticTilePlanKeys?.clear?.();
    this.staticTileCompletedKeys?.clear?.();
    this.staticTileDetailLevels?.clear?.();
    this.staticTileFullLevels?.clear?.();
    this.staticTileDetailSignature = null;
    this.staticTileFullSignature = null;
    this.staticTilePlanLimited = false;
    if (clearCache) {
      this.clearStaticTileCache();
    }
    this.resetStaticTileLayers();
  }

  resetStaticTileLayers() {
    for (const layer of [this.staticFullMapLayer, this.staticTileLayer]) {
      if (!layer) {
        continue;
      }
      layer.replaceChildren?.();
      layer.hidden = true;
      if (layer.style) {
        layer.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
      }
    }
    if (this.viewportLayer?.style) {
      this.viewportLayer.style.zIndex = "0";
    }
    if (this.agentCanvas?.style) {
      this.agentCanvas.style.zIndex = "1";
    }
    this.container?.classList?.toggle?.(
      "local-map-full-render",
      this.staticRenderOptions?.renderFullMap === true,
    );
  }

  clearStaticTileCache() {
    if (!this.staticTileCache) {
      this.staticTileCache = new Map();
    }
    for (const entry of this.staticTileCache.values()) {
      this.releaseStaticTileEntry(entry);
    }
    this.staticTileCache.clear();
    this.staticTileCacheBytes = 0;
  }

  releaseStaticTileEntry(entry) {
    try {
      entry?.slot?.remove?.();
      if (entry?.canvas) {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
      }
    } catch {
      // Canvas resource release is best-effort during mode changes/destruction.
    }
  }

  createStaticTileLevel(profile, scale, kind, range = null) {
    const normalizedScale = Math.max(1e-6, Number(scale) || 1e-6);
    return {
      profile,
      kind,
      range,
      scale: normalizedScale,
      id: [
        this.staticTileGeneration,
        this.staticRenderRevision,
        profile.id,
        normalizedScale.toPrecision(10),
      ].join(":"),
    };
  }

  staticTileKey(level, column, row) {
    return `${level.id}:${column}:${row}`;
  }

  staticTileRangeForViewport(level, { ring = 0, useLevelScale = false } = {}) {
    const viewScale = useLevelScale ? level.scale : Math.max(1e-6, this.scale);
    const halfWidth = this.width / (2 * viewScale);
    const halfHeight = this.height / (2 * viewScale);
    const margin = STATIC_FULL_MAP_MARGIN_PIXELS / level.scale;
    const minimumX = Math.max(-margin, this.centerX - halfWidth);
    const maximumX = Math.min(this.worldWidth + margin, this.centerX + halfWidth);
    const minimumY = Math.max(-margin, this.centerY - halfHeight);
    const maximumY = Math.min(this.worldHeight + margin, this.centerY + halfHeight);
    if (minimumX > maximumX || minimumY > maximumY) {
      return null;
    }
    return {
      firstColumn: Math.floor((minimumX * level.scale) / STATIC_TILE_SIZE) - ring,
      lastColumn: Math.floor((maximumX * level.scale) / STATIC_TILE_SIZE) + ring,
      firstRow: Math.floor((minimumY * level.scale) / STATIC_TILE_SIZE) - ring,
      lastRow: Math.floor((maximumY * level.scale) / STATIC_TILE_SIZE) + ring,
    };
  }

  staticTileJobsForRange(level, range, priority) {
    if (!range) {
      return [];
    }
    const jobs = [];
    for (let column = range.firstColumn; column <= range.lastColumn; column += 1) {
      for (let row = range.firstRow; row <= range.lastRow; row += 1) {
        jobs.push({
          key: this.staticTileKey(level, column, row),
          level,
          column,
          row,
          priority,
          generation: this.staticTileGeneration,
        });
      }
    }
    return jobs;
  }

  rebuildStaticTilePreparation() {
    if (!this.staticTileModeEnabled() || !this.staticTileReady || !this.staticTileWorker) {
      return false;
    }
    const activeProfile = staticRenderProfileForZoom(this.zoom);
    const profiles = this.staticRenderOptions.prepareAllLayers
      ? STATIC_RENDER_PROFILES
      : [activeProfile];
    const jobsByKey = new Map();
    this.staticTileDetailLevels = new Map();
    this.staticTileFullLevels = new Map();

    const appendJobs = (jobs) => {
      for (const job of jobs) {
        const previous = jobsByKey.get(job.key);
        if (!previous || job.priority < previous.priority) {
          jobsByKey.set(job.key, job);
        }
      }
    };

    for (const profile of profiles) {
      const level = this.createStaticTileLevel(
        profile,
        this.fitScale * profile.zoom,
        "detail",
      );
      this.staticTileDetailLevels.set(profile.id, level);
      const isActive = profile.id === activeProfile.id;
      const range = this.staticTileRangeForViewport(level, {
        ring: isActive ? 1 : 0,
        useLevelScale: true,
      });
      appendJobs(this.staticTileJobsForRange(
        level,
        range,
        isActive ? 0 : 10 + Math.abs(Math.log(profile.zoom / activeProfile.zoom)),
      ));
    }

    let planLimited = false;
    if (this.staticRenderOptions.renderFullMap) {
      const tilesPerProfile = Math.max(
        4,
        Math.floor(STATIC_FULL_MAP_MAX_TILES / profiles.length),
      );
      for (const profile of profiles) {
        const plan = boundedFullMapTilePlan(
          this.worldWidth,
          this.worldHeight,
          this.fitScale * profile.zoom,
          { maxTiles: tilesPerProfile },
        );
        const level = this.createStaticTileLevel(profile, plan.scale, "full", plan);
        this.staticTileFullLevels.set(profile.id, level);
        planLimited ||= plan.limited;
        const isActive = profile.id === activeProfile.id;
        appendJobs(this.staticTileJobsForRange(
          level,
          plan,
          isActive ? 5 : 30 + Math.abs(Math.log(profile.zoom / activeProfile.zoom)),
        ));
      }
    }

    let jobs = [...jobsByKey.values()].sort((left, right) => (
      left.priority - right.priority || left.key.localeCompare(right.key)
    ));
    if (jobs.length > STATIC_TILE_CACHE_MAX_ENTRIES) {
      jobs = jobs.slice(0, STATIC_TILE_CACHE_MAX_ENTRIES);
      planLimited = true;
    }
    this.staticTilePlanKeys = new Set(jobs.map((job) => job.key));
    this.staticTileCompletedKeys = new Set(
      jobs.filter((job) => this.staticTileCache.has(job.key)).map((job) => job.key),
    );
    this.staticTilePlanLimited = planLimited;
    this.staticTileQueue = [];
    this.staticTileQueuedKeys.clear();
    for (const job of jobs) {
      this.queueStaticTileJob(job, { pump: false });
    }
    this.updateStaticTilePresentation({ force: false, queueMissing: false });
    this.notifyStaticPreparation(
      this.staticTileQueue.length || this.staticTilePending ? "preparing" : (
        this.staticTilePlanLimited ? "limited" : "ready"
      ),
    );
    this.pumpStaticTileQueue();
    return true;
  }

  restartStaticTilePreparation({ clearCache = true } = {}) {
    if (!this.staticTileModeEnabled()) {
      return false;
    }
    this.staticTileGeneration = Number(this.staticTileGeneration || 0) + 1;
    this.resetStaticTilePlan({ clearCache });
    if (this.staticTileReady && this.staticTileWorker) {
      return this.rebuildStaticTilePreparation();
    }
    return this.syncStaticTileRenderer();
  }

  scheduleStaticTilePreparationRefresh() {
    if (
      !this.staticTileModeEnabled()
      || !this.staticTileReady
      || this.staticTilePreparationRefreshTimer !== null
    ) {
      return false;
    }
    this.staticTilePreparationRefreshTimer = setTimeout(() => {
      this.staticTilePreparationRefreshTimer = null;
      if (!this.destroyed && this.staticTileModeEnabled()) {
        this.rebuildStaticTilePreparation();
      }
    }, 0);
    return true;
  }

  removeStaticTilePlanKey(key, { releaseCache = false } = {}) {
    this.staticTilePlanKeys.delete(key);
    this.staticTileCompletedKeys.delete(key);
    this.staticTileQueuedKeys.delete(key);
    if (releaseCache) {
      const entry = this.staticTileCache.get(key);
      if (entry && !entry.slot?.isConnected) {
        this.staticTileCache.delete(key);
        this.staticTileCacheBytes -= entry.bytes;
        this.releaseStaticTileEntry(entry);
      }
    }
  }

  makeRoomForStaticTileJob(job) {
    if (
      this.staticTilePlanKeys.has(job.key)
      || this.staticTilePlanKeys.size < STATIC_TILE_CACHE_MAX_ENTRIES
    ) {
      return true;
    }
    for (let index = this.staticTileQueue.length - 1; index >= 0; index -= 1) {
      const candidate = this.staticTileQueue[index];
      if (candidate.priority <= job.priority) {
        continue;
      }
      this.staticTileQueue.splice(index, 1);
      this.removeStaticTilePlanKey(candidate.key);
      this.staticTilePlanLimited = true;
      return true;
    }
    for (const [key, entry] of this.staticTileCache) {
      if (!entry.slot?.isConnected && key !== job.key) {
        this.removeStaticTilePlanKey(key, { releaseCache: true });
        this.staticTilePlanLimited = true;
        return true;
      }
    }
    this.staticTilePlanLimited = true;
    return false;
  }

  queueStaticTileJob(job, { pump = true } = {}) {
    if (!job || job.generation !== this.staticTileGeneration) {
      return false;
    }
    if (!this.makeRoomForStaticTileJob(job)) {
      return false;
    }
    this.staticTilePlanKeys.add(job.key);
    if (this.staticTileCache.has(job.key)) {
      this.staticTileCompletedKeys.add(job.key);
      this.touchStaticTileEntry(job.key);
      return false;
    }
    if (this.staticTilePending?.job?.key === job.key || this.staticTileQueuedKeys.has(job.key)) {
      return false;
    }
    this.staticTileQueue.push(job);
    this.staticTileQueuedKeys.add(job.key);
    this.staticTileQueue.sort((left, right) => (
      left.priority - right.priority || left.key.localeCompare(right.key)
    ));
    if (pump) {
      this.notifyStaticPreparation("preparing");
      this.pumpStaticTileQueue();
    }
    return true;
  }

  pumpStaticTileQueue() {
    if (
      !this.staticTileModeEnabled()
      || !this.staticTileReady
      || !this.staticTileWorker
      || this.staticTilePending
    ) {
      return false;
    }
    let job = null;
    while (this.staticTileQueue.length) {
      const candidate = this.staticTileQueue.shift();
      this.staticTileQueuedKeys.delete(candidate.key);
      if (
        candidate.generation === this.staticTileGeneration
        && !this.staticTileCache.has(candidate.key)
      ) {
        job = candidate;
        break;
      }
      if (this.staticTileCache.has(candidate.key)) {
        this.staticTileCompletedKeys.add(candidate.key);
      }
    }
    if (!job) {
      this.notifyStaticPreparation(this.staticTilePlanLimited ? "limited" : "ready");
      return false;
    }

    const requestId = ++this.staticTileRequestId;
    const view = {
      width: STATIC_TILE_SIZE,
      height: STATIC_TILE_SIZE,
      padding: STATIC_TILE_PADDING,
      pixelRatio: 1,
      centerX: (job.column * STATIC_TILE_SIZE + STATIC_TILE_SIZE / 2) / job.level.scale,
      centerY: (job.row * STATIC_TILE_SIZE + STATIC_TILE_SIZE / 2) / job.level.scale,
      scale: job.level.scale,
      zoom: job.level.profile.zoom,
    };
    const pois = this.staticPoiPayloadForView(view);
    this.staticTilePending = { requestId, job, view };
    try {
      this.staticTileWorker.postMessage({
        type: "render",
        requestId,
        view,
        pois: pois.payload,
        mapBounds: { worldWidth: this.worldWidth, worldHeight: this.worldHeight },
      });
      this.staticTileTimeout = setTimeout(
        () => this.handleStaticTileTimeout(requestId),
        STATIC_TILE_RENDER_TIMEOUT_MS,
      );
      return true;
    } catch {
      this.failStaticTileRenderer();
      return false;
    }
  }

  handleStaticTileTimeout(requestId) {
    const pending = this.staticTilePending;
    if (this.destroyed || pending?.requestId !== requestId) {
      return;
    }
    if (pending.job.generation !== this.staticTileGeneration) {
      this.staticTilePending = null;
      this.staticTileTimeout = null;
      this.pumpStaticTileQueue();
      return;
    }
    this.failStaticTileRenderer();
  }

  handleStaticTileRendererMessage(event) {
    const message = event.data || {};
    if (this.destroyed) {
      message.bitmap?.close?.();
      return;
    }
    if (message.type === "ready") {
      if (this.staticTileTimeout !== null) {
        clearTimeout(this.staticTileTimeout);
        this.staticTileTimeout = null;
      }
      this.staticTileReady = true;
      this.rebuildStaticTilePreparation();
      return;
    }
    if (message.type === "error") {
      if (
        message.requestId === null
        || message.requestId === undefined
        || message.requestId === this.staticTilePending?.requestId
      ) {
        if (
          this.staticTilePending
          && this.staticTilePending.job.generation !== this.staticTileGeneration
        ) {
          if (this.staticTileTimeout !== null) {
            clearTimeout(this.staticTileTimeout);
            this.staticTileTimeout = null;
          }
          this.staticTilePending = null;
          this.pumpStaticTileQueue();
          return;
        }
        this.failStaticTileRenderer();
      }
      return;
    }
    if (message.type !== "rendered") {
      return;
    }
    const pending = this.staticTilePending;
    if (!pending || message.requestId !== pending.requestId) {
      message.bitmap?.close?.();
      return;
    }
    if (this.staticTileTimeout !== null) {
      clearTimeout(this.staticTileTimeout);
      this.staticTileTimeout = null;
    }
    this.staticTilePending = null;
    if (
      pending.job.generation !== this.staticTileGeneration
      || !this.staticTileModeEnabled()
    ) {
      message.bitmap?.close?.();
      this.pumpStaticTileQueue();
      return;
    }
    const entry = this.createStaticTileEntry(pending.job, message.bitmap);
    if (!entry) {
      this.failStaticTileRenderer();
      return;
    }
    this.storeStaticTileEntry(entry);
    if (this.staticTilePlanKeys.has(pending.job.key)) {
      this.staticTileCompletedKeys.add(pending.job.key);
    }
    if (
      pending.job.level.profile.id === staticRenderProfileForZoom(this.zoom).id
    ) {
      this.updateStaticTilePresentation({ force: true, queueMissing: false });
    }
    this.notifyStaticPreparation("preparing");
    this.pumpStaticTileQueue();
  }

  createStaticTileEntry(job, bitmap) {
    const ownerDocument = this.container?.ownerDocument || globalThis.document;
    if (!bitmap || !ownerDocument?.createElement) {
      bitmap?.close?.();
      return null;
    }
    try {
      const prepareCanvas = (canvas) => {
        canvas.className = "local-map-tile-canvas";
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.style.width = `${STATIC_TILE_SIZE + STATIC_TILE_PADDING * 2}px`;
        canvas.style.height = `${STATIC_TILE_SIZE + STATIC_TILE_PADDING * 2}px`;
        canvas.style.left = `${-STATIC_TILE_PADDING}px`;
        canvas.style.top = `${-STATIC_TILE_PADDING}px`;
        return canvas;
      };
      let canvas = prepareCanvas(ownerDocument.createElement("canvas"));
      let presented = false;
      try {
        const bitmapContext = canvas.getContext("bitmaprenderer", { alpha: false });
        if (bitmapContext?.transferFromImageBitmap) {
          bitmapContext.transferFromImageBitmap(bitmap);
          presented = true;
        }
      } catch {
        // Context mode is permanent; the fresh canvas below owns the fallback.
      }
      if (!presented) {
        const failedCanvas = canvas;
        canvas = prepareCanvas(ownerDocument.createElement("canvas"));
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) {
          bitmap.close?.();
          return null;
        }
        context.drawImage(bitmap, 0, 0);
        failedCanvas.width = 0;
        failedCanvas.height = 0;
      }
      bitmap.close?.();

      const slot = ownerDocument.createElement("div");
      slot.className = "local-map-tile-slot";
      slot.style.left = `${job.column * STATIC_TILE_SIZE}px`;
      slot.style.top = `${job.row * STATIC_TILE_SIZE}px`;
      slot.style.width = `${STATIC_TILE_SIZE}px`;
      slot.style.height = `${STATIC_TILE_SIZE}px`;
      slot.append(canvas);
      return {
        key: job.key,
        job,
        canvas,
        slot,
        bytes: Math.max(
          STATIC_TILE_BITMAP_BYTES,
          Number(canvas.width || 0) * Number(canvas.height || 0) * 4,
        ),
      };
    } catch {
      bitmap.close?.();
      return null;
    }
  }

  storeStaticTileEntry(entry) {
    const previous = this.staticTileCache.get(entry.key);
    if (previous) {
      this.staticTileCacheBytes -= previous.bytes;
      this.releaseStaticTileEntry(previous);
      this.staticTileCache.delete(entry.key);
    }
    this.staticTileCache.set(entry.key, entry);
    this.staticTileCacheBytes += entry.bytes;
    this.evictStaticTileCache();
  }

  touchStaticTileEntry(key) {
    const entry = this.staticTileCache.get(key);
    if (!entry) {
      return null;
    }
    this.staticTileCache.delete(key);
    this.staticTileCache.set(key, entry);
    return entry;
  }

  evictStaticTileCache() {
    let stalled = 0;
    while (
      this.staticTileCacheBytes > STATIC_TILE_CACHE_MAX_BYTES
      && this.staticTileCache.size
      && stalled <= this.staticTileCache.size
    ) {
      const [key, entry] = this.staticTileCache.entries().next().value;
      if (entry.slot?.isConnected) {
        this.staticTileCache.delete(key);
        this.staticTileCache.set(key, entry);
        stalled += 1;
        continue;
      }
      this.staticTileCache.delete(key);
      this.staticTileCacheBytes -= entry.bytes;
      this.releaseStaticTileEntry(entry);
      this.staticTileCompletedKeys.delete(key);
      this.staticTilePlanKeys.delete(key);
      stalled = 0;
      this.staticTilePlanLimited = true;
    }
    if (this.staticTileCacheBytes > STATIC_TILE_CACHE_MAX_BYTES) {
      this.staticTilePlanLimited = true;
    }
  }

  staticTileLayerTransform(level) {
    const ratio = this.scale / level.scale;
    const translateX = this.width / 2 - this.centerX * this.scale;
    const translateY = this.height / 2 - this.centerY * this.scale;
    return {
      ratio,
      css: `matrix(${ratio}, 0, 0, ${ratio}, ${translateX}, ${translateY})`,
    };
  }

  configureStaticTileSlot(entry, level) {
    const tileStartX = entry.job.column * STATIC_TILE_SIZE;
    const tileStartY = entry.job.row * STATIC_TILE_SIZE;
    let minimumX = tileStartX;
    let maximumX = tileStartX + STATIC_TILE_SIZE;
    let minimumY = tileStartY;
    let maximumY = tileStartY + STATIC_TILE_SIZE;
    if (level.kind === "full") {
      minimumX = Math.max(minimumX, -STATIC_FULL_MAP_MARGIN_PIXELS);
      maximumX = Math.min(
        maximumX,
        this.worldWidth * level.scale + STATIC_FULL_MAP_MARGIN_PIXELS,
      );
      minimumY = Math.max(minimumY, -STATIC_FULL_MAP_MARGIN_PIXELS);
      maximumY = Math.min(
        maximumY,
        this.worldHeight * level.scale + STATIC_FULL_MAP_MARGIN_PIXELS,
      );
    }
    const width = Math.max(0, maximumX - minimumX);
    const height = Math.max(0, maximumY - minimumY);
    entry.slot.style.left = `${minimumX}px`;
    entry.slot.style.top = `${minimumY}px`;
    entry.slot.style.width = `${width}px`;
    entry.slot.style.height = `${height}px`;
    entry.canvas.style.left = `${tileStartX - STATIC_TILE_PADDING - minimumX}px`;
    entry.canvas.style.top = `${tileStartY - STATIC_TILE_PADDING - minimumY}px`;
    return width > 0 && height > 0;
  }

  mountStaticTileRange(
    layer,
    level,
    range,
    signatureProperty,
    { force = false, requireComplete = false } = {},
  ) {
    if (!layer || !level || !range) {
      layer?.replaceChildren?.();
      if (layer) {
        layer.hidden = true;
      }
      this[signatureProperty] = null;
      return 0;
    }
    const signature = [
      level.id,
      range.firstColumn,
      range.lastColumn,
      range.firstRow,
      range.lastRow,
    ].join(":");
    const sameRange = signature === this[signatureProperty];
    if (!force && sameRange) {
      return layer.childElementCount || 0;
    }
    const ownerDocument = this.container?.ownerDocument || globalThis.document;
    const entries = [];
    let expected = 0;
    for (let column = range.firstColumn; column <= range.lastColumn; column += 1) {
      for (let row = range.firstRow; row <= range.lastRow; row += 1) {
        expected += 1;
        const entry = this.touchStaticTileEntry(this.staticTileKey(level, column, row));
        if (!entry) {
          continue;
        }
        entries.push(entry);
      }
    }
    if (requireComplete && entries.length !== expected) {
      if (!sameRange || !layer.hidden) {
        layer.replaceChildren();
      }
      layer.hidden = true;
      this[signatureProperty] = signature;
      return 0;
    }

    if (
      sameRange
      && force
      && requireComplete
      && entries.every((entry) => entry.slot.parentNode === layer)
    ) {
      return entries.length;
    }

    if (sameRange && force && !requireComplete) {
      for (const entry of entries) {
        if (
          this.configureStaticTileSlot(entry, level)
          && entry.slot.parentNode !== layer
        ) {
          layer.append(entry.slot);
        }
      }
      layer.hidden = entries.length === 0;
      return entries.length;
    }

    const fragment = ownerDocument?.createDocumentFragment?.();
    if (!fragment) {
      return 0;
    }
    let mounted = 0;
    for (const entry of entries) {
      if (this.configureStaticTileSlot(entry, level)) {
        fragment.append(entry.slot);
        mounted += 1;
      }
    }
    layer.replaceChildren(fragment);
    layer.hidden = mounted === 0;
    this[signatureProperty] = signature;
    return mounted;
  }

  queueMissingStaticDetailTiles(level, range) {
    if (!range || !level) {
      return;
    }
    const jobs = this.staticTileJobsForRange(level, range, -20);
    const currentKeys = new Set(jobs.map((job) => job.key));
    this.staticTileQueue = this.staticTileQueue.filter((queuedJob) => {
      if (queuedJob.priority > -20 || currentKeys.has(queuedJob.key)) {
        return true;
      }
      this.removeStaticTilePlanKey(queuedJob.key);
      return false;
    });
    let queued = false;
    for (const job of jobs) {
      queued = this.queueStaticTileJob(job, { pump: false }) || queued;
    }
    if (queued) {
      this.notifyStaticPreparation("preparing");
      this.pumpStaticTileQueue();
    }
  }

  updateStaticTilePresentation({ force = false, queueMissing = true } = {}) {
    if (!this.staticTileModeEnabled() || !this.staticTileReady) {
      return false;
    }
    const profile = staticRenderProfileForZoom(this.zoom);
    const detailLevel = this.staticTileDetailLevels.get(profile.id);
    const fullLevel = this.staticRenderOptions.renderFullMap
      ? this.staticTileFullLevels.get(profile.id)
      : null;
    if (!detailLevel) {
      this.rebuildStaticTilePreparation();
      return false;
    }

    let fullMounted = 0;
    let fullTransform = null;
    if (fullLevel) {
      fullTransform = this.staticTileLayerTransform(fullLevel);
      this.staticFullMapLayer.style.transform = fullTransform.css;
      fullMounted = this.mountStaticTileRange(
        this.staticFullMapLayer,
        fullLevel,
        fullLevel.range,
        "staticTileFullSignature",
        { force, requireComplete: true },
      );
    } else {
      this.mountStaticTileRange(
        this.staticFullMapLayer,
        null,
        null,
        "staticTileFullSignature",
      );
    }

    let detailMounted = 0;
    if (detailLevel && detailLevel.id !== fullLevel?.id) {
      const detailRange = this.staticTileRangeForViewport(detailLevel, { ring: 1 });
      const transform = this.staticTileLayerTransform(detailLevel);
      this.staticTileLayer.style.transform = transform.css;
      detailMounted = this.mountStaticTileRange(
        this.staticTileLayer,
        detailLevel,
        detailRange,
        "staticTileDetailSignature",
        { force },
      );
      if (queueMissing) {
        this.queueMissingStaticDetailTiles(detailLevel, detailRange);
      }
    } else {
      this.mountStaticTileRange(
        this.staticTileLayer,
        null,
        null,
        "staticTileDetailSignature",
      );
    }

    const tilesOnTop = this.viewportGestureActive();
    this.viewportLayer.style.zIndex = tilesOnTop ? "1" : "3";
    this.staticFullMapLayer.style.zIndex = (
      tilesOnTop && fullTransform?.ratio <= 2.25
    ) ? "2" : "0";
    this.staticTileLayer.style.zIndex = tilesOnTop ? "3" : "2";
    this.heatmapCanvas.style.zIndex = "4";
    this.poiLabelCanvas.style.zIndex = "5";
    this.agentCanvas.style.zIndex = "6";
    return fullMounted + detailMounted > 0;
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
    return this.staticPoiPayloadFromEntries(view, level, entries);
  }

  staticPoiPayloadForView(view) {
    const level = poiLodForZoom(view.zoom);
    if (!level || !this.activePoiCategories.size) {
      return { payload: [], entries: [], radius: 0 };
    }
    const entries = this.visiblePoiEntriesForView(level, view, 30);
    return this.staticPoiPayloadFromEntries(view, level, entries);
  }

  staticPoiPayloadFromEntries(view, level, entries) {
    const payload = entries.map((entry) => ({
      x: entry.world.x,
      y: entry.world.y,
      color: poiStyle(entry.category).color,
    }));
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
        mapBounds: this.staticRenderOptions?.renderFullMap
          ? { worldWidth: this.worldWidth, worldHeight: this.worldHeight }
          : undefined,
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
        this.scheduleViewportDraw();
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
      if (!this.presentBaseBitmap(message.bitmap)) {
        throw new Error("Static bitmap presentation failed");
      }
      this.baseRenderView = view;
      this.refreshRenderedPois(metadata?.entries || [], view, metadata?.radius || 0);
      this.drawPoiLabels();
    } catch {
      this.fallbackFromStaticRendererFailure();
      return;
    }

    this.staticRenderQueued = false;
    if (this.viewportInteraction) {
      this.commitViewportInteraction();
    } else {
      this.viewportLayer.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
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

  visiblePoiEntriesForView(level, view, extraPaddingPixels = 30) {
    if (!level || !this.poiEntries.length || !this.activePoiCategories.size) {
      return [];
    }
    const reachX = view.width / 2 + view.padding + extraPaddingPixels;
    const reachY = view.height / 2 + view.padding + extraPaddingPixels;
    const minimumX = view.centerX - reachX / view.scale;
    const maximumX = view.centerX + reachX / view.scale;
    const minimumY = view.centerY - reachY / view.scale;
    const maximumY = view.centerY + reachY / view.scale;
    const firstColumn = Math.floor(minimumX / level.cellSize);
    const lastColumn = Math.floor(maximumX / level.cellSize);
    const firstRow = Math.floor(minimumY / level.cellSize);
    const lastRow = Math.floor(maximumY / level.cellSize);
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
    this.drawPoiLabels();
    this.staticRenderRevision = Number(this.staticRenderRevision || 0) + 1;
    this.restartStaticTilePreparation({ clearCache: true });
    if (this.viewportInteraction && this.viewportGestureActive()) {
      this.staticRenderQueued = true;
      return;
    }
    if (this.staticRenderReady && this.requestStaticRender()) {
      return;
    }
    const rebaseAgents = Boolean(this.viewportInteraction);
    if (rebaseAgents) {
      this.finishViewportInteraction({ redraw: false });
    }
    this.drawBase();
    if (rebaseAgents) {
      // completeViewportInteraction removes the preview matrix. Redraw in the
      // current view in the same task so a POI filter change cannot expose the
      // previous agent coordinate system for one frame.
      this.drawAgents(performance.now());
    }
  }

  setTrafficHeatmapEnabled(enabled) {
    this.trafficHeatmapEnabled = Boolean(enabled);
    this.heatmapCanvas.hidden = !this.trafficHeatmapEnabled;
    if (this.viewportInteraction) {
      this.heatmapDirty = true;
    } else {
      this.drawTrafficHeatmap();
    }
    this.drawAgents(performance.now());
  }

  setSegmentStatistics(statistics) {
    this.segmentStatistics = statistics instanceof Map
      ? new Map(statistics)
      : new Map(Object.entries(statistics || {}));
    if (this.viewportInteraction) {
      this.heatmapDirty = true;
      return;
    }
    this.drawTrafficHeatmap();
  }

  drawTrafficHeatmap() {
    const context = this.heatmapContext;
    if (!context) {
      return;
    }
    const pixelRatio = this.overlayPixelRatio || this.agentPixelRatio || 1;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    this.heatmapDirty = false;
    if (!this.trafficHeatmapEnabled || !this.segmentStatistics.size) {
      this.heatmapRenderView = null;
      this.heatmapCanvas.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
      return;
    }

    const detailed = this.zoom >= DETAILED_ROAD_MIN_ZOOM;
    const laneWidth = clamp(1.35 + Math.sqrt(this.zoom) * 0.55, 2, 5.2);
    const groups = new Map();
    for (const entry of this.visibleSegmentEntries(55)) {
      if (!entry.supportsCars || !roadVisibleAtZoom(entry, this.zoom)) {
        continue;
      }
      const statistics = this.segmentStatistics.get(String(entry.segment.id));
      if (!statistics || !statistics.hasRecentTraffic) {
        continue;
      }
      const bucket = clamp(Math.round(Number(statistics.loadPercent || 0) / 5) * 5, 0, 100);
      const roadWidth = detailed
        ? Math.max(entry.style.width * 1.4, entry.totalLanes * laneWidth)
        : Math.max(2.2, entry.style.width + 1.4);
      const groupKey = `${bucket}:${roadWidth.toFixed(2)}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          color: trafficLoadColor(bucket),
          roadWidth,
          path: new Path2D(),
        });
      }
      const start = this.worldToScreen(entry.start);
      const end = this.worldToScreen(entry.end);
      const path = groups.get(groupKey).path;
      path.moveTo(start.x, start.y);
      path.lineTo(end.x, end.y);
    }

    context.save();
    context.lineCap = "butt";
    for (const { color, roadWidth, path } of groups.values()) {
      context.strokeStyle = "rgba(3, 10, 8, 0.72)";
      context.lineWidth = roadWidth + 2.4;
      context.globalAlpha = 0.84;
      context.stroke(path);
      context.strokeStyle = color;
      context.lineWidth = roadWidth;
      context.globalAlpha = 0.9;
      context.stroke(path);
    }
    context.restore();
    this.heatmapRenderView = {
      width: this.width,
      height: this.height,
      centerX: this.centerX,
      centerY: this.centerY,
      scale: this.scale,
      zoom: this.zoom,
    };
    this.heatmapCanvas.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
  }

  resize(initial = false) {
    const rectangle = this.container.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rectangle.width));
    const nextHeight = Math.max(1, Math.round(rectangle.height));
    const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.containerLeft = rectangle.left;
    this.containerTop = rectangle.top;
    if (
      !initial
      && nextWidth === this.width
      && nextHeight === this.height
      && devicePixelRatio === this.devicePixelRatio
    ) {
      // ResizeObserver delivers an initial notification after observe(). The
      // constructor already rendered this exact surface, so do not repeat the
      // full static and agent draw.
      return;
    }
    if (this.viewportInteraction) {
      this.finishViewportInteraction({ redraw: false });
    }
    this.width = nextWidth;
    this.height = nextHeight;
    this.devicePixelRatio = devicePixelRatio;
    this.basePixelRatio = Math.min(devicePixelRatio, BASE_CANVAS_MAX_PIXEL_RATIO);
    this.overlayPixelRatio = Math.min(devicePixelRatio, 1.5);
    this.agentPixelRatio = agentPixelRatioForLoad(
      devicePixelRatio,
      this.agents.length,
      this.agentColorModes,
    );
    this.pendingAgentResolutionSync = false;
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
    resizeCanvas(this.heatmapCanvas, this.width, this.height, this.overlayPixelRatio);
    resizeCanvas(this.poiLabelCanvas, this.width, this.height, this.overlayPixelRatio);
    resizeCanvas(this.agentCanvas, this.width, this.height, this.agentPixelRatio);
    this.baseCanvas.style.left = `${-this.baseOverscan}px`;
    this.baseCanvas.style.top = `${-this.baseOverscan}px`;
    this.heatmapCanvas.style.left = "0px";
    this.heatmapCanvas.style.top = "0px";
    this.poiLabelCanvas.style.left = "0px";
    this.poiLabelCanvas.style.top = "0px";
    this.agentCanvas.style.left = "0px";
    this.agentCanvas.style.top = "0px";
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
      this.restartStaticTilePreparation({ clearCache: true });
    }
  }

  syncAgentCanvasResolution(agentCount = this.agents.length) {
    if (this.viewportInteraction) {
      this.pendingAgentResolutionSync = true;
      return false;
    }
    const nextPixelRatio = agentPixelRatioForLoad(
      this.devicePixelRatio || globalThis.devicePixelRatio || 1,
      agentCount,
      this.agentColorModes,
      this.agentPixelRatio,
    );
    const backingWidth = Math.round(this.width * nextPixelRatio);
    const backingHeight = Math.round(this.height * nextPixelRatio);
    const changed = (
      this.agentPixelRatio !== nextPixelRatio
      || this.agentCanvas.width !== backingWidth
      || this.agentCanvas.height !== backingHeight
    );
    if (!changed) {
      this.pendingAgentResolutionSync = false;
      return false;
    }
    this.pendingAgentResolutionSync = false;
    this.agentPixelRatio = nextPixelRatio;
    this.pixelRatio = nextPixelRatio;
    this.agentCanvas.width = backingWidth;
    this.agentCanvas.height = backingHeight;
    this.agentCanvas.style.width = `${this.width}px`;
    this.agentCanvas.style.height = `${this.height}px`;
    return true;
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
    this.restartStaticTilePreparation({ clearCache: true });
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
    // A pointer drag supersedes a still-open wheel burst. Keep the same frozen
    // viewport, but prevent the wheel idle timer from committing mid-drag.
    this.cancelViewportCommitTimer();
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
    const startsWheelBurst = !this.viewportInteraction;
    if (startsWheelBurst) {
      // Read geometry before beginViewportInteraction performs any state or DOM
      // writes. The remaining high-frequency events in this wheel burst reuse it.
      const rectangle = this.container.getBoundingClientRect();
      this.containerLeft = rectangle.left;
      this.containerTop = rectangle.top;
    }
    this.beginViewportInteraction();
    const cursorX = event.clientX - this.containerLeft;
    const cursorY = event.clientY - this.containerTop;
    const worldBefore = this.screenToWorld(cursorX, cursorY);
    const factor = Math.exp(-event.deltaY * 0.0014);
    this.zoom = clamp(this.zoom * factor, 0.8, 40);
    this.scale = this.fitScale * this.zoom;
    this.centerX = worldBefore.x - (cursorX - this.width / 2) / this.scale;
    this.centerY = worldBefore.y - (cursorY - this.height / 2) / this.scale;
    this.scheduleViewportDraw();
    if (!this.dragState?.viewChanged) {
      // Pointer-up owns the commit during a drag. A simultaneous trackpad wheel
      // must not arm an idle timer that could publish a frame mid-drag.
      this.scheduleViewportCommit();
    }
  }

  beginViewportInteraction() {
    if (this.viewportInteraction) {
      return;
    }
    this.viewportInteraction = {
      centerX: this.centerX,
      centerY: this.centerY,
      scale: this.scale,
    };
    this.onViewportInteractionChange?.(true);
  }

  scheduleViewportCommit() {
    this.viewportCommitDeadline = performance.now() + VIEWPORT_COMMIT_DELAY_MS;
    if (this.viewportCommitTimer !== null) {
      return;
    }
    const commitWhenIdle = () => {
      this.viewportCommitTimer = null;
      const remaining = Number(this.viewportCommitDeadline) - performance.now();
      if (this.viewportInteraction && remaining > 0.5) {
        this.viewportCommitTimer = setTimeout(commitWhenIdle, remaining);
        return;
      }
      this.viewportCommitDeadline = null;
      this.finishViewportInteraction();
    };
    this.viewportCommitTimer = setTimeout(commitWhenIdle, VIEWPORT_COMMIT_DELAY_MS);
  }

  cancelViewportCommitTimer() {
    if (this.viewportCommitTimer !== null) {
      clearTimeout(this.viewportCommitTimer);
      this.viewportCommitTimer = null;
    }
    this.viewportCommitDeadline = null;
  }

  applyViewportTransform() {
    if (!this.viewportInteraction) {
      return;
    }
    // Both existing bitmaps get a cheap compositor preview. The agent scheduler
    // continues drawing directly in the current view and removes its preview
    // matrix whenever it publishes a fresh dynamic frame.
    const targetView = {
      centerX: this.centerX,
      centerY: this.centerY,
      scale: this.scale,
      zoom: this.zoom,
    };
    const matrixFor = (sourceView) => {
      const transform = viewportPreviewTransform(
        sourceView,
        targetView,
        this.width,
        this.height,
      );
      return `matrix(${transform.ratio}, 0, 0, ${transform.ratio}, ${transform.translateX}, ${transform.translateY})`;
    };
    this.viewportLayer.style.transform = matrixFor(
      this.baseRenderView || this.viewportInteraction,
    );
    this.agentCanvas.style.transform = matrixFor(
      this.agentRenderView || this.viewportInteraction,
    );
    if (this.trafficHeatmapEnabled && this.heatmapRenderView) {
      this.heatmapCanvas.style.transform = matrixFor(this.heatmapRenderView);
    }
    this.updateStaticTilePresentation();
  }

  finishViewportInteraction({ redraw = true } = {}) {
    this.cancelViewportCommitTimer();
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
    if (this.pendingAgentResolutionSync) {
      // The old agent texture must remain untouched for the entire gesture.
      // Resize it only in the exact base/agent/transform commit transaction.
      const interaction = this.viewportInteraction;
      this.viewportInteraction = null;
      this.syncAgentCanvasResolution(this.agents.length);
      this.viewportInteraction = interaction;
    }
    // Preserve the live interpolation state. Resetting previousAgents or the
    // transition clock here would jump every moving agent to the newest server
    // snapshot exactly when the gesture ends.
    this.drawTrafficHeatmap();
    this.drawPoiLabels();
    this.drawAgents(timestamp);
    this.completeViewportInteraction();
  }

  completeViewportInteraction() {
    this.viewportInteraction = null;
    this.viewportLayer.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
    if (this.agentCanvas?.style) {
      this.agentCanvas.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
    }
    if (this.heatmapCanvas?.style) {
      this.heatmapCanvas.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
    }
    if (this.poiLabelCanvas?.style) {
      this.poiLabelCanvas.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
    }
    if (this.staticTileModeEnabled()) {
      this.updateStaticTilePresentation();
      this.scheduleStaticTilePreparationRefresh();
    }
    this.onViewportInteractionChange?.(false);
  }

  isViewportInteracting() {
    return Boolean(this.viewportInteraction);
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
        this.drawPoiLabels();
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
    const context = this.prepareBaseRenderSurface();
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
    context.fillStyle = this.staticRenderOptions?.renderFullMap ? "#000000" : "#111b18";
    context.fillRect(
      -padding,
      -padding,
      this.width + padding * 2,
      this.height + padding * 2,
    );
    if (this.staticRenderOptions?.renderFullMap) {
      const firstX = (0 - this.centerX) * this.scale + this.width / 2;
      const firstY = (0 - this.centerY) * this.scale + this.height / 2;
      const lastX = (this.worldWidth - this.centerX) * this.scale + this.width / 2;
      const lastY = (this.worldHeight - this.centerY) * this.scale + this.height / 2;
      context.fillStyle = "#111b18";
      context.fillRect(
        Math.min(firstX, lastX),
        Math.min(firstY, lastY),
        Math.abs(lastX - firstX),
        Math.abs(lastY - firstY),
      );
    }

    if (this.zoom < DETAILED_ROAD_MIN_ZOOM) {
      this.drawOverview(context, padding);
    } else {
      this.drawDetailedRoads(context, padding);
    }
    if (this.zoom >= 7) {
      this.drawTurnArrows(context, padding);
    }
    this.drawPois(context, padding);
    if (!this.presentBaseRenderSurface()) {
      return false;
    }
    this.baseRenderView = this.staticViewSnapshot();
    this.drawTrafficHeatmap();
    this.drawPoiLabels();
    return true;
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

    context.restore();
  }

  drawPoiLabels() {
    const context = this.poiLabelContext;
    if (!context) {
      return;
    }
    const pixelRatio = this.overlayPixelRatio || this.agentPixelRatio || 1;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    const level = poiLodForZoom(this.zoom);
    if (!level || !this.activePoiCategories.size) {
      return;
    }

    const radius = clamp(2.4 + Math.log2(this.zoom + 1) * 0.45, 3, 5.2);
    context.save();
    context.font = "600 10px 'Segoe UI', system-ui, sans-serif";
    for (const entry of this.visiblePoiEntries(level, 45)) {
      const name = String(entry.poi.name || "").trim();
      if (!name || !this.isPoiLabelWinner(entry, level)) {
        continue;
      }
      const screen = this.worldToScreen(entry.world);
      if (
        screen.x < -40 || screen.y < -20
        || screen.x > this.width + 40 || screen.y > this.height + 20
      ) {
        continue;
      }
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
    this.poiLabelCanvas.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
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
    // The sibling agent canvas is always rendered directly in the current view;
    // only POIs on the static base need the inverse preview transform.
    const agentPoint = { x, y };
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
    const resolutionChanged = this.syncAgentCanvasResolution(nextAgents.length);
    const unchanged = this.agentFramesEqual(nextAgents);
    const animationWasActive = this.agentAnimationActive || this.animationFrame !== null;
    if (
      unchanged
      && !resolutionChanged
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
    const hasExplicitTransitionDuration = (
      transitionDurationMs !== null
      && transitionDurationMs !== undefined
      && Number.isFinite(explicitTransitionDuration)
      && explicitTransitionDuration >= 0
    );
    this.agentTransitionDurationMs = (
      hasExplicitTransitionDuration
    )
      ? explicitTransitionDuration
      : agentTransitionDuration(this.agentFrameIntervalMs);
    this.agentAnimationActive = Boolean(animate && nextAgents.length > 0);
    this.agentCurveInterpolationActive = Boolean(
      this.agentAnimationActive
      && observeInterval
      && !resetTiming
      && !hasExplicitTransitionDuration
    );
    this.transitionStarted = now;
    if (!animate && unchanged && !resolutionChanged && !resetTiming && !animationWasActive) {
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
    this.syncAgentCanvasResolution();
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
    this.agentCurveInterpolationActive = false;
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
    this.agentCurveInterpolationActive = false;
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
      const pose = this.interpolatedAgentPose(agent, progress, start);
      captured.set(agent.id, {
        ...agent,
        lat: pose.lat,
        lng: pose.lng,
        heading: pose.heading,
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
    if (this.animationFrame !== null) {
      return;
    }
    const animate = (timestamp) => {
      this.animationFrame = null;
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
        && Number(this.agentDrawDurationMs) >= LARGE_INDIVIDUAL_AGENT_SLOW_DRAW_MS
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
        if (this.lastAgentDrawAt !== timestamp) {
          this.drawAgents(timestamp);
        }
      }
      if (!transitionFinished) {
        this.animationFrame = requestAnimationFrame(animate);
      } else {
        this.agentCurveInterpolationActive = false;
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
    const drawStartedAt = performance.now();
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
    // The newly rendered bitmap already uses the current view. Publish removal
    // of the preview transform in the same JS task to avoid double-transforming
    // a fresh agent frame.
    if (this.agentCanvas?.style) {
      this.agentCanvas.style.transform = IDENTITY_VIEWPORT_TRANSFORM;
    }
    this.lastAgentDrawAt = timestamp;
    const drawDuration = Math.max(0, performance.now() - drawStartedAt);
    this.agentDrawDurationMs = (
      !Number.isFinite(this.agentDrawDurationMs)
      || drawDuration >= LARGE_INDIVIDUAL_AGENT_SLOW_DRAW_MS
    )
      ? drawDuration
      : this.agentDrawDurationMs * 0.75 + drawDuration * 0.25;
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

  interpolatedAgentPose(agent, progress, startAgent = null) {
    const start = startAgent || this.interpolationStartAgent(agent);
    const curve = Boolean(
      this.agentCurveInterpolationActive
      && agent.mode === "car"
      && !Boolean(start.waiting)
      && !Boolean(agent.waiting)
    );
    return interpolateGeographicPose(start, agent, progress, {
      curve,
      metersPerLongitudeDegree: this.metersPerLongitudeDegree,
    });
  }

  interpolatedAgentScreen(agent, progress, target = null) {
    const pose = this.interpolatedAgentPose(agent, progress);
    const screen = target || this.worldToScreen(this.coordinateToWorld(pose.lat, pose.lng));
    if (target) {
      const worldX = (Number(pose.lng) - this.bounds.west) * this.metersPerLongitudeDegree;
      const worldY = (this.bounds.north - Number(pose.lat)) * 111_320;
      screen.x = (worldX - this.centerX) * this.scale + this.width / 2;
      screen.y = (worldY - this.centerY) * this.scale + this.height / 2;
    }
    screen.heading = pose.heading;
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
    if (this.trafficHeatmapEnabled) {
      for (const batch of colorBatches.values()) {
        for (const mode of ["car", "pedestrian"]) {
          const screens = mode === "car" ? batch.carScreens : batch.pedestrianScreens;
          if (screens.length === 0) {
            continue;
          }
          context.beginPath();
          this.appendOverviewAgentShapes(context, mode, screens, metrics);
          context.globalAlpha = mode === "car" ? 0.16 : 0.9;
          context.fillStyle = batch.color;
          context.fill();
          context.globalAlpha = mode === "car" ? 0.2 : 0.9;
          context.strokeStyle = "rgba(7, 16, 15, 0.82)";
          context.lineWidth = metrics.outlineWidth * 2;
          context.stroke();
        }
      }
      for (const mode of ["car", "pedestrian"]) {
        if (waitingScreens[mode].length === 0) {
          continue;
        }
        context.beginPath();
        this.appendOverviewAgentShapes(context, mode, waitingScreens[mode], metrics);
        context.globalAlpha = mode === "car" ? 0.06 : 0.24;
        context.fillStyle = "#07100f";
        context.fill();
      }
    } else if (activeColorBatchCount > 2) {
      // Emit each shape only once per colour. fill() and stroke() retain the
      // current context path, halving JS-to-Canvas geometry calls compared with
      // rebuilding every shape for one shared outline pass.
      context.globalAlpha = 0.96;
      context.strokeStyle = "rgba(7, 16, 15, 0.82)";
      context.lineWidth = metrics.outlineWidth * 2;
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
        context.fillStyle = batch.color;
        context.fill();
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
    this.disableStaticTileRenderer({ clearCache: true });
    try {
      this.baseBitmapContext?.transferFromImageBitmap?.(null);
    } catch {
      // Destruction must remain best-effort even after a lost canvas context.
    }
    this.baseBitmapContext = null;
    this.baseRenderCanvas = null;
    if (this.viewportCommitTimer !== null) {
      clearTimeout(this.viewportCommitTimer);
    }
    this.viewportCommitDeadline = null;
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
    }
    if (this.viewportAnimationFrame !== null) {
      cancelAnimationFrame(this.viewportAnimationFrame);
    }
    this.container.removeEventListener("pointerdown", this.handlePointerDown);
    this.container.removeEventListener("pointermove", this.handlePointerMove);
    this.container.removeEventListener("pointerup", this.handlePointerUp);
    this.container.removeEventListener("pointercancel", this.handlePointerCancel);
    this.container.removeEventListener("wheel", this.handleWheel);
    this.container.removeEventListener("dblclick", this.handleDoubleClick);
  }
}
