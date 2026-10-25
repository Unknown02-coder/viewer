import test from "node:test";
import assert from "node:assert/strict";
import { decodeSnapshot, toSession } from "../server/chatgpt/snapshot.mjs";
import { snapshot, bytes, sourceId } from "./helpers/chatgpt.mjs";

test("snapshot preserves source IDs, exact text, honest coverage and page/item references without fake changes", () => {
  const input = snapshot({
    text: "<script>bad()</script>\n```sh\nnever-run\n```",
    truncated: true,
  });
  const decoded = decodeSnapshot(bytes(input));
  assert.equal(decoded.id, `chatgpt:${sourceId}:thread-one`);
  assert.equal(decoded.coverage.text, "partial");
  const session = toSession(decoded, {
    sourcePath: "local.json",
    snapshotId: "a".repeat(64),
    importedAt: input.capturedAt,
  });
  assert.equal(session.sourceKind, "chatgpt");
  assert.equal(session.project, "");
  assert.equal(
    session.turns[0].tasks[0].text,
    "<script>bad()</script>\n```sh\nnever-run\n```",
  );
  assert.deepEqual(session.turns[0].tasks[0].files, []);
  assert.equal(session.evidence[1].reference.page, 0);
  assert.equal(session.evidence[1].reference.itemId, "answer-one");
  assert.ok(session.limitations.some((message) => /시각/.test(message)));
});

test("same-title conversations keep different identities and missing traversal is partial", () => {
  assert.notEqual(
    decodeSnapshot(bytes(snapshot())).id,
    decodeSnapshot(bytes(snapshot({ threadId: "other" }))).id,
  );
  const d = decodeSnapshot(bytes(snapshot({ complete: false })));
  assert.equal(d.coverage.traversal, "partial");
  assert.equal(d.coverage.text, "complete");
});

test("conflicting duplicate IDs, malformed/cross-thread pages and unsupported schemas are rejected", () => {
  const duplicate = snapshot();
  const doc = JSON.parse(duplicate.pages[0].result.content[0].text);
  doc.turns[0].items.push({ ...doc.turns[0].items[1], text: "different" });
  duplicate.pages[0].result.content[0].text = JSON.stringify(doc);
  assert.throws(() => decodeSnapshot(bytes(duplicate)), /중복|충돌/);
  const wrong = snapshot();
  wrong.pages[0].request.threadId = "other";
  assert.throws(() => decodeSnapshot(bytes(wrong)), /대화/);
  assert.throws(
    () => decodeSnapshot(bytes({ ...snapshot(), schemaVersion: 99 })),
    /형식/,
  );
  assert.throws(() => decodeSnapshot(Buffer.from("{bad")), /JSON/);
});

test("metadata and capture time do not change message identity or semantic digest", () => {
  const a = decodeSnapshot(bytes(snapshot()));
  const b = decodeSnapshot(
    bytes(snapshot({ capturedAt: "2026-10-25T09:00:00.000Z" })),
  );
  assert.equal(a.digest, b.digest);
});

test("delimiter-like original IDs cannot collide in viewer identities and oversized IDs are rejected", () => {
  const a = {
    id: "a:message:b",
    items: [
      {
        type: "userMessage",
        id: "q",
        content: [{ type: "text", text: "first" }],
      },
      { type: "agentMessage", id: "c", text: "one" },
    ],
  };
  const b = {
    id: "a",
    items: [
      {
        type: "userMessage",
        id: "q",
        content: [{ type: "text", text: "second" }],
      },
      { type: "agentMessage", id: "b:message:c", text: "two" },
    ],
  };
  const s = toSession(decodeSnapshot(bytes(snapshot({ turns: [a, b] }))), {
    sourcePath: "x",
    snapshotId: "a".repeat(64),
    importedAt: "",
  });
  assert.equal(new Set(s.evidence.map((e) => e.id)).size, 4);
  assert.throws(
    () => decodeSnapshot(bytes(snapshot({ threadId: "한".repeat(300) }))),
    /정보|ID/,
  );
});

test("linked pages require exact cursor continuity, mark partial edges, and preserve duplicate text with distinct IDs", () => {
  const first = snapshot({ complete: false }),
    second = snapshot();
  const doc = JSON.parse(second.pages[0].result.content[0].text);
  doc.turns[0].id = "older";
  doc.turns[0].items = doc.turns[0].items.map((i) => ({
    ...i,
    id: "older-" + i.id,
  }));
  second.pages[0].result.content[0].text = JSON.stringify(doc);
  second.pages[0].request.cursor = "turn-one";
  first.pages.push(second.pages[0]);
  const d = decodeSnapshot(bytes(first));
  assert.equal(d.turns.length, 2);
  assert.equal(d.coverage.traversal, "complete");
  assert.equal(d.turns[0].id, "older");
  assert.equal(d.turns[1].id, "turn-one");
  first.pages[1].request.cursor = "wrong";
  assert.throws(() => decodeSnapshot(bytes(first)), /연결/);
  const partial = snapshot();
  partial.pages[0].request.cursor = "start-older";
  assert.equal(decodeSnapshot(bytes(partial)).coverage.traversal, "partial");
  assert.throws(() => decodeSnapshot(Buffer.alloc(50 * 1024 * 1024 + 1)), /50/);
});

test("missing or invalid observed request limit and capture time cannot claim complete text", () => {
  for (const limit of [undefined, null, "20000", 0, -1, 20001]) {
    const s = snapshot({ text: "x".repeat(20000) });
    s.pages[0].request.maxOutputCharsPerItem = limit;
    assert.throws(() => decodeSnapshot(bytes(s)), /출력|한도/);
  }
  const badTime = snapshot();
  badTime.pages[0].receivedAt = "unknown";
  assert.throws(() => decodeSnapshot(bytes(badTime)), /시각/);
});
