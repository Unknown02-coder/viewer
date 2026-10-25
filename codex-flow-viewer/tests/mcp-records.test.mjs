import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ViewerStore } from "../server/store.mjs";
import { DirectRecords } from "../server/mcp/records.mjs";
const request = () => randomUUID();
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-direct-")),
    filename = path.join(dir, "state.sqlite"),
    store = new ViewerStore(filename),
    repo = new DirectRecords(store),
    stores = [store];
  t.after(async () => {
    for (const s of stores) s.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { repo, store, filename, stores };
}
function conversation(repo) {
  const p = repo.createProject({
    name: "직접 연결 프로젝트",
    requestId: request(),
  });
  return repo.startConversation({
    projectId: p.projectId,
    title: "받은 대화",
    requestId: request(),
  });
}
test("direct receipts preserve exact question/answer/summary, source identity and saved preferences after reopening", async (t) => {
  const { repo, store, filename, stores } = await setup(t),
    c = conversation(repo),
    q = "<script>never()</script> 질문",
    a = "```sh\nnever-run\n```\n답변 원문",
    key = request();
  const result = repo.record({
    conversationId: c.conversationId,
    question: q,
    answer: a,
    summary: "별도 요약",
    requestId: key,
  });
  assert.equal(result.saved, true);
  await repo.refresh();
  const s = repo.get("mcp:" + c.conversationId);
  assert.equal(s.sourceKind, "chatgpt-mcp");
  assert.equal(s.turns[0].requests[0].text, q);
  assert.equal(s.turns[0].tasks[0].text, a);
  assert.equal(s.turns[0].receivedSummary, "별도 요약");
  assert.deepEqual(s.turns[0].tasks[0].files, []);
  assert.equal(s.evidence[1].receiverReference.receiptId, key);
  assert.equal(s.snapshotId, undefined);
  store.set("session:" + s.id, {
    notes: { [s.turns[0].id]: "보존" },
    pinned: [s.turns[0].id],
  });
  const reopened = new ViewerStore(filename);
  stores.push(reopened);
  const again = new DirectRecords(reopened);
  await again.refresh();
  assert.equal(again.get(s.id).revision, s.revision);
  assert.deepEqual(reopened.get("session:" + s.id).pinned, [s.turns[0].id]);
});
test("same retry deduplicates, conflicting or cross-operation retries reject without touching previous records", async (t) => {
  const { repo } = await setup(t),
    c = conversation(repo),
    value = {
      conversationId: c.conversationId,
      question: "질문",
      answer: "답변",
      requestId: request(),
    };
  const first = repo.record(value),
    second = repo.record({ ...value });
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(second.duplicate, true);
  assert.throws(() => repo.record({ ...value, answer: "다름" }), /충돌/);
  assert.throws(
    () =>
      repo.createProject({ name: "다른 프로젝트", requestId: value.requestId }),
    /충돌/,
  );
  await repo.refresh();
  assert.equal(repo.get("mcp:" + c.conversationId).turns.length, 1);
});
test("malformed/unknown/oversize input and transaction failure leave catalog, records and existing settings intact", async (t) => {
  const { repo, store } = await setup(t),
    c = conversation(repo);
  store.set("settings", { project: "keep" });
  store.set("session:old", { notes: { q: "keep" } });
  assert.throws(() =>
    repo.record({
      conversationId: c.conversationId,
      question: "q",
      answer: "a",
      requestId: request(),
      file: "C:\\sensitive",
    }),
  );
  assert.throws(
    () =>
      repo.record({
        conversationId: request(),
        question: "q",
        answer: "a",
        requestId: request(),
      }),
    /대화/,
  );
  assert.throws(() =>
    repo.record({
      conversationId: c.conversationId,
      question: "q",
      answer: "x".repeat(500001),
      requestId: request(),
    }),
  );
  store.db.exec(
    "CREATE TRIGGER reject_flow_receipt BEFORE INSERT ON flow_receipts BEGIN SELECT RAISE(ABORT,'injected disk failure'); END",
  );
  assert.throws(
    () =>
      repo.record({
        conversationId: c.conversationId,
        question: "q",
        answer: "a",
        requestId: request(),
      }),
    /injected/,
  );
  await repo.refresh();
  assert.equal(repo.get("mcp:" + c.conversationId).turns.length, 0);
  assert.deepEqual(store.get("settings"), { project: "keep" });
  assert.deepEqual(store.get("session:old"), { notes: { q: "keep" } });
});
test("same-title projects and conversations never merge and another DB connection is discovered on refresh", async (t) => {
  const { repo, filename, stores } = await setup(t),
    a = conversation(repo),
    b = conversation(repo);
  assert.notEqual(a.projectId, b.projectId);
  assert.notEqual(a.conversationId, b.conversationId);
  const otherStore = new ViewerStore(filename);
  stores.push(otherStore);
  const other = new DirectRecords(otherStore);
  other.record({
    conversationId: a.conversationId,
    question: "같은 질문",
    answer: "같은 답변",
    requestId: request(),
  });
  other.record({
    conversationId: a.conversationId,
    question: "같은 질문",
    answer: "같은 답변",
    requestId: request(),
  });
  await repo.refresh();
  assert.equal(repo.list(a.projectId).length, 1);
  assert.equal(repo.get("mcp:" + a.conversationId).turns.length, 2);
  assert.equal(repo.get("mcp:" + b.conversationId).turns.length, 0);
});
