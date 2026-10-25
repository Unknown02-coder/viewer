import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionRepository } from "../server/repository.mjs";
import { ViewerStore } from "../server/store.mjs";

const line = (value) => JSON.stringify(value) + "\n";
const metadata = (id, cwd) => ({ type: "session_meta", payload: { id, cwd } });
const question = (text) => ({
  type: "event_msg",
  payload: {
    type: "item_completed",
    turn_id: "t",
    item: { type: "UserMessage", id: "q", content: text },
  },
});
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-repository-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rollout.jsonl");
  await fs.writeFile(
    file,
    line(metadata("s", "C:/Projects/Flow")) + line(question("처음 질문")),
  );
  return {
    dir,
    file,
    repo: new SessionRepository({
      sessionsRoot: dir,
      project: "c:\\projects\\FLOW",
    }),
  };
}

test("discovers only an exact project match and never exposes another project session", async (t) => {
  const { dir, repo } = await fixture(t);
  await fs.writeFile(
    path.join(dir, "other.jsonl"),
    line(metadata("other", "C:/Projects/Flow-worktree")),
  );
  await repo.refresh();
  assert.deepEqual(
    repo.list().map((s) => s.id),
    ["s"],
  );
  assert.equal(repo.get("other"), undefined);
  assert.equal(repo.get("s").turns[0].title, "처음 질문");
});

test("incremental append retains partial bytes and rereads without duplication or source mutation", async (t) => {
  const { repo, file } = await fixture(t);
  await repo.refresh();
  const next = line({
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: "t",
      item: {
        type: "AgentMessage",
        id: "a",
        phase: "commentary",
        content: [{ type: "Text", text: "한글 설명" }],
      },
    },
  });
  await fs.appendFile(file, next.slice(0, -3));
  await repo.refresh();
  assert.equal(repo.get("s").turns[0].tasks.length, 0);
  assert.ok(repo.get("s").pendingBytes > 0);
  await fs.appendFile(file, next.slice(-3));
  const before = await fs.readFile(file);
  await repo.refresh();
  assert.equal(repo.get("s").turns[0].tasks[0].text, "한글 설명");
  await repo.refresh();
  assert.equal(repo.get("s").turns[0].tasks.length, 1);
  assert.deepEqual(await fs.readFile(file), before);
});

test("a truncated/replaced log rebuilds without stale turns", async (t) => {
  const { repo, file } = await fixture(t);
  await repo.refresh();
  await fs.writeFile(file, line(metadata("new", "C:/Projects/Flow")));
  await repo.refresh();
  assert.equal(repo.get("s"), undefined);
  assert.equal(repo.get("new").turns.length, 0);
});

test("SQLite state survives reopening without touching source records", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-store-"));
  const dbPath = path.join(dir, "viewer.sqlite");
  let store = new ViewerStore(dbPath);
  store.set("s", {
    pinned: ["task-1"],
    notes: { "task-1": "중요" },
    viewport: { x: 20, y: 30, zoom: 0.8 },
  });
  store.close();
  store = new ViewerStore(dbPath);
  t.after(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal(store.get("s").notes["task-1"], "중요");
  assert.equal(store.get("s").viewport.zoom, 0.8);
});

test("a newly created log with incomplete metadata is retried when its first line finishes", async (t) => {
  const { dir, file, repo } = await fixture(t);
  const text = line(metadata("s", "C:/Projects/Flow"));
  await fs.writeFile(file, text.slice(0, 20));
  await repo.refresh();
  assert.equal(repo.list().length, 0);
  await fs.appendFile(
    file,
    text.slice(20) + line(question("이제 보이는 질문")),
  );
  await repo.refresh();
  assert.equal(repo.get("s").turns[0].title, "이제 보이는 질문");
});

test("a larger same-inode rewrite to another project never mixes replacement records", async (t) => {
  const { file, repo } = await fixture(t);
  await repo.refresh();
  await fs.writeFile(
    file,
    line(metadata("other", "C:/Projects/Other")) +
      line(question("OTHER PROJECT SECRET ".repeat(50))),
  );
  await repo.refresh();
  assert.equal(repo.list().length, 0);
  assert.equal(repo.get("s"), undefined);
});

test("same-project larger rewrite replaces old requests instead of appending them", async (t) => {
  const { file, repo } = await fixture(t);
  await repo.refresh();
  await fs.writeFile(
    file,
    line(metadata("s", "C:/Projects/Flow")) +
      line(question("교체된 질문 ".repeat(40))),
  );
  await repo.refresh();
  assert.equal(repo.get("s").turns[0].requests.length, 1);
  assert.match(repo.get("s").turns[0].requests[0].text, /^교체된 질문/);
});

test("children sharing a parent session id do not overwrite the main conversation", async (t) => {
  const { dir, repo } = await fixture(t);
  await fs.writeFile(
    path.join(dir, "child.jsonl"),
    line({
      type: "session_meta",
      payload: {
        id: "child",
        session_id: "s",
        parent_thread_id: "s",
        thread_source: "guardian_review",
        cwd: "C:/Projects/Flow",
      },
    }) + line(question("internal child")),
  );
  await repo.refresh();
  assert.deepEqual(
    repo.list().map((s) => s.id),
    ["s"],
  );
  assert.equal(repo.get("s").turns[0].title, "처음 질문");
  assert.equal(repo.get("child").parentThreadId, "s");
});
