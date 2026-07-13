import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourceUrl = new URL("../src/simulation-timing.js", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const timing = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

assert.equal(timing.RUNNING_POLL_INTERVAL_MS, 125);
assert.equal(timing.HIGH_AGENT_POLL_THRESHOLD, 3_000);
assert.equal(timing.HIGH_AGENT_POLL_INTERVAL_MS, 200);
assert.equal(timing.IDLE_POLL_INTERVAL_MS, 750);
assert.equal(timing.runningPollIntervalForAgentCount(2_999), 125);
assert.equal(timing.runningPollIntervalForAgentCount(3_000), 200);
assert.equal(
  timing.pollDelayAfterElapsed({ running: true, elapsedMs: 25 }),
  100,
);
assert.equal(
  timing.pollDelayAfterElapsed({ running: true, elapsedMs: 200 }),
  0,
);
assert.equal(
  timing.pollDelayAfterElapsed({ running: true, failures: 1, elapsedMs: 25 }),
  225,
);
assert.equal(
  timing.pollDelayAfterElapsed({ running: false, elapsedMs: 50 }),
  700,
);
assert.equal(
  timing.pollDelayAfterElapsed({ running: true, agentCount: 2_999 }),
  125,
);
assert.equal(
  timing.pollDelayAfterElapsed({ running: true, agentCount: 3_000 }),
  200,
);
assert.equal(
  timing.pollDelayAfterElapsed({ running: true, agentCount: 3_000, elapsedMs: 50 }),
  150,
);

assert.equal(timing.updateAgentFrameInterval(125, 145), 130);
assert.equal(timing.updateAgentFrameInterval(125, 40), 125);
assert.equal(timing.updateAgentFrameInterval(125, 350), 125);
assert.equal(timing.agentTransitionDuration(125), 101);
assert.equal(timing.agentTransitionDuration(50), 90);
assert.equal(timing.agentTransitionDuration(300), 276);
assert.equal(timing.interpolationProgress(100, 0, 200), 0.5);
assert.equal(timing.interpolationProgress(250, 0, 200), 1);
assert.equal(timing.interpolationProgress(-10, 0, 200), 0);

assert.equal(timing.interpolateHeading(350, 10, 0.5), 0);
assert.equal(timing.interpolateHeading(10, 350, 0.5), 0);
assert.equal(timing.interpolateHeading(90, 180, 0.25), 112.5);
assert.equal(timing.interpolateHeading(90, 180, 2), 180);

function simulatedPollStarts(requestDurationMs, count) {
  const starts = [];
  let clock = 0;
  let maxConcurrent = 0;
  let concurrent = 0;
  for (let index = 0; index < count; index += 1) {
    starts.push(clock);
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    clock += requestDurationMs;
    concurrent -= 1;
    clock += timing.pollDelayAfterElapsed({
      running: true,
      elapsedMs: requestDurationMs,
    });
  }
  return { starts, maxConcurrent };
}

const fastPolling = simulatedPollStarts(30, 4);
assert.deepEqual(fastPolling.starts, [0, 125, 250, 375]);
assert.equal(fastPolling.maxConcurrent, 1);
const slowPolling = simulatedPollStarts(200, 4);
assert.deepEqual(slowPolling.starts, [0, 200, 400, 600]);
assert.equal(slowPolling.maxConcurrent, 1);

console.log("simulation timing cadence/interpolation contract: OK");
