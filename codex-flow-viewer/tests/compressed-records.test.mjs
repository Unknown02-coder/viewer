import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { SessionRepository } from "../server/repository.mjs";

const content = (project, text = "블록체인 질문", id = "compressed-thread") =>
  Buffer.from(
    [
      {
        type: "session_meta",
        payload: { id, cwd: "C:/new-chat", thread_source: "user" },
      },
      { type: "turn_context", payload: { turn_id: "t", cwd: project } },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "t",
          item: { id: "q", type: "UserMessage", content: text },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "t",
          item: {
            id: "a",
            type: "AgentMessage",
            phase: "commentary",
            content: [{ type: "Text", text: "질문의 실행 근거를 읽습니다." }],
          },
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-zstd-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "thread.jsonl.zst");
  const bytes = zstdCompressSync(content(dir));
  await fs.writeFile(file, bytes);
  return {
    dir,
    file,
    bytes,
    repo: new SessionRepository({ project: dir, sessionsRoot: dir }),
  };
}

test("compressed JSONL is discovered by exact latest project with original lines and unchanged source bytes", async (t) => {
  const { dir, file, bytes, repo } = await fixture(t);
  await fs.writeFile(
    path.join(dir, "foreign.jsonl.zst"),
    zstdCompressSync(content(dir + "-other", "다른 프로젝트", "foreign")),
  );
  await repo.refresh();
  assert.deepEqual(
    repo.list().map((s) => s.id),
    ["compressed-thread"],
  );
  const session = repo.get("compressed-thread");
  assert.equal(session.turns[0].title, "블록체인 질문");
  assert.equal(session.turns[0].tasks.length, 1);
  assert.equal(session.sourcePath, file);
  assert.equal(session.turns[0].requests[0].line, 3);
  assert.equal(session.evidence[0].sourcePath, file);
  await repo.refresh();
  assert.equal(repo.get("compressed-thread").turns[0].tasks.length, 1);
  assert.deepEqual(await fs.readFile(file), bytes);
});

test("a compressed file can be configured directly and a changed snapshot is rebuilt", async (t) => {
  const { dir, file, repo } = await fixture(t);
  await repo.configure({ project: dir, sessionsRoot: file });
  assert.equal(repo.list().length, 1);
  await fs.writeFile(file, zstdCompressSync(content(dir, "새 스냅샷")));
  await repo.refresh();
  assert.equal(repo.get("compressed-thread").turns[0].title, "새 스냅샷");
});

test("plain-to-compressed migration and resuming plain logs cannot remove or duplicate a conversation", async (t) => {
  const { dir, file, repo } = await fixture(t);
  const plain = file.slice(0, -4);
  await fs.writeFile(plain, content(dir, "더 최신 활성 대화"));
  await repo.refresh();
  assert.equal(repo.list().length, 1);
  assert.equal(
    repo.get("compressed-thread").turns[0].title,
    "더 최신 활성 대화",
  );
  await fs.unlink(plain);
  await repo.refresh();
  assert.equal(repo.list().length, 1);
  assert.equal(repo.get("compressed-thread").sourcePath, file);
  await fs.writeFile(plain, content(dir, "다시 시작한 대화"));
  await repo.refresh();
  assert.equal(repo.list().length, 1);
  assert.equal(
    repo.get("compressed-thread").turns[0].title,
    "다시 시작한 대화",
  );
  await fs.unlink(file);
  await repo.refresh();
  assert.equal(repo.list().length, 1);
});

test("a damaged compressed record reports a read error and is retried after it is completed", async (t) => {
  const { file, bytes, repo } = await fixture(t);
  await fs.writeFile(file, Buffer.from("not a zstd record"));
  await repo.refresh();
  assert.equal(repo.list().length, 0);
  assert.match(repo.error, /일부 기록/);
  await fs.writeFile(file, bytes);
  await repo.refresh();
  assert.equal(repo.error, null);
  assert.equal(repo.list().length, 1);
});

test("an active thread moved to another project excludes its older compressed snapshot from the old project", async (t) => {
  const { dir, file, repo } = await fixture(t);
  await repo.refresh();
  await fs.writeFile(file.slice(0, -4), content(dir + "-other", "이동한 대화"));
  await repo.refresh();
  assert.equal(repo.list().length, 0);
});

test("a resumed plain source containing only metadata cannot erase the same-project archive history", async (t) => {
  const { dir, file, repo } = await fixture(t);
  await repo.refresh();
  const plain = file.slice(0, -4);
  await fs.writeFile(
    plain,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "compressed-thread", cwd: dir },
    }) + "\n",
  );
  await repo.refresh();
  assert.equal(repo.list()[0].turnCount, 1);
  assert.equal(repo.get("compressed-thread").sourcePath, file);
  await fs.writeFile(plain, content(dir, "복원된 활성 대화"));
  await repo.refresh();
  assert.equal(
    repo.get("compressed-thread").turns[0].title,
    "복원된 활성 대화",
  );
});

test("a cached archive read failure and recovery publish health changes even when content is unchanged", async (t) => {
  const { file, bytes, repo } = await fixture(t);
  await repo.refresh();
  const events = [];
  repo.on("change", (e) => events.push(e));
  await fs.writeFile(file, Buffer.from("broken zstd"));
  await repo.refresh();
  assert.equal(events.length, 1);
  assert.match(events[0].error, /일부 기록/);
  assert.equal(repo.get("compressed-thread").turns[0].title, "블록체인 질문");
  await repo.refresh();
  assert.equal(events.length, 1);
  await fs.writeFile(file, bytes);
  await repo.refresh();
  assert.equal(events.at(-1).error, null);
});

test("partial plain restoration preserves every archived request and task until coverage is complete", async (t) => {
  const { dir, file, repo } = await fixture(t);
  const original = Buffer.concat([
    content(dir),
    Buffer.from(
      [
        { type: "turn_context", payload: { turn_id: "t2", cwd: dir } },
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: "t2",
            item: { id: "q2", type: "UserMessage", content: "두 번째 질문" },
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: "t2",
            item: {
              id: "a2",
              type: "AgentMessage",
              phase: "commentary",
              content: [{ type: "Text", text: "두 번째 작업 설명" }],
            },
          },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    ),
  ]);
  await fs.writeFile(file, zstdCompressSync(original));
  await repo.refresh();
  const plain = file.slice(0, -4);
  await fs.writeFile(
    plain,
    content(dir).toString("utf8").split("\n").slice(0, 3).join("\n") + "\n",
  );
  await repo.refresh();
  assert.equal(repo.list()[0].turnCount, 2);
  assert.equal(repo.list()[0].taskCount, 2);
  await fs.writeFile(plain, content(dir));
  await repo.refresh();
  assert.equal(repo.list()[0].turnCount, 2);
  await fs.writeFile(plain, original);
  await repo.refresh();
  assert.equal(repo.list()[0].turnCount, 2);
  assert.equal(repo.get("compressed-thread").sourcePath, plain);
});

test("source-prefix continuity retains completed command and turn records during restoration", async (t) => {
  const { dir, file, repo } = await fixture(t);
  const base = content(dir).toString("utf8").trim().split("\n").map(JSON.parse);
  const command = {
    id: "command",
    type: "CommandExecution",
    command: "example only",
  };
  const rows = [
    ...base.slice(0, 2),
    { type: "event_msg", payload: { type: "task_started", turn_id: "t" } },
    base[2],
    {
      type: "event_msg",
      payload: {
        type: "item_started",
        turn_id: "t",
        item: { ...command, status: "running" },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "t",
        item: {
          ...command,
          status: "completed",
          exit_code: 0,
          aggregated_output: "recorded result",
        },
      },
    },
    base[3],
    { type: "event_msg", payload: { type: "task_complete", turn_id: "t" } },
  ];
  const encode = (values) =>
    Buffer.from(values.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await fs.writeFile(file, zstdCompressSync(encode(rows)));
  await repo.refresh();
  const plain = file.slice(0, -4);
  for (const prefix of [rows.slice(0, 5), rows.slice(0, -1)]) {
    await fs.writeFile(plain, encode(prefix));
    await repo.refresh();
    const session = repo.get("compressed-thread");
    assert.equal(session.sourcePath, file);
    assert.equal(session.turns[0].status, "completed");
    assert.equal(
      session.evidence.find((e) => e.kind === "command").exitCode,
      0,
    );
  }
  await fs.writeFile(plain, encode(rows));
  await repo.refresh();
  assert.equal(repo.get("compressed-thread").sourcePath, plain);
});
