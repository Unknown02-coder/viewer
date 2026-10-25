import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { SessionRepository } from "../server/repository.mjs";

const encode = (project, id) =>
  Buffer.from(
    [
      {
        type: "session_meta",
        payload: { id, cwd: project, thread_source: "user" },
      },
      { type: "turn_context", payload: { cwd: project, turn_id: "t" } },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "t",
          item: { type: "UserMessage", id: "q", content: id + " 질문" },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-connect-"));
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const projectA = path.join(dir, "프로젝트 A"),
    projectB = path.join(dir, "프로젝트 B");
  const sourceA = path.join(dir, "records-a"),
    sourceB = path.join(dir, "records-b");
  await Promise.all(
    [projectA, projectB, sourceA, sourceB].map((p) => fs.mkdir(p)),
  );
  await fs.writeFile(path.join(sourceA, "a.jsonl"), encode(projectA, "a"));
  await fs.writeFile(path.join(sourceB, "b.jsonl"), encode(projectB, "b"));
  const repo = new SessionRepository({
    project: projectA,
    sessionsRoot: sourceA,
  });
  await repo.refresh();
  return { dir, projectA, projectB, sourceA, sourceB, repo };
}

test("quoted and space-padded copied paths connect to the same existing project", async (t) => {
  const { projectA, sourceA, repo } = await setup(t);
  await repo.configure({
    project: '  "' + projectA + '"  ',
    sessionsRoot: " '" + sourceA + "' ",
  });
  assert.deepEqual(
    repo.list().map((s) => s.id),
    ["a"],
  );
  assert.equal(repo.project, projectA);
});

test("Codex home and sessions include archived compressed history without modifying source", async (t) => {
  const { dir, projectA, projectB, repo } = await setup(t);
  const home = path.join(dir, "codex-home"),
    active = path.join(home, "sessions"),
    archived = path.join(home, "archived_sessions");
  await fs.mkdir(active, { recursive: true });
  await fs.mkdir(archived);
  await fs.writeFile(path.join(active, "b.jsonl"), encode(projectB, "b"));
  const file = path.join(archived, "a.jsonl.zst"),
    bytes = zstdCompressSync(encode(projectA, "archived-a"));
  await fs.writeFile(file, bytes);
  for (const root of [home, active, archived]) {
    await repo.configure({ project: projectA, sessionsRoot: root });
    assert.equal(repo.list()[0]?.id, "archived-a");
  }
  assert.deepEqual(await fs.readFile(file), bytes);
});

test("a junction alias matches its real folder while sibling worktrees remain excluded", async (t) => {
  const { dir, projectA, sourceA, repo } = await setup(t);
  const alias = path.join(dir, "alias");
  await fs.symlink(
    projectA,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await fs.writeFile(
    path.join(sourceA, "foreign.jsonl"),
    encode(projectA + "-worktree", "foreign"),
  );
  await repo.configure({ project: alias, sessionsRoot: sourceA });
  assert.deepEqual(
    repo.list().map((s) => s.id),
    ["a"],
  );
});

test("an unreadable replacement source cannot destroy the working connection or commit settings", async (t) => {
  const { projectA, projectB, sourceA, sourceB, repo } = await setup(t);
  const original = fs.readdir;
  let persisted = false;
  t.mock.method(fs, "readdir", async function (p, ...args) {
    if (path.resolve(p) === sourceB)
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original.call(this, p, ...args);
  });
  await assert.rejects(
    repo.configure({ project: projectB, sessionsRoot: sourceB }, () => {
      persisted = true;
    }),
  );
  assert.equal(repo.project, projectA);
  assert.equal(repo.sessionsRoot, sourceA);
  assert.equal(repo.list()[0]?.id, "a");
  assert.equal(persisted, false);
});

test("a settings persistence failure leaves the previous connection and records intact", async (t) => {
  const { projectA, projectB, sourceB, repo } = await setup(t);
  await assert.rejects(
    repo.configure({ project: projectB, sessionsRoot: sourceB }, () => {
      throw new Error("settings unavailable");
    }),
  );
  assert.equal(repo.project, projectA);
  assert.equal(repo.list()[0]?.id, "a");
});

test("overlapping configurations return their own snapshots and finish in request order", async (t) => {
  const { projectA, projectB, sourceA, sourceB, repo } = await setup(t);
  const requests = Array.from({ length: 8 }, (_, i) =>
    i % 2
      ? { project: projectB, sessionsRoot: sourceB }
      : { project: projectA, sessionsRoot: sourceA },
  );
  const results = await Promise.all(
    requests.map((request) => repo.configure(request)),
  );
  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].project, requests[i].project);
    assert.equal(results[i].sessions[0].id, i % 2 ? "b" : "a");
  }
  assert.equal(repo.project, projectB);
  assert.equal(repo.list()[0]?.id, "b");
});

test("a temporary root scan failure keeps last good records and recovers without reconfiguration", async (t) => {
  const { sourceA, repo } = await setup(t);
  const original = fs.readdir;
  const mock = t.mock.method(fs, "readdir", async function (p, ...args) {
    if (path.resolve(p) === sourceA)
      throw Object.assign(new Error("offline"), { code: "EIO" });
    return original.call(this, p, ...args);
  });
  await repo.refresh();
  assert.equal(repo.list()[0]?.id, "a");
  assert.match(repo.error, /기록/);
  mock.mock.restore();
  await repo.refresh();
  assert.equal(repo.list()[0]?.id, "a");
  assert.equal(repo.error, null);
});

test("one unreadable child does not hide healthy records or erase cached records in that child", async (t) => {
  const { projectA, sourceA, repo } = await setup(t);
  const child = path.join(sourceA, "blocked");
  await fs.mkdir(child);
  await fs.writeFile(path.join(child, "c.jsonl"), encode(projectA, "c"));
  await repo.refresh();
  assert.equal(repo.list().length, 2);
  const original = fs.readdir;
  t.mock.method(fs, "readdir", async function (p, ...args) {
    if (path.resolve(p) === child)
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original.call(this, p, ...args);
  });
  await repo.refresh();
  assert.deepEqual(
    repo
      .list()
      .map((s) => s.id)
      .sort(),
    ["a", "c"],
  );
  assert.match(repo.error, /기록/);
});

test("losing the primary sessions root preserves cached sibling archive conversations too", async (t) => {
  const { dir, projectA, repo } = await setup(t);
  const sessions = path.join(dir, "home", "sessions"),
    archive = path.join(dir, "home", "archived_sessions");
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(archive);
  await fs.writeFile(
    path.join(sessions, "a.jsonl"),
    encode(projectA, "active"),
  );
  await fs.writeFile(
    path.join(archive, "b.jsonl"),
    encode(projectA, "archive"),
  );
  await repo.configure({ project: projectA, sessionsRoot: sessions });
  assert.equal(repo.list().length, 2);
  const original = fs.stat;
  const mock = t.mock.method(fs, "stat", async function (p, ...args) {
    if (path.resolve(p) === sessions)
      throw Object.assign(new Error("offline"), { code: "EIO" });
    return original.call(this, p, ...args);
  });
  await repo.refresh();
  assert.deepEqual(
    repo
      .list()
      .map((s) => s.id)
      .sort(),
    ["active", "archive"],
  );
  assert.ok(repo.error);
  mock.mock.restore();
  await repo.refresh();
  assert.equal(repo.list().length, 2);
  assert.equal(repo.error, null);
});

test("a source junction resolves the sessions location and its sibling archive together", async (t) => {
  const { dir, projectA, repo } = await setup(t);
  const sessions = path.join(dir, "source-home", "sessions"),
    archive = path.join(dir, "source-home", "archived_sessions"),
    alias = path.join(dir, "source-alias");
  await fs.mkdir(sessions, { recursive: true });
  await fs.mkdir(archive);
  await fs.writeFile(
    path.join(archive, "a.jsonl"),
    encode(projectA, "archive"),
  );
  await fs.symlink(
    sessions,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await repo.configure({ project: projectA, sessionsRoot: alias });
  assert.equal(repo.list()[0]?.id, "archive");
});

test("replacing a record with preserved size and modification time cannot retain the old project", async (t) => {
  const { projectA, projectB, sourceA, repo } = await setup(t);
  const file = path.join(sourceA, "a.jsonl"),
    replacement = path.join(sourceA, "replacement.pending");
  const stamp = new Date("2026-01-01T00:00:00Z");
  await fs.utimes(file, stamp, stamp);
  await repo.refresh();
  const before = await fs.stat(file);
  await fs.writeFile(replacement, encode(projectB, "b"));
  await fs.utimes(replacement, stamp, stamp);
  await fs.unlink(file);
  await fs.rename(replacement, file);
  const after = await fs.stat(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  await repo.refresh();
  assert.equal(repo.list().length, 0);
  assert.equal(repo.get("a"), undefined);
});

test("a same-project replacement with preserved size and mtime publishes its new revision and question", async (t) => {
  const { projectA, sourceA, repo } = await setup(t),
    file = path.join(sourceA, "a.jsonl"),
    temporary = path.join(sourceA, "new.pending");
  const stamp = new Date("2026-01-01T00:00:00Z");
  await fs.utimes(file, stamp, stamp);
  await repo.refresh();
  const revision = repo.list()[0].revision,
    events = [];
  repo.on("change", (e) => events.push(e));
  await fs.writeFile(
    temporary,
    encode(projectA, "a").toString("utf8").replace("a 질문", "z 질문"),
  );
  await fs.utimes(temporary, stamp, stamp);
  await fs.unlink(file);
  await fs.rename(temporary, file);
  await repo.refresh();
  assert.equal(repo.list()[0].title, "z 질문");
  assert.notEqual(repo.list()[0].revision, revision);
  assert.equal(events.length, 1);
});
