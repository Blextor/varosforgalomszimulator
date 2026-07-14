import { LocalTrafficMap, POI_CATEGORY_STYLE, roadModeForSegment } from "./local-map.js";
import {
  STATE_PROTOCOL_VERSION,
  StateProtocolError,
  createStateProtocolCache,
  reduceSimulationState,
} from "./state-protocol.js";
import { pollDelayAfterElapsed } from "./simulation-timing.js";
import {
  REPLAY_SAMPLE_INTERVAL_MS,
  createReplayBuffer,
  replayFrameDelayMs,
} from "./replay-buffer.js";

const dom = {
  datasetPanel: document.querySelector("#dataset-panel"),
  networkStatus: document.querySelector("#network-status"),
  networkDetails: document.querySelector("#network-details"),
  mapRenderControls: document.querySelector(".map-render-controls"),
  prepareAllMapLayers: document.querySelector("#prepare-all-map-layers"),
  renderFullMap: document.querySelector("#render-full-map"),
  mapRenderStatus: document.querySelector("#map-render-status"),
  reloadNetwork: document.querySelector("#reload-network"),
  mapPlaceholder: document.querySelector("#map-placeholder"),
  routeStatus: document.querySelector("#route-status"),
  carCount: document.querySelector("#car-count"),
  carCountValue: document.querySelector("#car-count-value"),
  pedestrianCount: document.querySelector("#pedestrian-count"),
  pedestrianCountValue: document.querySelector("#pedestrian-count-value"),
  simulationSpeed: document.querySelector("#simulation-speed"),
  carIndividualColors: document.querySelector("#car-individual-colors"),
  pedestrianIndividualColors: document.querySelector("#pedestrian-individual-colors"),
  trafficHeatmap: document.querySelector("#traffic-heatmap"),
  legendTrafficHeatmap: document.querySelector("#legend-traffic-heatmap"),
  startPause: document.querySelector("#start-pause"),
  startPauseIcon: document.querySelector("#start-pause .button-icon"),
  startPauseLabel: document.querySelector("#start-pause .button-label"),
  reset: document.querySelector("#reset"),
  replayRange: document.querySelector("#replay-range"),
  replayPosition: document.querySelector("#replay-position"),
  replayPlay: document.querySelector("#replay-play"),
  replayPlayIcon: document.querySelector("#replay-play .button-icon"),
  replayPlayLabel: document.querySelector("#replay-play .button-label"),
  replayLive: document.querySelector("#replay-live"),
  carSpeed: document.querySelector("#car-speed"),
  pedestrianSpeed: document.querySelector("#pedestrian-speed"),
  congestion: document.querySelector("#congestion"),
  completedTrips: document.querySelector("#completed-trips"),
  clock: document.querySelector("#clock-chip"),
  notice: document.querySelector("#notice"),
  inspector: document.querySelector("#map-inspector"),
  inspectorName: document.querySelector("#inspector-name"),
  inspectorDetails: document.querySelector("#inspector-details"),
  closeInspector: document.querySelector("#close-inspector"),
  poiFilters: document.querySelector("#poi-filters"),
  poiFilterSummary: document.querySelector("#poi-filter-summary"),
  poiFilterAll: document.querySelector("#poi-filter-all"),
  poiFilterNone: document.querySelector("#poi-filter-none"),
  legendCarMarker: document.querySelector("#legend-car-marker"),
  legendPedestrianMarker: document.querySelector("#legend-pedestrian-marker"),
};

const AGENT_COLOR_STORAGE_KEY = "ujbuda-traffic-agent-color-modes-v1";
const MAP_RENDER_OPTIONS_STORAGE_KEY = "ujbuda-traffic-map-render-options-v1";
const TRAFFIC_HEATMAP_STORAGE_KEY = "ujbuda-traffic-heatmap-v1";

function normalizeStoredAgentColorModes(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    car: source.car === "individual" ? "individual" : "uniform",
    pedestrian: source.pedestrian === "individual" ? "individual" : "uniform",
  };
}

function loadAgentColorModes() {
  try {
    const serialized = globalThis.localStorage?.getItem(AGENT_COLOR_STORAGE_KEY);
    return normalizeStoredAgentColorModes(serialized ? JSON.parse(serialized) : null);
  } catch {
    return normalizeStoredAgentColorModes();
  }
}

function persistAgentColorModes(colorModes) {
  try {
    globalThis.localStorage?.setItem(
      AGENT_COLOR_STORAGE_KEY,
      JSON.stringify(normalizeStoredAgentColorModes(colorModes)),
    );
  } catch {
    // A vizuális beállítás tároló nélkül is azonnal működik.
  }
}

function normalizeStoredMapRenderOptions(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    prepareAllLayers: source.prepareAllLayers === true,
    renderFullMap: source.renderFullMap === true,
  };
}

function loadMapRenderOptions() {
  try {
    const serialized = globalThis.localStorage?.getItem(MAP_RENDER_OPTIONS_STORAGE_KEY);
    return normalizeStoredMapRenderOptions(serialized ? JSON.parse(serialized) : null);
  } catch {
    return normalizeStoredMapRenderOptions();
  }
}

function persistMapRenderOptions(options) {
  try {
    globalThis.localStorage?.setItem(
      MAP_RENDER_OPTIONS_STORAGE_KEY,
      JSON.stringify(normalizeStoredMapRenderOptions(options)),
    );
  } catch {
    // A megjelenítési mód tároló nélkül is azonnal működik.
  }
}

function loadTrafficHeatmapEnabled() {
  try {
    return globalThis.localStorage?.getItem(TRAFFIC_HEATMAP_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistTrafficHeatmapEnabled(enabled) {
  try {
    globalThis.localStorage?.setItem(TRAFFIC_HEATMAP_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // A hőtérkép tároló nélkül is azonnal működik.
  }
}

function createStateClientId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

const state = {
  network: null,
  localMap: null,
  configured: false,
  initializing: false,
  initializationTimer: null,
  initializationFailures: 0,
  running: false,
  polling: false,
  pollAgain: false,
  viewportInteracting: false,
  viewportUiDirty: false,
  skipNextIntervalSample: false,
  pollTimer: null,
  settingsTimer: null,
  pendingSettingsPayload: {},
  controlPending: false,
  pollFailures: 0,
  connectionNoticeShown: false,
  edgesBySegment: new Map(),
  poisById: new Map(),
  poiCategoryCounts: new Map(),
  activePoiCategories: new Set(),
  agentColorModes: loadAgentColorModes(),
  mapRenderOptions: loadMapRenderOptions(),
  trafficHeatmapEnabled: loadTrafficHeatmapEnabled(),
  segmentStatistics: new Map(),
  segmentStatisticsWindowSeconds: 60,
  segmentStatsTimer: null,
  segmentStatsPolling: false,
  staticPreparationStatus: { phase: "idle" },
  selectedFeature: null,
  selectedRoute: null,
  serverInstanceId: null,
  simulationEpoch: null,
  requestGeneration: 0,
  stateClientId: createStateClientId(),
  stateProtocolCache: createStateProtocolCache(),
  replayBuffer: createReplayBuffer(),
  replayMetadata: new Map(),
  replayMode: "live",
  replayCursorSequence: null,
  replayPlaying: false,
  replayTimer: null,
  replayPlaybackSnapshot: null,
  replayPlaybackMetadata: null,
  replayPlaybackDeadlineMs: null,
  replayTransition: null,
  latestLivePayload: null,
};

function syncAgentColorControls() {
  const carIndividual = state.agentColorModes.car === "individual";
  const pedestrianIndividual = state.agentColorModes.pedestrian === "individual";
  dom.carIndividualColors.checked = carIndividual;
  dom.pedestrianIndividualColors.checked = pedestrianIndividual;
  dom.legendCarMarker.classList.toggle("individual", carIndividual);
  dom.legendPedestrianMarker.classList.toggle("individual", pedestrianIndividual);
}

function setAgentColorMode(mode, individual) {
  state.agentColorModes = normalizeStoredAgentColorModes({
    ...state.agentColorModes,
    [mode]: individual ? "individual" : "uniform",
  });
  persistAgentColorModes(state.agentColorModes);
  syncAgentColorControls();
  state.localMap?.setAgentColorModes?.(state.agentColorModes);
}

function syncTrafficHeatmapControls() {
  dom.trafficHeatmap.checked = state.trafficHeatmapEnabled;
  dom.legendTrafficHeatmap.hidden = !state.trafficHeatmapEnabled;
}

function setTrafficHeatmapEnabled(enabled) {
  state.trafficHeatmapEnabled = Boolean(enabled);
  persistTrafficHeatmapEnabled(state.trafficHeatmapEnabled);
  syncTrafficHeatmapControls();
  state.localMap?.setTrafficHeatmapEnabled?.(state.trafficHeatmapEnabled);
  scheduleSegmentStatisticsPoll(0);
}

function syncMapRenderControls() {
  dom.prepareAllMapLayers.checked = state.mapRenderOptions.prepareAllLayers;
  dom.renderFullMap.checked = state.mapRenderOptions.renderFullMap;
}

function staticPreparationMessage(status) {
  const phase = status.phase;
  if (phase === "initializing") {
    return "A gyorsított térkép-előkészítő indítása…";
  }
  if (phase === "preparing") {
    const completed = Number(status.completed ?? status.completedLayers);
    const total = Number(status.total ?? status.totalLayers);
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
      return `Térképrétegek előkészítése: ${Math.max(0, Math.min(total, completed))}/${total}…`;
    }
    return "Térképrétegek előkészítése…";
  }
  if (phase === "ready") {
    if (state.mapRenderOptions.prepareAllLayers && state.mapRenderOptions.renderFullMap) {
      return "Minden részletességi szint és a teljes kerület előkészítve.";
    }
    if (state.mapRenderOptions.prepareAllLayers) {
      return "Minden részletességi szint előkészítve.";
    }
    if (state.mapRenderOptions.renderFullMap) {
      return "A teljes kerület előkészítve.";
    }
    return "Takarékos mód · csak a látható környezet készül el.";
  }
  if (phase === "limited") {
    return "A gyorsított mód részben készült el · a biztonságos memóriahatár aktív.";
  }
  if (phase === "fallback") {
    return "Az előkészítés nem sikerült; a takarékos mód maradt aktív.";
  }
  if (state.mapRenderOptions.prepareAllLayers || state.mapRenderOptions.renderFullMap) {
    return "A gyorsított előkészítés a térkép betöltésekor indul.";
  }
  return "Takarékos mód · csak a látható környezet készül el.";
}

function renderStaticPreparationStatus(status) {
  const busy = status.phase === "initializing" || status.phase === "preparing";
  setDomProperty(dom.mapRenderStatus, "textContent", staticPreparationMessage(status));
  dom.mapRenderStatus.setAttribute("aria-busy", String(busy));
  dom.mapRenderControls.setAttribute("aria-busy", String(busy));
}

function handleStaticPreparationChange(value) {
  const source = typeof value === "string" ? { phase: value } : value;
  const phase = ["idle", "initializing", "preparing", "ready", "limited", "fallback"]
    .includes(source?.phase)
    ? source.phase
    : "idle";
  state.staticPreparationStatus = { ...(source || {}), phase };
  if (state.viewportInteracting) {
    state.viewportUiDirty = true;
    return;
  }
  renderStaticPreparationStatus(state.staticPreparationStatus);
}

function setMapRenderOption(option, enabled) {
  if (option !== "prepareAllLayers" && option !== "renderFullMap") {
    return false;
  }
  const nextOptions = normalizeStoredMapRenderOptions({
    ...state.mapRenderOptions,
    [option]: Boolean(enabled),
  });
  const changed = (
    nextOptions.prepareAllLayers !== state.mapRenderOptions.prepareAllLayers
    || nextOptions.renderFullMap !== state.mapRenderOptions.renderFullMap
  );
  if (!changed) {
    return false;
  }
  state.mapRenderOptions = nextOptions;
  persistMapRenderOptions(nextOptions);
  syncMapRenderControls();
  handleStaticPreparationChange({
    phase: nextOptions.prepareAllLayers || nextOptions.renderFullMap
      ? "initializing"
      : "idle",
  });
  state.localMap?.setStaticRenderOptions?.({ ...nextOptions });
  return changed;
}

function nextPollDelay(elapsedMs = 0) {
  return pollDelayAfterElapsed({
    running: state.running,
    failures: state.pollFailures,
    elapsedMs,
    agentCount: state.latestLivePayload?.agents?.length ?? 0,
  });
}

function scheduleSimulationPoll(delay = nextPollDelay()) {
  if (state.pollTimer !== null) {
    window.clearTimeout(state.pollTimer);
  }
  if (document.hidden) {
    state.pollTimer = null;
    return;
  }
  state.pollTimer = window.setTimeout(() => {
    state.pollTimer = null;
    pollSimulation();
  }, delay);
}

function scheduleImmediateSimulationPoll() {
  if (!state.configured || document.hidden) {
    return;
  }
  state.skipNextIntervalSample = true;
  if (state.polling || state.controlPending) {
    state.pollAgain = true;
    return;
  }
  scheduleSimulationPoll(0);
}

function handleViewportInteractionChange(interacting) {
  const nextValue = Boolean(interacting);
  if (state.viewportInteracting === nextValue) {
    return;
  }
  state.viewportInteracting = nextValue;
  if (!nextValue) {
    flushDeferredViewportUi();
  }
}

async function apiRequest(
  path,
  { method = "GET", body, cache = "no-store", timeoutMs = 15000 } = {},
) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `A Python szerver ${response.status} hibát adott.`);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("A Python szerver nem válaszolt időben.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function decodeSegmentStatistics(payload) {
  const statistics = new Map();
  for (const [segmentId, values] of Object.entries(payload?.segments || {})) {
    if (!Array.isArray(values) || values.length < 6) {
      continue;
    }
    const [passedCars, currentCars, averageSpeedKph, speedRatio, loadPercent, vehicleSeconds] = values;
    statistics.set(String(segmentId), {
      passedCars: Math.max(0, Number(passedCars) || 0),
      currentCars: Math.max(0, Number(currentCars) || 0),
      averageSpeedKph: Math.max(0, Number(averageSpeedKph) || 0),
      speedRatio: Math.max(0, Number(speedRatio) || 0),
      loadPercent: Math.max(0, Math.min(100, Number(loadPercent) || 0)),
      vehicleSeconds: Math.max(0, Number(vehicleSeconds) || 0),
      hasRecentTraffic: Number(vehicleSeconds) > 0 || Number(currentCars) > 0,
    });
  }
  return statistics;
}

function selectedSegmentId() {
  return state.selectedFeature?.type === "segment"
    ? String(state.selectedFeature.segment.id)
    : null;
}

function segmentStatisticsPath() {
  const segmentId = selectedSegmentId();
  if (state.trafficHeatmapEnabled) {
    return segmentId
      ? `/api/simulation/segments?includeSegmentId=${encodeURIComponent(segmentId)}`
      : "/api/simulation/segments";
  }
  return segmentId
    ? `/api/simulation/segments?segmentId=${encodeURIComponent(segmentId)}`
    : null;
}

function scheduleSegmentStatisticsPoll(delay = 0) {
  if (state.segmentStatsTimer !== null) {
    window.clearTimeout(state.segmentStatsTimer);
    state.segmentStatsTimer = null;
  }
  if (!state.configured || document.hidden || !segmentStatisticsPath()) {
    return;
  }
  state.segmentStatsTimer = window.setTimeout(() => {
    state.segmentStatsTimer = null;
    pollSegmentStatistics();
  }, Math.max(0, delay));
}

async function pollSegmentStatistics() {
  const path = segmentStatisticsPath();
  if (!state.configured || document.hidden || !path || state.segmentStatsPolling) {
    return;
  }
  state.segmentStatsPolling = true;
  try {
    const payload = await apiRequest(path, { timeoutMs: 10000 });
    state.segmentStatisticsWindowSeconds = Number(payload.windowSeconds) || 60;
    state.segmentStatistics = decodeSegmentStatistics(payload);
    state.localMap?.setSegmentStatistics?.(state.segmentStatistics);
    if (state.selectedFeature?.type === "segment") {
      inspectSegment(state.selectedFeature.segment);
    }
  } catch (error) {
    console.warn("Az útszakasz-statisztika átmenetileg nem frissült.", error);
  } finally {
    state.segmentStatsPolling = false;
    scheduleSegmentStatisticsPoll(state.running ? 1000 : 1800);
  }
}

function formatDecimal(value) {
  return Number(value || 0).toLocaleString("hu-HU", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function formatInteger(value) {
  return Number(value || 0).toLocaleString("hu-HU");
}

function formatClock(totalSeconds) {
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function stopReplayPlayback({ preserveSnapshot = false } = {}) {
  state.replayPlaying = false;
  if (state.replayTimer !== null) {
    window.clearTimeout(state.replayTimer);
    state.replayTimer = null;
  }
  if (state.replayTransition) {
    state.localMap?.freezeAgentTransition?.();
  }
  if (!preserveSnapshot) {
    state.replayPlaybackSnapshot = null;
    state.replayPlaybackMetadata = null;
  }
  state.replayPlaybackDeadlineMs = null;
  state.replayTransition = null;
}

function pauseReplayPlayback() {
  if (!state.replayPlaying) {
    return;
  }
  const now = performance.now();
  state.replayPlaying = false;
  if (state.replayTimer !== null) {
    window.clearTimeout(state.replayTimer);
    state.replayTimer = null;
  }
  if (state.replayTransition) {
    state.replayTransition.remainingDurationMs = Math.max(
      0,
      state.replayTransition.deadlineMs - now,
    );
    state.localMap?.freezeAgentTransition?.(now);
  }
  state.replayPlaybackDeadlineMs = null;
}

function activeReplayTimeline() {
  return state.replayPlaybackSnapshot
    ? state.replayPlaybackSnapshot
    : state.replayBuffer;
}

function replaySummary(timeline, sequence) {
  if (!timeline || sequence === null || sequence === undefined) {
    return null;
  }
  return timeline.summaries().find((summary) => summary.sequence === sequence) || null;
}

function replayElapsedSeconds(timeline, sequence, metadata) {
  const metadataTime = metadata?.get(sequence)?.stats?.elapsedSeconds;
  if (Number.isFinite(Number(metadataTime))) {
    return Number(metadataTime);
  }
  const summary = replaySummary(timeline, sequence);
  return summary?.endSimulationTimeSeconds ?? summary?.simulationTimeSeconds ?? null;
}

function setDomProperty(element, property, value) {
  if (element[property] !== value) {
    element[property] = value;
  }
}

function updateReplayUi() {
  const timeline = activeReplayTimeline();
  const metadata = state.replayPlaybackMetadata
    ? state.replayPlaybackMetadata
    : state.replayMetadata;
  const oldest = timeline.oldestSequence;
  const newest = timeline.newestSequence;
  const hasFrames = oldest !== null && newest !== null;
  const hasHistory = timeline.length > 1;
  const cursor = state.replayMode === "live"
    ? newest
    : Math.min(newest ?? 0, Math.max(oldest ?? 0, state.replayCursorSequence ?? 0));

  setDomProperty(dom.replayRange, "min", String(oldest ?? 0));
  setDomProperty(dom.replayRange, "max", String(newest ?? 0));
  setDomProperty(dom.replayRange, "value", String(cursor ?? 0));
  setDomProperty(dom.replayRange, "disabled", !state.configured || !hasHistory);
  setDomProperty(
    dom.replayLive,
    "disabled",
    !state.configured || state.replayMode === "live" || !hasFrames,
  );
  setDomProperty(
    dom.replayPlay,
    "disabled",
    !state.configured || state.replayMode === "live" || !hasHistory,
  );
  setDomProperty(dom.replayPlayIcon, "textContent", state.replayPlaying ? "Ⅱ" : "▶");
  setDomProperty(
    dom.replayPlayLabel,
    "textContent",
    state.replayPlaying ? "Megállítás" : "Lejátszás",
  );

  if (!hasFrames) {
    setDomProperty(
      dom.replayPosition,
      "textContent",
      "Az előzmény gyűjtése induláskor kezdődik.",
    );
    return;
  }
  if (state.replayMode === "live") {
    const elapsed = state.latestLivePayload?.stats?.elapsedSeconds
      ?? state.replayMetadata.get(newest)?.stats?.elapsedSeconds;
    setDomProperty(
      dom.replayPosition,
      "textContent",
      elapsed === null || elapsed === undefined
        ? "Élő állapot"
        : `Élő · ${formatClock(elapsed)}`,
    );
    return;
  }
  const selectedTime = replayElapsedSeconds(timeline, cursor, metadata);
  const newestTime = state.replayPlaybackSnapshot
    ? replayElapsedSeconds(timeline, newest, metadata)
    : state.latestLivePayload?.stats?.elapsedSeconds
      ?? replayElapsedSeconds(timeline, newest, metadata);
  const age = Number(newestTime) - Number(selectedTime);
  const ageLabel = Number.isFinite(age) && age > 0
    ? ` · ${formatDecimal(age)} szimulált mp-cel korábban`
    : "";
  setDomProperty(
    dom.replayPosition,
    "textContent",
    selectedTime === null || selectedTime === undefined
      ? `Korábbi állapot${ageLabel}`
      : `${formatClock(selectedTime)}${ageLabel}`,
  );
}

function resetReplayHistory() {
  stopReplayPlayback();
  state.replayBuffer.reset();
  state.replayMetadata.clear();
  state.replayMode = "live";
  state.replayCursorSequence = null;
  state.latestLivePayload = null;
  updateReplayUi();
}

function pruneReplayMetadata() {
  const oldest = state.replayBuffer.oldestSequence;
  if (oldest === null) {
    state.replayMetadata.clear();
    return;
  }
  for (const sequence of state.replayMetadata.keys()) {
    if (sequence < oldest) {
      state.replayMetadata.delete(sequence);
    }
  }
}

function recordReplayPayload(payload, { force = false, refreshUi = true } = {}) {
  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  const result = state.replayBuffer.append(agents, {
    timestampMs: performance.now(),
    simulationTimeSeconds: Number.isFinite(Number(payload.stats?.elapsedSeconds))
      ? Number(payload.stats.elapsedSeconds)
      : null,
    force,
  });
  if (result.sequence !== null) {
    state.replayMetadata.set(result.sequence, {
      running: Boolean(payload.running),
      speedMultiplier: payload.speedMultiplier,
      stats: payload.stats ? { ...payload.stats } : null,
    });
  }
  pruneReplayMetadata();
  if (
    state.replayMode !== "live"
    && !state.replayPlaybackSnapshot
    && state.replayCursorSequence < state.replayBuffer.oldestSequence
  ) {
    state.replayCursorSequence = state.replayBuffer.oldestSequence;
    presentReplaySequence(state.replayCursorSequence);
  }
  if (refreshUi) {
    updateReplayUi();
  }
}

function showNotice(message, type = "error") {
  dom.notice.textContent = message;
  dom.notice.classList.toggle("info", type === "info");
  dom.notice.hidden = false;
}

function hideNotice() {
  dom.notice.hidden = true;
}

function setControlsEnabled(enabled, { refreshReplayUi = true } = {}) {
  const liveEnabled = enabled && state.replayMode === "live";
  [dom.carCount, dom.pedestrianCount, dom.simulationSpeed].forEach((control) => {
    setDomProperty(control, "disabled", !liveEnabled);
  });
  setDomProperty(dom.startPause, "disabled", !liveEnabled || state.controlPending);
  setDomProperty(dom.reset, "disabled", !liveEnabled || state.controlPending);
  if (refreshReplayUi) {
    updateReplayUi();
  }
}

function setControlPending(pending) {
  state.controlPending = pending;
  const liveEnabled = state.configured && state.replayMode === "live";
  [dom.carCount, dom.pedestrianCount, dom.simulationSpeed].forEach((control) => {
    control.disabled = pending || !liveEnabled;
  });
  dom.startPause.disabled = pending || !liveEnabled;
  dom.reset.disabled = pending || !liveEnabled;
  updateReplayUi();
}

function renderStats(stats) {
  if (!stats) {
    return;
  }
  setDomProperty(dom.carSpeed, "textContent", formatDecimal(stats.averageCarSpeedKph));
  setDomProperty(
    dom.pedestrianSpeed,
    "textContent",
    formatDecimal(stats.averagePedestrianSpeedKph),
  );
  setDomProperty(
    dom.congestion,
    "textContent",
    Math.round(stats.congestionPercent || 0).toLocaleString("hu-HU"),
  );
  setDomProperty(dom.completedTrips, "textContent", formatInteger(stats.completedTrips));
  setDomProperty(dom.clock, "textContent", formatClock(stats.elapsedSeconds || 0));
}

function flushDeferredViewportUi() {
  if (!state.viewportUiDirty) {
    return;
  }
  state.viewportUiDirty = false;
  if (state.replayMode === "live" && state.latestLivePayload) {
    syncSettingsControls(state.latestLivePayload);
    renderStats(state.latestLivePayload.stats);
  }
  if (state.selectedFeature?.type === "agent") {
    inspectAgent(state.selectedFeature.agent);
  } else if (!state.selectedFeature) {
    dom.inspector.hidden = true;
  }
  renderStaticPreparationStatus(state.staticPreparationStatus);
  updateRunningUi({ refreshReplayUi: false });
  setControlsEnabled(state.configured, { refreshReplayUi: false });
  updateReplayUi();
}

function syncSettingsControls(payload) {
  const stats = payload.stats || {};
  if (
    document.activeElement !== dom.carCount
    && Number.isFinite(Number(stats.cars))
  ) {
    const value = String(stats.cars);
    setDomProperty(dom.carCount, "value", value);
    setDomProperty(dom.carCountValue, "textContent", value);
  }
  if (
    document.activeElement !== dom.pedestrianCount
    && Number.isFinite(Number(stats.pedestrians))
  ) {
    const value = String(stats.pedestrians);
    setDomProperty(dom.pedestrianCount, "value", value);
    setDomProperty(dom.pedestrianCountValue, "textContent", value);
  }
  if (
    document.activeElement !== dom.simulationSpeed
    && payload.speedMultiplier !== undefined
  ) {
    setDomProperty(dom.simulationSpeed, "value", String(payload.speedMultiplier));
  }
}

function updateRunningUi({ refreshReplayUi = true } = {}) {
  setDomProperty(dom.startPauseIcon, "textContent", state.running ? "Ⅱ" : "▶");
  setDomProperty(dom.startPauseLabel, "textContent", state.running ? "Szünet" : "Indítás");
  if (state.configured) {
    if (state.replayMode !== "live") {
      setDomProperty(
        dom.routeStatus,
        "textContent",
        state.replayPlaying
          ? "Korábbi állapotok visszajátszása · a Python motor a háttérben fut"
          : "Korábbi állapot megtekintése · a Python motor a háttérben fut",
      );
      if (refreshReplayUi) {
        updateReplayUi();
      }
      return;
    }
    setDomProperty(
      dom.routeStatus,
      "textContent",
      state.running
        ? "Helyi úthálózat · Python motor fut"
        : "Helyi úthálózat · szünetel",
    );
  }
  if (refreshReplayUi) {
    updateReplayUi();
  }
}

function selectedSimulationStatePath() {
  const query = new URLSearchParams({
    protocol: String(STATE_PROTOCOL_VERSION),
    clientId: state.stateClientId,
  });
  if (state.stateProtocolCache.revision !== null) {
    query.set("baseRevision", String(state.stateProtocolCache.revision));
  }
  const selectedAgent = state.replayMode === "live" && state.selectedFeature?.type === "agent"
    ? state.selectedFeature.agent
    : null;
  if (!selectedAgent) {
    return `/api/simulation/state?${query}`;
  }
  query.set("selectedAgentId", String(selectedAgent.id));
  if (
    state.selectedRoute?.token
    && state.selectedRoute.nodeIds?.length >= 2
    && String(state.selectedRoute.agentId) === String(selectedAgent.id)
  ) {
    query.set("knownRouteToken", state.selectedRoute.token);
  }
  return `/api/simulation/state?${query}`;
}

function decodeSimulationState(wirePayload) {
  try {
    const decoded = reduceSimulationState(wirePayload, state.stateProtocolCache);
    state.stateProtocolCache = decoded.cache;
    return decoded.payload;
  } catch (error) {
    state.stateProtocolCache = createStateProtocolCache();
    throw error;
  }
}

function mergeSelectedRoute(route) {
  if (!route) {
    return null;
  }
  const current = state.selectedRoute;
  if (
    !Object.hasOwn(route, "nodeIds")
    && current
    && String(current.agentId) === String(route.agentId)
    && current.token === route.token
  ) {
    return { ...current, ...route };
  }
  return {
    ...route,
    nodeIds: Array.isArray(route.nodeIds) ? route.nodeIds : [],
  };
}

function presentSimulationPayload(
  payload,
  {
    animate = state.running,
    observeInterval = false,
    resetTiming = false,
    snapAll = false,
    historical = false,
    transitionDurationMs = null,
    renderStatistics = true,
    renderDetails = true,
  } = {},
) {
  const agents = Array.isArray(payload.agents) ? payload.agents : [];
  const snapAgentIds = snapAll
    ? new Set(agents.map((agent) => String(agent.id)))
    : null;
  state.localMap?.setAgents(agents, {
    animate,
    observeInterval,
    resetTiming,
    snapAgentIds,
    transitionDurationMs,
  });
  if (state.selectedFeature?.type === "agent") {
    const selectedId = String(state.selectedFeature.agent.id);
    const currentAgent = agents.find((agent) => String(agent.id) === selectedId);
    if (currentAgent) {
      state.selectedFeature = { type: "agent", agent: currentAgent };
      if (!historical && Object.hasOwn(payload, "selectedRoute")) {
        if (
          payload.selectedRoute
          && String(payload.selectedRoute.agentId) === selectedId
        ) {
          state.selectedRoute = mergeSelectedRoute(payload.selectedRoute);
          const routeAccepted = state.localMap?.setSelectedAgentRoute(
            selectedId,
            state.selectedRoute,
          );
          if (routeAccepted === false) {
            state.selectedRoute = { ...state.selectedRoute, nodeIds: [] };
          }
        } else {
          state.selectedRoute = null;
          state.localMap?.setSelectedAgentRoute(selectedId, {
            agentId: selectedId,
            mode: currentAgent.mode,
            token: null,
            routeIndex: 0,
          });
        }
      }
      if (renderDetails) {
        inspectAgent(currentAgent);
      }
    } else {
      state.selectedFeature = null;
      state.selectedRoute = null;
      state.localMap?.setSelectedAgentRoute(null);
      if (renderDetails) {
        dom.inspector.hidden = true;
      }
    }
  }
  if (renderStatistics) {
    renderStats(payload.stats);
  }
}

function invalidateSimulationSession(message) {
  state.requestGeneration += 1;
  state.stateProtocolCache = createStateProtocolCache();
  state.configured = false;
  state.running = false;
  state.simulationEpoch = null;
  state.viewportUiDirty = false;
  state.segmentStatistics.clear();
  state.localMap?.setSegmentStatistics?.(state.segmentStatistics);
  if (state.segmentStatsTimer !== null) {
    window.clearTimeout(state.segmentStatsTimer);
    state.segmentStatsTimer = null;
  }
  resetReplayHistory();
  state.localMap?.setAgents([], { animate: false, resetTiming: true });
  inspectFeature(null);
  setControlsEnabled(false);
  dom.routeStatus.textContent = message;
  updateRunningUi();
  scheduleInitializationRetry(0);
  return false;
}

function consumeSimulationState(payload, { observeInterval = false } = {}) {
  const previousRunning = state.running;
  const deferViewportUi = state.viewportInteracting;
  let epochChanged = false;
  if (
    payload.serverInstanceId
    && state.serverInstanceId
    && payload.serverInstanceId !== state.serverInstanceId
  ) {
    state.serverInstanceId = payload.serverInstanceId;
    return invalidateSimulationSession(
      "Új szerverpéldány indult, a szimuláció újraszinkronizálása…",
    );
  }
  if (payload.serverInstanceId) {
    state.serverInstanceId = payload.serverInstanceId;
  }
  if (payload.configured === false) {
    return invalidateSimulationSession(
      "A szerver újraindult, a szimuláció visszaállítása…",
    );
  }
  if (payload.configured === true) {
    state.configured = true;
  }
  if (payload.simulationEpoch !== undefined) {
    epochChanged = Boolean(
      state.simulationEpoch !== null
      && payload.simulationEpoch !== state.simulationEpoch
    );
    if (epochChanged) {
      inspectFeature(null);
      resetReplayHistory();
      state.segmentStatistics.clear();
      state.localMap?.setSegmentStatistics?.(state.segmentStatistics);
    }
    state.simulationEpoch = payload.simulationEpoch;
  }
  state.running = Boolean(payload.running);
  if (deferViewportUi) {
    state.viewportUiDirty = true;
  } else {
    syncSettingsControls(payload);
  }
  state.latestLivePayload = payload;
  recordReplayPayload(payload, {
    force: epochChanged || state.replayBuffer.length === 0 || state.running !== previousRunning,
    refreshUi: false,
  });
  if (state.replayMode === "live") {
    presentSimulationPayload(payload, {
      animate: state.running,
      observeInterval: Boolean(
        observeInterval && state.running && previousRunning && !epochChanged
      ),
      resetTiming: epochChanged || state.running !== previousRunning,
      renderStatistics: !deferViewportUi,
      renderDetails: !deferViewportUi,
    });
  }
  if (!deferViewportUi) {
    updateRunningUi({ refreshReplayUi: false });
    setControlsEnabled(state.configured, { refreshReplayUi: false });
    updateReplayUi();
  }
  return true;
}

function replayPayload(frame, metadataSource = state.replayMetadata) {
  const metadata = metadataSource?.get(frame.sequence) || {};
  const elapsedSeconds = frame.endSimulationTimeSeconds
    ?? frame.simulationTimeSeconds;
  const stats = metadata.stats ? { ...metadata.stats } : {};
  if (elapsedSeconds !== null && elapsedSeconds !== undefined) {
    stats.elapsedSeconds = elapsedSeconds;
  }
  return {
    agents: frame.agents,
    running: Boolean(metadata.running),
    speedMultiplier: metadata.speedMultiplier,
    stats,
  };
}

function presentReplaySequence(sequence, {
  animate = false,
  timeline = state.replayBuffer,
  metadata = state.replayMetadata,
  transitionDurationMs = null,
  commitCursor = true,
  renderStatistics = true,
} = {}) {
  const frame = timeline.decode(sequence);
  if (!frame) {
    return false;
  }
  const enteringReplay = state.replayMode === "live";
  state.replayMode = "history";
  if (commitCursor) {
    state.replayCursorSequence = frame.sequence;
  }
  if (enteringReplay || !animate) {
    inspectFeature(null);
  }
  presentSimulationPayload(replayPayload(frame, metadata), {
    animate,
    observeInterval: animate,
    resetTiming: !animate,
    snapAll: !animate,
    historical: true,
    transitionDurationMs,
    renderStatistics,
  });
  setControlsEnabled(state.configured);
  updateRunningUi();
  return true;
}

function returnToLive() {
  stopReplayPlayback();
  state.replayMode = "live";
  state.replayCursorSequence = state.replayBuffer.newestSequence;
  inspectFeature(null);
  if (state.latestLivePayload) {
    presentSimulationPayload(state.latestLivePayload, {
      animate: false,
      resetTiming: true,
      snapAll: true,
    });
  }
  setControlsEnabled(state.configured);
  updateRunningUi();
}

function startReplayTransition(transition) {
  if (!state.replayPlaying || state.replayTransition !== transition) {
    return;
  }
  const timeline = state.replayPlaybackSnapshot;
  if (!timeline) {
    stopReplayPlayback();
    updateRunningUi();
    return;
  }
  const now = performance.now();
  const nominalDurationMs = Math.max(0, transition.remainingDurationMs);
  const deadlineMs = state.replayPlaybackDeadlineMs === null
    ? now + nominalDurationMs
    : state.replayPlaybackDeadlineMs + nominalDurationMs;
  const durationMs = Math.max(0, deadlineMs - now);
  state.replayPlaybackDeadlineMs = deadlineMs;
  transition.deadlineMs = deadlineMs;
  transition.remainingDurationMs = durationMs;
  presentReplaySequence(transition.toSequence, {
    animate: true,
    timeline,
    metadata: state.replayPlaybackMetadata,
    transitionDurationMs: durationMs,
    commitCursor: false,
    renderStatistics: false,
  });
  state.replayTimer = window.setTimeout(() => {
    state.replayTimer = null;
    if (
      !state.replayPlaying
      || state.replayPlaybackSnapshot !== timeline
      || state.replayTransition !== transition
    ) {
      return;
    }
    state.replayCursorSequence = transition.toSequence;
    const completedFrame = timeline.decode(transition.toSequence);
    if (completedFrame) {
      renderStats(replayPayload(completedFrame, state.replayPlaybackMetadata).stats);
    }
    state.replayTransition = null;
    if (transition.toSequence >= timeline.newestSequence) {
      returnToLive();
      return;
    }
    scheduleReplayStep();
  }, durationMs);
}

function scheduleReplayStep() {
  if (!state.replayPlaying || state.replayMode === "live") {
    return;
  }
  const timeline = state.replayPlaybackSnapshot;
  if (!timeline) {
    stopReplayPlayback();
    updateRunningUi();
    return;
  }
  const currentFrame = timeline.decode(state.replayCursorSequence);
  const nextSummary = timeline.summaries().find(
    (summary) => summary.sequence > state.replayCursorSequence,
  );
  if (!currentFrame || !nextSummary) {
    returnToLive();
    return;
  }
  state.replayTransition = {
    fromSequence: state.replayCursorSequence,
    toSequence: nextSummary.sequence,
    remainingDurationMs: replayFrameDelayMs(
      currentFrame,
      nextSummary,
      REPLAY_SAMPLE_INTERVAL_MS,
    ),
    deadlineMs: null,
  };
  startReplayTransition(state.replayTransition);
}

function toggleReplayPlayback() {
  if (state.replayMode === "live") {
    return;
  }
  if (state.replayPlaying) {
    pauseReplayPlayback();
    updateRunningUi();
    return;
  }
  if (state.replayTransition && state.replayPlaybackSnapshot) {
    state.replayPlaying = true;
    updateRunningUi();
    startReplayTransition(state.replayTransition);
    return;
  }
  const playbackSnapshot = state.replayPlaybackSnapshot
    ?? state.replayBuffer.snapshot();
  if (
    playbackSnapshot.length < 2
    || state.replayCursorSequence >= playbackSnapshot.newestSequence
  ) {
    returnToLive();
    return;
  }
  state.replayPlaybackSnapshot = playbackSnapshot;
  if (!state.replayPlaybackMetadata) {
    state.replayPlaybackMetadata = new Map(
      playbackSnapshot.summaries().map((summary) => [
        summary.sequence,
        state.replayMetadata.get(summary.sequence),
      ]),
    );
  }
  state.replayPlaybackDeadlineMs = null;
  state.replayPlaying = true;
  updateRunningUi();
  scheduleReplayStep();
}

function buildSegmentEdgeIndex(network) {
  const index = new Map();
  for (const edge of network.edges || []) {
    const segmentId = String(edge.segmentId || "");
    if (!index.has(segmentId)) {
      index.set(segmentId, []);
    }
    index.get(segmentId).push(edge);
  }
  return index;
}

function turnLaneSummary(edges) {
  const values = [];
  for (const edge of edges) {
    if (!edge.turnLanes?.length) {
      continue;
    }
    const lanes = edge.turnLanes.map((lane) => lane.join("+") || "nincs jelölés").join(" | ");
    values.push(`${edge.direction === "backward" ? "vissza" : "előre"}: ${lanes}`);
  }
  return values.join("; ");
}

function showInspector(name, parts) {
  dom.inspectorName.textContent = name;
  dom.inspectorDetails.textContent = parts.filter(Boolean).join(" · ");
  dom.inspector.hidden = false;
}

function inspectSegment(segment) {
  const edges = state.edgesBySegment.get(String(segment.id)) || [];
  const name = segment.name || segment.highway || "Névtelen útszakasz";
  const laneCount = Number(segment.totalLanes || 1);
  const directionSplit = segment.forwardLanes || segment.backwardLanes
    ? ` (${segment.forwardLanes || 0} előre / ${segment.backwardLanes || 0} vissza)`
    : "";
  const speed = segment.maxSpeedKph || edges.find((edge) => edge.maxSpeedKph)?.maxSpeedKph;
  const turns = turnLaneSummary(edges);
  const statistics = state.segmentStatistics.get(String(segment.id));
  const windowSeconds = Math.round(state.segmentStatisticsWindowSeconds || 60);
  const modeLabels = {
    car: "csak gépjárműforgalom",
    pedestrian: "csak gyalogosforgalom",
    mixed: "autós és gyalogos forgalom",
    unknown: "nem besorolt hozzáférés",
  };
  const parts = [
    modeLabels[roadModeForSegment(segment)],
    `${laneCount} sáv${directionSplit}`,
    segment.highway ? `OSM: ${segment.highway}` : null,
    speed ? `${speed} km/h` : null,
    turns ? `Kanyarodási sávok: ${turns}` : "Nincs rögzített turn:lanes adat",
    statistics
      ? `Áthaladt autók: ${formatInteger(statistics.passedCars)}`
      : "Forgalmi statisztika betöltése…",
    statistics?.hasRecentTraffic
      ? `Utolsó ${windowSeconds} mp: ${formatDecimal(statistics.averageSpeedKph)} km/h (${Math.round(statistics.speedRatio * 100)}% a korláthoz képest)`
      : statistics ? `Az utolsó ${windowSeconds} mp-ben nem volt mért autóforgalom` : null,
    statistics?.hasRecentTraffic
      ? `Terheltség: ${Math.round(statistics.loadPercent)}% · most ${formatInteger(statistics.currentCars)} autó`
      : null,
  ];
  showInspector(name, parts);
}

function inspectPoi(poi) {
  const category = poi.category || "other";
  const categoryLabel = POI_CATEGORY_STYLE[category]?.label || POI_CATEGORY_STYLE.other.label;
  const tags = poi.tags && typeof poi.tags === "object" ? poi.tags : {};
  const tagOrder = [
    "amenity",
    "shop",
    "public_transport",
    "highway",
    "railway",
    "opening_hours",
    "operator",
    "brand",
    "cuisine",
    "capacity",
    "wheelchair",
  ];
  const tagSummary = tagOrder
    .filter((key) => tags[key] !== undefined && tags[key] !== "")
    .slice(0, 7)
    .map((key) => `${key}=${tags[key]}`)
    .join(", ");
  const tripModes = (poi.tripModes || poi.modes || []).map((mode) => (
    mode === "car" ? "autó" : mode === "pedestrian" ? "gyalog" : mode
  ));
  const osmReference = poi.osmType && poi.osmId
    ? `${poi.osmType}/${poi.osmId}`
    : String(poi.id || "").includes("/") ? poi.id : null;
  showInspector(poi.name || poi.subtype || "Névtelen helyszín", [
    categoryLabel,
    poi.subtype ? `Típus: ${poi.subtype}` : null,
    tripModes.length ? `Úticél: ${tripModes.join(" + ")}` : null,
    "Az útvonal a legközelebbi megfelelő úthoz illeszkedik",
    osmReference ? `OSM: ${osmReference}` : null,
    tagSummary ? `Tagek: ${tagSummary}` : null,
  ]);
}

function agentPoiName(agent, endpoint) {
  const title = endpoint === "origin" ? "Kiindulás" : "Cél";
  const direct = agent[`${endpoint}Poi`] ?? agent[endpoint] ?? agent.trip?.[endpoint];
  const explicitName = agent[`${endpoint}PoiName`] ?? agent.trip?.[`${endpoint}Name`];
  const id = agent[`${endpoint}PoiId`]
    ?? (direct && typeof direct === "object" ? direct.id : direct);
  const poi = id !== undefined ? state.poisById.get(String(id)) : null;
  const name = explicitName
    || (direct && typeof direct === "object" ? direct.name : null)
    || poi?.name;
  if (!name) {
    return null;
  }
  const kind = direct && typeof direct === "object" ? direct.kind : null;
  const snapDistance = Number(
    direct && typeof direct === "object" ? direct.snapDistanceMeters : 0,
  );
  const qualifier = kind === "gateway"
    ? "hálózati perem"
    : Number.isFinite(snapDistance) && snapDistance >= 1
      ? `útra illesztve: ${Math.round(snapDistance)} m`
      : null;
  return `${title}: ${name}${qualifier ? ` (${qualifier})` : ""}`;
}

function inspectAgent(agent) {
  const mode = agent.mode === "car" ? "Autó" : "Gyalogos";
  const speed = Number(agent.speedKph ?? agent.speed ?? 0);
  showInspector(`${mode} · ${agent.id}`, [
    agentPoiName(agent, "origin"),
    agentPoiName(agent, "destination"),
    Number.isFinite(speed) && speed > 0 ? `${formatDecimal(speed)} km/h` : null,
    agent.waiting ? "Várakozik" : "Mozgásban",
  ]);
}

function inspectFeature(feature) {
  state.selectedFeature = feature;
  if (feature?.type === "agent") {
    const agentId = String(feature.agent.id);
    if (
      state.replayMode !== "live"
      || String(state.selectedRoute?.agentId) !== agentId
    ) {
      state.selectedRoute = null;
    }
    state.localMap?.setSelectedAgentRoute(agentId, state.selectedRoute || {
      agentId,
      mode: feature.agent.mode,
      token: null,
      routeIndex: 0,
    });
    if (state.replayMode === "live") {
      scheduleImmediateSimulationPoll();
    }
  } else {
    state.selectedRoute = null;
    state.localMap?.setSelectedAgentRoute(null);
  }
  if (!feature) {
    dom.inspector.hidden = true;
    scheduleSegmentStatisticsPoll(0);
    return;
  }
  if (feature.type === "poi") {
    inspectPoi(feature.poi);
  } else if (feature.type === "agent") {
    inspectAgent(feature.agent);
  } else if (feature.type === "segment") {
    inspectSegment(feature.segment);
  }
  scheduleSegmentStatisticsPoll(0);
}

function categoryDescriptor(category) {
  const known = POI_CATEGORY_STYLE[category];
  return known || {
    label: category.replaceAll("_", " "),
    color: POI_CATEGORY_STYLE.other.color,
    priority: 0,
  };
}

function updatePoiFilterUi() {
  for (const button of dom.poiFilters.querySelectorAll("button[data-category]")) {
    const active = state.activePoiCategories.has(button.dataset.category);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  const visibleCount = [...state.activePoiCategories]
    .reduce((total, category) => total + (state.poiCategoryCounts.get(category) || 0), 0);
  const totalCount = [...state.poiCategoryCounts.values()]
    .reduce((total, count) => total + count, 0);
  dom.poiFilterSummary.textContent = totalCount
    ? `${formatInteger(visibleCount)} / ${formatInteger(totalCount)} helyszín látható`
    : "Nincs helyszínadat ebben a térképfájlban.";
  state.localMap?.setPoiCategories(state.activePoiCategories);
}

function renderPoiFilters(network) {
  state.poiCategoryCounts = new Map();
  state.poisById = new Map();
  for (const poi of network.pois || []) {
    const category = poi.category || "other";
    state.poiCategoryCounts.set(category, (state.poiCategoryCounts.get(category) || 0) + 1);
    if (poi.id !== undefined) {
      state.poisById.set(String(poi.id), poi);
    }
  }
  state.activePoiCategories = new Set(state.poiCategoryCounts.keys());
  const categories = [...state.poiCategoryCounts.keys()].sort((left, right) => {
    const priorityDifference = categoryDescriptor(right).priority - categoryDescriptor(left).priority;
    return priorityDifference || left.localeCompare(right, "hu");
  });
  const fragment = document.createDocumentFragment();
  for (const category of categories) {
    const descriptor = categoryDescriptor(category);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "poi-filter active";
    button.dataset.category = category;
    button.setAttribute("aria-pressed", "true");
    button.style.setProperty("--poi-color", descriptor.color);

    const dot = document.createElement("i");
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = descriptor.label;
    const count = document.createElement("small");
    count.textContent = formatInteger(state.poiCategoryCounts.get(category));
    button.append(dot, label, count);
    button.addEventListener("click", () => {
      if (state.activePoiCategories.has(category)) {
        state.activePoiCategories.delete(category);
      } else {
        state.activePoiCategories.add(category);
      }
      updatePoiFilterUi();
    });
    fragment.append(button);
  }
  dom.poiFilters.replaceChildren(fragment);
  dom.poiFilterAll.disabled = categories.length === 0;
  dom.poiFilterNone.disabled = categories.length === 0;
  updatePoiFilterUi();
}

function scheduleInitializationRetry(delay = null) {
  if (state.initializationTimer !== null) {
    window.clearTimeout(state.initializationTimer);
  }
  if (document.hidden) {
    state.initializationTimer = null;
    return;
  }
  const retryDelay = delay ?? Math.min(
    10000,
    1000 * (2 ** Math.min(Math.max(0, state.initializationFailures - 1), 3)),
  );
  state.initializationTimer = window.setTimeout(() => {
    state.initializationTimer = null;
    initializeApplication();
  }, retryDelay);
}

async function pollSimulation() {
  if (state.polling || state.controlPending || !state.configured || document.hidden) {
    return;
  }
  state.polling = true;
  state.pollAgain = false;
  const observeInterval = !state.skipNextIntervalSample;
  state.skipNextIntervalSample = false;
  const pollStartedAt = performance.now();
  const requestGeneration = state.requestGeneration;
  try {
    const wirePayload = await apiRequest(selectedSimulationStatePath(), { timeoutMs: 8000 });
    if (requestGeneration !== state.requestGeneration) {
      return;
    }
    const payload = decodeSimulationState(wirePayload);
    if (!consumeSimulationState(payload, { observeInterval })) {
      return;
    }
    if (state.connectionNoticeShown) {
      hideNotice();
      state.connectionNoticeShown = false;
    }
    state.pollFailures = 0;
  } catch (error) {
    if (requestGeneration !== state.requestGeneration) {
      return;
    }
    if (error instanceof StateProtocolError) {
      state.pollAgain = true;
      return;
    }
    state.pollFailures += 1;
    if (state.pollFailures === 3) {
      showNotice(`Megszakadt a kapcsolat a Python szimulációval: ${error.message}`);
      state.connectionNoticeShown = true;
    }
  } finally {
    state.polling = false;
    if (state.configured && !state.controlPending && !document.hidden) {
      const elapsedMs = performance.now() - pollStartedAt;
      if (state.pollAgain) {
        state.skipNextIntervalSample = true;
      }
      scheduleSimulationPoll(state.pollAgain ? 0 : nextPollDelay(elapsedMs));
    }
  }
}

async function initializeApplication() {
  if (document.hidden) {
    return;
  }
  if (state.initializing) {
    scheduleInitializationRetry(100);
    return;
  }
  const requestGeneration = ++state.requestGeneration;
  state.initializing = true;
  if (state.initializationTimer !== null) {
    window.clearTimeout(state.initializationTimer);
    state.initializationTimer = null;
  }
  setControlsEnabled(false);
  hideNotice();
  dom.networkStatus.textContent = "A Python szerver ellenőrzése…";
  try {
    const health = await apiRequest("/api/health");
    if (requestGeneration !== state.requestGeneration) {
      return;
    }
    if (!health.networkLoaded) {
      throw new Error(
        health.networkError
        || "A fix térképfájl hiányzik. Futtasd: python tools\\download_ujbuda_osm.py",
      );
    }
    if (
      state.serverInstanceId
      && health.serverInstanceId
      && state.serverInstanceId !== health.serverInstanceId
    ) {
      inspectFeature(null);
      state.stateProtocolCache = createStateProtocolCache();
      resetReplayHistory();
    }
    state.serverInstanceId = health.serverInstanceId || state.serverInstanceId;
    const cachedNetworkId = state.network?.meta?.networkId;
    if (
      state.network
      && health.networkId
      && cachedNetworkId
      && health.networkId !== cachedNetworkId
    ) {
      inspectFeature(null);
      state.localMap?.destroy();
      state.localMap = null;
      state.viewportInteracting = false;
      state.viewportUiDirty = false;
      state.network = null;
      state.stateProtocolCache = createStateProtocolCache();
      resetReplayHistory();
      state.edgesBySegment.clear();
      state.poisById.clear();
      state.poiCategoryCounts.clear();
      state.activePoiCategories.clear();
    }

    let network = state.network;
    if (!network) {
      dom.networkStatus.textContent = "A tömörített helyi térkép beolvasása…";
      const loadedNetwork = await apiRequest("/api/network", {
        cache: "no-cache",
        timeoutMs: 60000,
      });
      if (requestGeneration !== state.requestGeneration) {
        return;
      }
      network = loadedNetwork;
      state.network = network;
      state.edgesBySegment = buildSegmentEdgeIndex(network);
      state.localMap?.destroy();
      state.localMap = null;
      state.viewportInteracting = false;
      state.viewportUiDirty = false;
      renderPoiFilters(network);
      state.localMap = new LocalTrafficMap(document.querySelector("#map"), network, {
        onFeatureSelect: inspectFeature,
        onViewportInteractionChange: handleViewportInteractionChange,
        agentColorModes: state.agentColorModes,
        staticRenderOptions: state.mapRenderOptions,
        onStaticPreparationChange: handleStaticPreparationChange,
      });
      state.localMap.setTrafficHeatmapEnabled(state.trafficHeatmapEnabled);
      state.localMap.setSegmentStatistics(state.segmentStatistics);
    }

    let configured = null;
    if (health.configured) {
      const wirePayload = await apiRequest(selectedSimulationStatePath(), {
        timeoutMs: 15000,
      });
      configured = decodeSimulationState(wirePayload);
    }
    if (!configured?.configured) {
      configured = await apiRequest("/api/simulation/configure", {
        method: "POST",
        body: {
          cars: Number(dom.carCount.value),
          pedestrians: Number(dom.pedestrianCount.value),
        },
        timeoutMs: 60000,
      });
    }
    if (requestGeneration !== state.requestGeneration) {
      return;
    }
    if (
      configured.serverInstanceId
      && health.serverInstanceId
      && configured.serverInstanceId !== health.serverInstanceId
    ) {
      throw new Error("A Python szerver betöltés közben újraindult.");
    }
    state.configured = true;
    state.serverInstanceId = configured.serverInstanceId || state.serverInstanceId;
    if (configured.stats) {
      if (Number.isFinite(Number(configured.stats.cars))) {
        dom.carCount.value = String(configured.stats.cars);
        dom.carCountValue.textContent = dom.carCount.value;
      }
      if (Number.isFinite(Number(configured.stats.pedestrians))) {
        dom.pedestrianCount.value = String(configured.stats.pedestrians);
        dom.pedestrianCountValue.textContent = dom.pedestrianCount.value;
      }
    }
    if (configured.speedMultiplier !== undefined) {
      dom.simulationSpeed.value = String(configured.speedMultiplier);
    }
    if (Array.isArray(configured.agents)) {
      consumeSimulationState(configured);
    } else {
      state.running = Boolean(configured.running);
      state.simulationEpoch = configured.simulationEpoch ?? state.simulationEpoch;
    }
    dom.mapPlaceholder.classList.add("hidden");
    dom.datasetPanel.classList.remove("dataset-panel-error");
    dom.networkStatus.textContent = "Fix OSM-pillanatkép betöltve";
    const counts = network.meta?.counts || health.network || {};
    const routing = configured.routing || {};
    const routingModes = Object.values(routing);
    const routeAnchors = routingModes.reduce(
      (total, mode) => total + Number(mode.viableAnchors || 0),
      0,
    );
    const gatewayAnchors = routingModes.reduce(
      (total, mode) => total + Number(mode.viableGatewayAnchors || 0),
      0,
    );
    const activeOdPairs = routingModes.reduce(
      (total, mode) => total + Number(mode.activeOdPairs || 0),
      0,
    );
    const carDestinationCandidates = Number(routing.car?.eligibleCandidates || 0);
    const pedestrianDestinationCandidates = Number(
      routing.pedestrian?.eligibleCandidates || 0,
    );
    dom.networkDetails.textContent = [
      `${formatInteger(counts.nodes || network.nodes?.length)} csomópont`,
      `${formatInteger(counts.edges || network.edges?.length)} irányított él`,
      `${formatInteger(counts.restrictions || network.restrictions?.length)} kanyarodási szabály`,
      `${formatInteger(counts.pois ?? network.pois?.length)} helyszín`,
      carDestinationCandidates || pedestrianDestinationCandidates
        ? `${formatInteger(carDestinationCandidates)} autós / ${formatInteger(pedestrianDestinationCandidates)} gyalogos úticéljelölt`
        : null,
      routeAnchors ? `${formatInteger(routeAnchors)} A–B horgony` : null,
      gatewayAnchors ? `${formatInteger(gatewayAnchors)} peremkapu` : null,
      activeOdPairs ? `${formatInteger(activeOdPairs)} aktív A–B kapcsolat` : null,
      configured.routeCatalogLoaded ? "előre generált útvonalkatalógus" : null,
    ].filter(Boolean).join(" · ");
    renderStats(configured.stats);
    setControlsEnabled(true);
    updateRunningUi();
    state.initializationFailures = 0;
    state.connectionNoticeShown = false;
    hideNotice();
    scheduleSimulationPoll(0);
    scheduleSegmentStatisticsPoll(0);
  } catch (error) {
    if (requestGeneration !== state.requestGeneration) {
      return;
    }
    console.error(error);
    state.configured = false;
    state.running = false;
    state.initializationFailures += 1;
    dom.datasetPanel.classList.add("dataset-panel-error");
    dom.networkStatus.textContent = "Várakozás a helyi Python szerverre…";
    dom.networkDetails.textContent = `${error.message} Automatikus újrapróbálás folyamatban.`;
    dom.routeStatus.textContent = "Újracsatlakozás a helyi szimulációhoz…";
    showNotice(`${error.message} Automatikusan újrapróbáljuk.`, "info");
    scheduleInitializationRetry();
  } finally {
    state.initializing = false;
  }
}

function scheduleSettingsUpdate(event) {
  const target = event.currentTarget;
  if (target === dom.carCount) {
    dom.carCountValue.textContent = dom.carCount.value;
  } else if (target === dom.pedestrianCount) {
    dom.pedestrianCountValue.textContent = dom.pedestrianCount.value;
  }
  if (!state.configured) {
    return;
  }
  if (target === dom.carCount) {
    state.pendingSettingsPayload.cars = Number(dom.carCount.value);
  } else if (target === dom.pedestrianCount) {
    state.pendingSettingsPayload.pedestrians = Number(dom.pedestrianCount.value);
  } else if (target === dom.simulationSpeed) {
    state.pendingSettingsPayload.speedMultiplier = Number(dom.simulationSpeed.value);
  }
  clearTimeout(state.settingsTimer);
  state.settingsTimer = window.setTimeout(async () => {
    const body = state.pendingSettingsPayload;
    state.pendingSettingsPayload = {};
    if (Object.keys(body).length === 0) {
      return;
    }
    const requestGeneration = ++state.requestGeneration;
    try {
      const payload = await apiRequest("/api/simulation/settings", {
        method: "POST",
        body,
      });
      if (requestGeneration === state.requestGeneration) {
        renderStats(payload.stats);
      }
    } catch (error) {
      if (requestGeneration === state.requestGeneration) {
        showNotice(error.message);
      }
    }
  }, 140);
}

dom.reloadNetwork.addEventListener("click", () => window.location.reload());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pauseReplayPlayback();
    if (state.initializing || state.polling) {
      state.requestGeneration += 1;
    }
    if (state.pollTimer !== null) {
      window.clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.segmentStatsTimer !== null) {
      window.clearTimeout(state.segmentStatsTimer);
      state.segmentStatsTimer = null;
    }
    state.localMap?.resetAgentTiming();
    updateRunningUi();
    return;
  }
  state.localMap?.resetAgentTiming();
  if (state.configured) {
    scheduleImmediateSimulationPoll();
    scheduleSegmentStatisticsPoll(0);
  } else if (!state.configured) {
    scheduleInitializationRetry(0);
  }
});
dom.closeInspector.addEventListener("click", () => {
  inspectFeature(null);
});
dom.poiFilterAll.addEventListener("click", () => {
  state.activePoiCategories = new Set(state.poiCategoryCounts.keys());
  updatePoiFilterUi();
});
dom.poiFilterNone.addEventListener("click", () => {
  state.activePoiCategories.clear();
  updatePoiFilterUi();
});
dom.carCount.addEventListener("input", scheduleSettingsUpdate);
dom.pedestrianCount.addEventListener("input", scheduleSettingsUpdate);
dom.simulationSpeed.addEventListener("change", scheduleSettingsUpdate);
dom.carIndividualColors.addEventListener("change", (event) => {
  setAgentColorMode("car", event.currentTarget.checked);
});
dom.pedestrianIndividualColors.addEventListener("change", (event) => {
  setAgentColorMode("pedestrian", event.currentTarget.checked);
});
dom.trafficHeatmap.addEventListener("change", (event) => {
  setTrafficHeatmapEnabled(event.currentTarget.checked);
});
dom.prepareAllMapLayers.addEventListener("change", (event) => {
  setMapRenderOption("prepareAllLayers", event.currentTarget.checked);
});
dom.renderFullMap.addEventListener("change", (event) => {
  setMapRenderOption("renderFullMap", event.currentTarget.checked);
});
dom.replayRange.addEventListener("input", () => {
  const sequence = Number(dom.replayRange.value);
  const timeline = activeReplayTimeline();
  const metadata = state.replayPlaybackMetadata
    ?? state.replayMetadata;
  const preserveSnapshot = timeline === state.replayPlaybackSnapshot;
  stopReplayPlayback({ preserveSnapshot });
  if (sequence >= timeline.newestSequence) {
    returnToLive();
    return;
  }
  presentReplaySequence(sequence, { timeline, metadata });
});
dom.replayPlay.addEventListener("click", toggleReplayPlayback);
dom.replayLive.addEventListener("click", returnToLive);

dom.startPause.addEventListener("click", async () => {
  if (state.controlPending) {
    return;
  }
  setControlPending(true);
  if (state.pollTimer !== null) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  const requestGeneration = ++state.requestGeneration;
  try {
    const payload = await apiRequest("/api/simulation/control", {
      method: "POST",
      body: { action: state.running ? "pause" : "start" },
    });
    if (requestGeneration === state.requestGeneration) {
      consumeSimulationState(payload);
    }
  } catch (error) {
    if (requestGeneration === state.requestGeneration) {
      showNotice(error.message);
    }
  } finally {
    setControlPending(false);
    scheduleImmediateSimulationPoll();
  }
});

dom.reset.addEventListener("click", async () => {
  if (state.controlPending) {
    return;
  }
  setControlPending(true);
  if (state.pollTimer !== null) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  inspectFeature(null);
  const requestGeneration = ++state.requestGeneration;
  try {
    const payload = await apiRequest("/api/simulation/control", {
      method: "POST",
      body: { action: "reset" },
    });
    if (requestGeneration === state.requestGeneration) {
      consumeSimulationState(payload);
    }
  } catch (error) {
    if (requestGeneration === state.requestGeneration) {
      showNotice(error.message);
    }
  } finally {
    setControlPending(false);
    scheduleImmediateSimulationPoll();
  }
});

syncAgentColorControls();
syncMapRenderControls();
syncTrafficHeatmapControls();
renderStaticPreparationStatus(state.staticPreparationStatus);
updateReplayUi();
initializeApplication();
