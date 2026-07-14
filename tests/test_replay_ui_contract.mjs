import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, app, styles, server, localMap] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
  readFile(new URL("../server.py", import.meta.url), "utf8"),
  readFile(new URL("../src/local-map.js", import.meta.url), "utf8"),
]);

for (const id of ["replay-range", "replay-position", "replay-play", "replay-live"]) {
  assert.match(html, new RegExp(`id=["']${id}["']`));
  const camelCase = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  assert.match(app, new RegExp(`${camelCase}: document\\.querySelector`));
}

for (const id of ["car-individual-colors", "pedestrian-individual-colors"]) {
  assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, new RegExp(`for=["']${id}["']`));
  const camelCase = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  assert.match(app, new RegExp(`${camelCase}: document\\.querySelector`));
}

for (const id of ["traffic-heatmap", "legend-traffic-heatmap"]) {
  assert.match(html, new RegExp(`id=["']${id}["']`));
  const camelCase = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  assert.match(app, new RegExp(`${camelCase}: document\\.querySelector`));
}
assert.match(html, /id=["']car-count["'][^>]*max=["']3000["']/);
assert.match(html, /id=["']pedestrian-count["'][^>]*[\s\S]{0,160}max=["']4000["']/);
assert.match(app, /\/api\/simulation\/segments/);
assert.match(app, /setTrafficHeatmapEnabled/);
assert.match(styles, /\.traffic-heatmap-scale/);
assert.match(styles, /linear-gradient\(90deg/);

for (const id of ["prepare-all-map-layers", "render-full-map"]) {
  assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, new RegExp(`for=["']${id}["']`));
  const camelCase = id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  assert.match(app, new RegExp(`${camelCase}: document\\.querySelector`));
  assert.match(app, new RegExp(`dom\\.${camelCase}\\.addEventListener\\(["']change["']`));
}
assert.match(html, /id=["']map-render-status["']/);
assert.match(html, /id=["']map-render-status["'][^>]*role=["']status["']/);
assert.match(html, /id=["']map-render-help["']/);
assert.match(html, /Minden részletességi szint előkészítése/);
assert.match(html, /Teljes kerület előrajzolása/);
assert.match(html, /A gyorsított mód több memóriát használ/);
assert.match(html, /kis fekete margóval/);
assert.match(app, /mapRenderStatus: document\.querySelector/);
assert.match(app, /MAP_RENDER_OPTIONS_STORAGE_KEY/);
assert.match(app, /staticRenderOptions: state\.mapRenderOptions/);
assert.match(app, /onStaticPreparationChange: handleStaticPreparationChange/);
assert.match(app, /setStaticRenderOptions\?\.\(\{ \.\.\.nextOptions \}\)/);

assert.match(app, /createReplayBuffer\(\)/);
assert.match(app, /recordReplayPayload\(payload/);
assert.match(app, /presentReplaySequence\(sequence/);
assert.match(app, /dom\.replayRange\.addEventListener\("input"/);
assert.match(app, /AGENT_COLOR_STORAGE_KEY/);
assert.match(app, /setAgentColorMode\("car"/);
assert.match(app, /setAgentColorMode\("pedestrian"/);
assert.match(app, /agentColorModes: state\.agentColorModes/);
assert.match(app, /onViewportInteractionChange: handleViewportInteractionChange/);
assert.match(app, /const deferViewportUi = state\.viewportInteracting/);
assert.match(app, /renderStatistics: !deferViewportUi/);
assert.match(app, /renderDetails: !deferViewportUi/);
assert.match(app, /state\.viewportUiDirty = true/);
assert.doesNotMatch(app, /state\.viewportInteracting \|\| state\.localMap\?\.isViewportInteracting/);
assert.match(styles, /\.agent-color-toggle/);
assert.match(styles, /\.map-render-controls/);
assert.match(styles, /\.map-render-toggle/);
assert.match(styles, /\.map-render-status/);
assert.match(styles, /@media \(forced-colors: active\)[\s\S]*\.map-render-toggle input/);
assert.match(styles, /\.local-map-viewport-layer[\s\S]*will-change: transform/);
assert.match(styles, /\.local-map-agents[\s\S]*will-change: transform/);
assert.match(localMap, /this\.viewportLayer\.append\(this\.baseCanvas\)/);
assert.match(
  localMap,
  /this\.container\.replaceChildren\(\s*this\.staticFullMapLayer,\s*this\.viewportLayer,\s*this\.staticTileLayer,\s*this\.heatmapCanvas,\s*this\.poiLabelCanvas,\s*this\.agentCanvas,\s*\)/,
);
assert.match(localMap, /drawPoiLabels\(\)[\s\S]*font = "600 10px/);
assert.match(localMap, /drawTrafficHeatmap\(\)/);
assert.doesNotMatch(localMap, /this\.viewportLayer\.append\(this\.baseCanvas, this\.agentCanvas\)/);
assert.match(styles, /@media \(forced-colors: active\)/);
assert.match(app, /state\.replayMode === "live" && state\.selectedFeature/);
assert.match(server, /"src\/replay-buffer\.js"/);

console.log("replay UI/static-server wiring contract: OK");
