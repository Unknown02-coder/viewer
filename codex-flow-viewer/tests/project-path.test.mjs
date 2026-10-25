import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalProject, normalizeRecords } from "../server/model.mjs";
import { SessionRepository } from "../server/repository.mjs";

const meta = (cwd) => ({
  type: "session_meta",
  payload: { id: "moved-thread", cwd, thread_source: "user" },
});
const context = (cwd) => ({
  type: "turn_context",
  payload: { turn_id: "t", cwd },
});
const question = {
  type: "event_msg",
  payload: {
    type: "item_completed",
    turn_id: "t",
    item: { id: "q", type: "UserMessage", content: "기존 대화" },
  },
};
const encode = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const records = (rows) => rows.map((row, i) => ({ row, line: i + 1 }));

test("a moved conversation uses its latest recorded work path and keeps its creation path separately", () => {
  const session = normalizeRecords(
    records([
      meta("C:/new-chat"),
      context("C:/new-chat"),
      question,
      context("C:/Projects/gitops"),
    ]),
    "source.jsonl",
  );
  assert.equal(session.project, "C:/Projects/gitops");
  assert.equal(session.creationProject, "C:/new-chat");
  assert.equal(session.turns[0].requests[0].text, "기존 대화");
});

test("Windows extended paths match ordinary paths while distinct worktrees stay distinct", () => {
  assert.equal(
    canonicalProject("\\\\?\\C:\\Projects\\gitops"),
    canonicalProject("c:/projects/gitops"),
  );
  assert.equal(
    canonicalProject("\\\\?\\UNC\\server\\share\\project"),
    canonicalProject("\\\\server\\share\\project"),
  );
  assert.notEqual(
    canonicalProject("\\\\?\\C:\\Projects\\gitops-worktree"),
    canonicalProject("C:/Projects/gitops"),
  );
});

test("file paths remain relative when current project has an extended path prefix", () => {
  const session = normalizeRecords(
    records([
      meta("C:/new-chat"),
      context("\\\\?\\C:\\Projects\\gitops"),
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "t",
          item: {
            type: "FileChange",
            id: "patch",
            status: "completed",
            changes: {
              "C:/Projects/gitops/a.txt": { type: "add", content: "ok" },
            },
          },
        },
      },
    ]),
    "source.jsonl",
  );
  assert.equal(session.evidence[0].files[0].relativePath, "a.txt");
});

async function setup(t, initial) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-project-move-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "thread.jsonl");
  await fs.writeFile(source, encode(initial));
  return { dir, source };
}

test("discovery finds a conversation created elsewhere using its latest cwd, without rewriting source", async (t) => {
  const current = "C:/Projects/gitops";
  const { dir, source } = await setup(t, [
    meta("C:/new-chat"),
    context(current),
    question,
  ]);
  const before = await fs.readFile(source);
  const repo = new SessionRepository({ sessionsRoot: dir, project: current });
  await repo.refresh();
  assert.equal(repo.list()[0].id, "moved-thread");
  assert.equal(repo.get("moved-thread").project, current);
  const oldRepo = new SessionRepository({
    sessionsRoot: dir,
    project: "C:/new-chat",
  });
  await oldRepo.refresh();
  assert.equal(oldRepo.list().length, 0);
  assert.deepEqual(await fs.readFile(source), before);
});

test("an excluded conversation appears after its next turn records the selected project", async (t) => {
  const { dir, source } = await setup(t, [meta("C:/new-chat"), question]);
  const repo = new SessionRepository({
    sessionsRoot: dir,
    project: "C:/Projects/gitops",
  });
  await repo.refresh();
  assert.equal(repo.list().length, 0);
  await fs.appendFile(source, encode([context("C:/Projects/gitops")]));
  await repo.refresh();
  assert.equal(repo.list()[0].id, "moved-thread");
});

test("a thread moved away is no longer listed under the original project", async (t) => {
  const { dir, source } = await setup(t, [
    meta("C:/Projects/gitops"),
    question,
  ]);
  const repo = new SessionRepository({
    sessionsRoot: dir,
    project: "C:/Projects/gitops",
  });
  await repo.refresh();
  assert.equal(repo.list().length, 1);
  await fs.appendFile(source, encode([context("C:/Projects/other")]));
  await repo.refresh();
  assert.equal(repo.list().length, 0);
});
