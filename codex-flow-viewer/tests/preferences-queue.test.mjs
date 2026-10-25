import test from "node:test";
import assert from "node:assert/strict";
import { PreferenceSaveQueue } from "../src/preferences-queue.ts";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

test("preference writes are serialized and a newer immediate save cannot be overtaken by an old autosave", async () => {
  const first = deferred(),
    entered = deferred(),
    sent = [];
  const queue = new PreferenceSaveQueue(async (record) => {
    sent.push(record.value);
    if (sent.length === 1) {
      entered.resolve();
      await first.promise;
    }
  });
  queue.stage("a", { notes: { q: "old" } }, "scope");
  const old = queue.flush();
  await entered.promise;
  queue.stage("a", { notes: { q: "new" } }, "scope");
  const latest = queue.flush();
  await Promise.resolve();
  assert.equal(sent.length, 1);
  first.resolve();
  await Promise.all([old, latest]);
  assert.deepEqual(sent, [{ notes: { q: "old" } }, { notes: { q: "new" } }]);
});
test("flush without a pending value still waits for an earlier in-flight save", async () => {
  const hold = deferred(),
    entered = deferred();
  const queue = new PreferenceSaveQueue(async () => {
    entered.resolve();
    await hold.promise;
  });
  queue.stage("a", { notes: {} }, "scope");
  const first = queue.flush();
  await entered.promise;
  let finished = false;
  const beforeSwitch = queue.flush().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  hold.resolve();
  await Promise.all([first, beforeSwitch]);
  assert.equal(finished, true);
});
test("connection loss preserves newer pending edits and an older failure cannot overwrite recovery", async () => {
  const hold = deferred(),
    entered = deferred();
  const queue = new PreferenceSaveQueue(async () => {
    entered.resolve();
    await hold.promise;
  });
  queue.stage("a", { notes: { q: "old" } }, "old-scope");
  const first = queue.flush();
  await entered.promise;
  queue.stage("a", { notes: { q: "new" } }, "old-scope");
  assert.equal(queue.preserve(), true);
  hold.reject(new Error("connection changed"));
  await assert.rejects(first);
  assert.deepEqual(queue.recover("a"), { notes: { q: "new" } });
  await queue.flush();
});
