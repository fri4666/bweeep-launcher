// The launch screen follows one job while another runs next to it: events of the
// background job are only recorded until the foreground job is done, errors
// always get through, and a failed launch silences the background job.
import assert from "node:assert/strict";
import { createBackgroundLane, startBesideSync } from "../dist/src/main/launch-progress.js";

const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));
const later = (ms, value, fail = false) => new Promise((resolve, reject) => setTimeout(() => (fail ? reject(new Error(String(value))) : resolve(value)), ms));

const make = () => {
  const shown = [];
  const recorded = [];
  const lane = createBackgroundLane((event) => shown.push(event), (event) => recorded.push(event));
  return { lane, shown, recorded };
};
const info = (message, stage = "게임 리소스") => ({ kind: "info", stage, message });

{
  const { lane, shown, recorded } = make();
  lane.sink(info("a"));
  lane.sink(info("b"));
  assert.deepEqual(shown, [], "nothing of the background job shows while the foreground job runs");
  assert.equal(recorded.length, 2, "but the launch log gets every event");
  lane.surface();
  assert.deepEqual(shown.map((event) => event.message), ["b"], "the latest state takes over once the foreground job is done");
  lane.sink(info("c"));
  assert.deepEqual(shown.map((event) => event.message), ["b", "c"], "after that everything shows");
  lane.surface();
  assert.equal(shown.length, 2, "surfacing twice shows nothing twice");
  console.log("launch-progress-background-then-foreground=passed");
}

{
  const { lane, shown } = make();
  lane.sink({ kind: "error", stage: "게임 리소스", message: "받지 못했어요" });
  assert.equal(shown.length, 1, "an error is never held back");
  lane.surface();
  assert.equal(shown.length, 1, "and is not shown a second time");
  console.log("launch-progress-errors-pass=passed");
}

{
  const { lane, shown, recorded } = make();
  lane.sink(info("a"));
  lane.silence();
  lane.surface();
  lane.sink(info("late"));
  lane.sink({ kind: "error", stage: "게임 리소스", message: "late error" });
  assert.deepEqual(shown, [], "a failed launch hears nothing more from the background job");
  assert.equal(recorded.length, 3, "yet the log still records what happened");
  console.log("launch-progress-silenced=passed");
}

{
  const { lane, shown } = make();
  lane.surface();
  assert.deepEqual(shown, [], "surfacing with nothing to show shows nothing");
  lane.sink(info("x"));
  assert.equal(shown.length, 1);
  console.log("launch-progress-nothing-pending=passed");
}

// --- Starting the pack sync and the game files together ---------------------------
{
  // Both succeed; the game files are slower, so the screen switches to them when the pack is in.
  const { lane, shown } = make();
  const started = startBesideSync(lane, async () => { await later(20); return "synced"; }, async () => { lane.sink(info("assets 1/9")); await later(60); lane.sink(info("assets 9/9")); return "prepared"; });
  assert.equal(await started.ready, "synced");
  assert.equal(await started.preparing, "prepared");
  assert.deepEqual(shown.map((event) => event.message), ["assets 1/9", "assets 9/9"], "the game files show from the moment the pack is in, including what already happened");
  console.log("launch-start-beside-sync=passed");
}

{
  // The game files fail first: the launch fails at once, the pack sync is still running and the next launch can wait for it.
  const { lane } = make();
  let syncDone = false;
  const started = startBesideSync(lane, async () => { await later(80); syncDone = true; return "synced"; }, async () => later(10, "no java", true));
  const began = Date.now();
  await assert.rejects(started.ready, /no java/);
  assert.ok(Date.now() - began < 60 && !syncDone, "failed fast while the sync was still running");
  await started.settled();
  assert.ok(syncDone, "settled() waits for the job that was left running");
  console.log("launch-start-beside-sync-prepare-fails=passed");
}

{
  // The pack sync fails first: the game files are left running and nothing is reported twice.
  const { lane, shown } = make();
  let prepared = false;
  const started = startBesideSync(lane, async () => later(10, "disk full", true), async () => { await later(80); prepared = true; return "prepared"; });
  await assert.rejects(started.ready, /disk full/);
  lane.silence();
  assert.equal(prepared, false);
  await started.settled();
  assert.ok(prepared);
  assert.deepEqual(shown, []);
  console.log("launch-start-beside-sync-sync-fails=passed");
}

{
  // Both fail: one error comes back and the other raises no unhandled rejection.
  const { lane } = make();
  const started = startBesideSync(lane, async () => later(10, "sync broke", true), async () => later(30, "prepare broke", true));
  await assert.rejects(started.ready, /sync broke/);
  await started.settled();
  await later(30);
  assert.deepEqual(unhandled, [], "no rejection is left without a handler");
  console.log("launch-start-beside-sync-both-fail=passed");
}
