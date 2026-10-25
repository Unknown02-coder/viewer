import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ViewerStore } from "../server/store.mjs";
import { ChatGptRepository } from "../server/chatgpt/repository.mjs";
import { snapshot, bytes } from "./helpers/chatgpt.mjs";

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-import-"));
  const store = new ViewerStore(path.join(dir, "state.sqlite"));
  const repo = new ChatGptRepository({
    root: path.join(dir, "imports"),
    store,
  });
  await repo.refresh();
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, store, repo };
}
test("import preserves exact bytes, deduplicates messages and survives restart with preferences intact", async (t) => {
  const { dir, store, repo } = await setup(t);
  const raw = bytes(snapshot({ truncated: true }));
  const first = await repo.import(raw);
  assert.equal(first.applied, true);
  assert.deepEqual(await repo.source(first.id, first.snapshotId), raw);
  store.set("session:" + first.id, {
    notes: { saved: "keep" },
    pinned: ["saved"],
  });
  const second = await repo.import(raw);
  assert.equal(second.duplicate, true);
  assert.equal(repo.list().length, 1);
  assert.equal(repo.get(first.id).turns[0].tasks.length, 1);
  assert.equal(repo.catalog()[0].versionCount, 1);
  const restarted = new ChatGptRepository({
    root: path.join(dir, "imports"),
    store,
  });
  await restarted.refresh();
  assert.equal(restarted.get(first.id).coverage.text, "partial");
  assert.deepEqual(store.get("session:" + first.id), {
    notes: { saved: "keep" },
    pinned: ["saved"],
  });
});
test("failed and regressive imports retain the last good record while newer content keeps stable IDs", async (t) => {
  const { repo, store } = await setup(t);
  const first = await repo.import(bytes(snapshot()));
  const original = repo.get(first.id),
    old = store.set.bind(store);
  await assert.rejects(repo.import(Buffer.from("{broken")));
  assert.equal(repo.get(first.id).revision, original.revision);
  const partial = await repo.import(
    bytes(snapshot({ truncated: true, text: "short" })),
  );
  assert.equal(partial.applied, false);
  assert.match(partial.message, /기존/);
  assert.equal(repo.get(first.id).revision, original.revision);
  store.set = (key, value) => {
    if (key === "chatgpt:catalog") throw new Error("disk full");
    return old(key, value);
  };
  await assert.rejects(
    repo.import(bytes(snapshot({ text: "new answer" }))),
    /disk full/,
  );
  assert.equal(repo.get(first.id).revision, original.revision);
  store.set = old;
  const update = await repo.import(bytes(snapshot({ text: "new answer" })));
  assert.equal(update.applied, true);
  assert.equal(repo.get(first.id).turns[0].id, original.turns[0].id);
  assert.equal(
    repo.get(first.id).turns[0].tasks[0].id,
    original.turns[0].tasks[0].id,
  );
});
test("missing older messages are not deleted and concurrent imports are serialized", async (t) => {
  const { repo } = await setup(t);
  const one = snapshot();
  const doc = JSON.parse(one.pages[0].result.content[0].text);
  doc.turns.push({
    ...doc.turns[0],
    id: "older",
    items: doc.turns[0].items.map((i) => ({ ...i, id: "older-" + i.id })),
  });
  one.pages[0].result.content[0].text = JSON.stringify(doc);
  const first = await repo.import(bytes(one));
  const missing = await repo.import(bytes(snapshot()));
  assert.equal(missing.applied, false);
  assert.equal(repo.get(first.id).turns.length, 2);
  const imported = await Promise.all(
    Array.from({ length: 6 }, (_, n) =>
      repo.import(bytes(snapshot({ threadId: "other-" + n }))),
    ),
  );
  assert.equal(new Set(imported.map((r) => r.id)).size, 6);
  assert.equal(repo.list().length, 7);
});
test("corrupt latest source falls back to an earlier validated version after restart", async (t) => {
  const { repo, dir, store } = await setup(t);
  const first = await repo.import(bytes(snapshot()));
  const update = await repo.import(bytes(snapshot({ text: "updated answer" })));
  await fs.writeFile(
    path.join(dir, "imports", "snapshots", update.snapshotId + ".json"),
    "{corrupt",
  );
  const restarted = new ChatGptRepository({
    root: path.join(dir, "imports"),
    store,
  });
  await restarted.refresh();
  assert.equal(restarted.get(first.id).snapshotId, first.snapshotId);
  assert.match(restarted.error, /이전|읽지/);
  const limitations = [...restarted.get(first.id).limitations];
  await restarted.refresh();
  await restarted.refresh();
  assert.deepEqual(restarted.get(first.id).limitations, limitations);
  await assert.rejects(restarted.source(first.id, "../state.sqlite"));
});

test("a shorter still-truncated replacement cannot discard already observed text", async (t) => {
  const { repo } = await setup(t);
  const first = await repo.import(
    bytes(snapshot({ text: "x".repeat(20000), truncated: true })),
  );
  const shorter = snapshot({ text: "x".repeat(1000), truncated: true });
  shorter.pages[0].request.maxOutputCharsPerItem = 1000;
  const result = await repo.import(bytes(shorter));
  assert.equal(result.applied, false);
  assert.equal(repo.get(first.id).turns[0].tasks[0].text.length, 20000);
});

test("each coverage dimension is preserved independently when replacing a partial snapshot", async (t) => {
  const { repo } = await setup(t);
  const first = await repo.import(bytes(snapshot({ truncated: true })));
  const worse = await repo.import(
    bytes(snapshot({ truncated: true, complete: false })),
  );
  assert.equal(worse.applied, false);
  assert.equal(repo.get(first.id).coverage.traversal, "complete");
});
