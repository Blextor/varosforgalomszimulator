import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, app, styles, server] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
  readFile(new URL("../server.py", import.meta.url), "utf8"),
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

assert.match(app, /createReplayBuffer\(\)/);
assert.match(app, /recordReplayPayload\(payload/);
assert.match(app, /presentReplaySequence\(sequence/);
assert.match(app, /dom\.replayRange\.addEventListener\("input"/);
assert.match(app, /AGENT_COLOR_STORAGE_KEY/);
assert.match(app, /setAgentColorMode\("car"/);
assert.match(app, /setAgentColorMode\("pedestrian"/);
assert.match(app, /agentColorModes: state\.agentColorModes/);
assert.match(styles, /\.agent-color-toggle/);
assert.match(styles, /@media \(forced-colors: active\)/);
assert.match(app, /state\.replayMode === "live" && state\.selectedFeature/);
assert.match(server, /"src\/replay-buffer\.js"/);

console.log("replay UI/static-server wiring contract: OK");
