import test from "node:test";
import assert from "node:assert/strict";
import { JsonlDecoder } from "../server/records.mjs";
import { normalizeRecords, canonicalProject } from "../server/model.mjs";

const project = "C:\\Projects\\Flow";
const meta = {
  type: "session_meta",
  payload: {
    id: "session-1",
    cwd: project,
    cli_version: "sample",
    originator: "Codex Desktop",
  },
};
const ev = (type, extra = {}) => ({
  type: "event_msg",
  timestamp: "2026-10-24T12:00:00Z",
  payload: { type, turn_id: "turn-1", ...extra },
});
const item = (type, id, extra = {}) =>
  ev("item_completed", { item: { type, id, ...extra } });
const records = (rows) => rows.map((row, i) => ({ row, line: i + 1 }));
const parse = (rows) =>
  normalizeRecords(records([meta, ...rows]), "C:/records/sample.jsonl");

test("Text and text blocks recover the actual question and assistant explanation", () => {
  const s = parse([
    ev("task_started"),
    item("UserMessage", "q", {
      content: [{ type: "text", text: "배경색을 고쳐줘" }],
    }),
    item("AgentMessage", "a", {
      phase: "commentary",
      content: [
        { type: "Text", text: "선택한 배경색을 저장 함수에 연결하겠습니다." },
      ],
    }),
    item("AgentMessage", "f", {
      phase: "final_answer",
      content: [{ type: "Text", text: "수정 내용을 기록했습니다." }],
    }),
    ev("task_complete"),
  ]);
  assert.equal(s.turns[0].requests[0].text, "배경색을 고쳐줘");
  assert.equal(
    s.turns[0].tasks[0].text,
    "선택한 배경색을 저장 함수에 연결하겠습니다.",
  );
  assert.equal(s.turns[0].result, "수정 내용을 기록했습니다.");
  assert.equal(s.turns[0].status, "completed");
  assert.equal(s.turns[0].tasks[0].verification, "none");
  assert.equal(s.evidence.find((e) => e.id.endsWith(":a")).line, 4);
});

test("a missing completion remains running; a successful command is not feature verification", () => {
  const s = parse([
    ev("task_started"),
    item("UserMessage", "q", { content: [{ type: "text", text: "실행해줘" }] }),
    item("CommandExecution", "cmd", {
      status: "completed",
      exit_code: 0,
      command: "npm test",
      aggregated_output: "ok",
    }),
  ]);
  assert.equal(s.turns[0].status, "running");
  assert.equal(s.turns[0].tasks[0].verification, "none");
  assert.equal(s.evidence.find((e) => e.kind === "command").exitCode, 0);
});

test("only successful structured file changes are counted; links remain artifacts", () => {
  const s = parse([
    ev("task_started"),
    item("AgentMessage", "a", {
      phase: "commentary",
      content: [{ type: "Text", text: "파일을 수정합니다." }],
    }),
    item("FileChange", "patch", {
      status: "completed",
      changes: {
        "C:/Projects/Flow/src/app.ts": {
          type: "update",
          unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
        },
      },
    }),
    item("FileChange", "failed", {
      status: "failed",
      changes: {
        "C:/Projects/Flow/missing.ts": { type: "add", content: "not created" },
      },
    }),
    item("AgentMessage", "f", {
      phase: "final_answer",
      content: [{ type: "Text", text: "[그림](C:/Projects/Flow/output.png)" }],
    }),
    ev("task_complete"),
  ]);
  const files = s.turns[0].tasks.flatMap((t) => t.files);
  assert.equal(files.length, 1);
  assert.equal(files[0].relativePath, "src/app.ts");
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  assert.equal(s.turns[0].artifacts[0].path, "C:/Projects/Flow/output.png");
  assert.equal(s.turns[0].artifacts[0].kind, "linked");
  assert.ok(s.evidence.some((e) => e.kind === "file" && e.status === "failed"));
});

test("replaying the same records cannot duplicate tasks, requests or changes", () => {
  const rows = records([
    meta,
    ev("task_started"),
    item("UserMessage", "q", { content: "질문" }),
    item("AgentMessage", "a", {
      phase: "commentary",
      content: [{ type: "Text", text: "설명" }],
    }),
    ev("task_complete"),
  ]);
  const s = normalizeRecords([...rows, ...rows], "sample.jsonl");
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].requests.length, 1);
  assert.equal(s.turns[0].tasks.length, 1);
  assert.equal(s.turns[0].status, "completed");
});

test("decoder preserves a UTF-8 character and unfinished JSON across byte chunks", () => {
  const decoder = new JsonlDecoder();
  const data = Buffer.from('{"text":"한글"}\n{"next":true}\n');
  const cut = data.indexOf(Buffer.from("한")) + 1;
  assert.deepEqual(decoder.push(data.subarray(0, cut)), []);
  const rows = decoder.push(data.subarray(cut, data.length - 2));
  assert.equal(rows[0].row.text, "한글");
  assert.ok(decoder.pendingBytes > 0);
  assert.equal(decoder.push(data.subarray(data.length - 2))[0].row.next, true);
  assert.equal(decoder.pendingBytes, 0);
});

test("invalid complete lines are reported without losing later valid rows", () => {
  const d = new JsonlDecoder();
  const rows = d.push(Buffer.from('bad\n{"ok":1}\n'));
  assert.equal(rows[0].line, 2);
  assert.equal(rows[0].row.ok, 1);
  assert.deepEqual(d.invalidLines, [1]);
});

test("Windows project matching normalizes case and separators, but does not merge worktrees", () => {
  assert.equal(
    canonicalProject("C:\\Projects\\Flow\\"),
    canonicalProject("c:/projects/flow"),
  );
  assert.notEqual(
    canonicalProject("C:/Projects/Flow"),
    canonicalProject("C:/Projects/Flow-worktree"),
  );
});

test("explicit interruption is kept and empty descriptions are not invented", () => {
  const s = parse([
    ev("task_started"),
    item("UserMessage", "q", { content: "멈춰" }),
    item("AgentMessage", "empty", { phase: "commentary", content: [] }),
    ev("turn_aborted"),
  ]);
  assert.equal(s.turns[0].status, "interrupted");
  assert.equal(s.turns[0].tasks.length, 0);
});

test("unique thread id takes precedence over a shared parent session id", () => {
  const s = normalizeRecords(
    records([
      {
        type: "session_meta",
        payload: {
          id: "child",
          session_id: "parent",
          parent_thread_id: "parent",
          cwd: project,
          thread_source: "guardian_review",
        },
      },
    ]),
    "child.jsonl",
  );
  assert.equal(s.id, "child");
  assert.equal(s.parentThreadId, "parent");
  assert.equal(s.threadSource, "guardian_review");
});

test("explicit proposed plans remain separate and explanation-only records are not completed work", () => {
  const s = parse([
    ev("task_started"),
    item("AgentMessage", "a", {
      phase: "commentary",
      content: [
        {
          type: "Text",
          text: "<proposed_plan>다음에는 배포합니다.</proposed_plan>",
        },
      ],
    }),
    item("AgentMessage", "b", {
      phase: "commentary",
      content: [{ type: "Text", text: "관련 내용을 설명했습니다." }],
    }),
    ev("task_complete"),
  ]);
  assert.equal(s.turns[0].plans.length, 1);
  assert.equal(s.turns[0].tasks.length, 1);
  assert.equal(s.turns[0].tasks[0].kind, "description");
  assert.equal(s.turns[0].tasks[0].status, "unknown");
});

test("a final-only proposed plan cannot create an executed task", () => {
  const s = parse([
    ev("task_started"),
    item("AgentMessage", "f", {
      phase: "final_answer",
      content: [
        {
          type: "Text",
          text: "<proposed_plan>파일을 나중에 만듭니다.</proposed_plan>",
        },
      ],
    }),
    ev("task_complete"),
  ]);
  assert.equal(s.turns[0].plans.length, 1);
  assert.equal(s.turns[0].tasks.length, 0);
});

test("a failed patch keeps attempted paths and diff as evidence while confirming no file changes", () => {
  const s = parse([
    item("FileChange", "failed", {
      status: "failed",
      changes: {
        "C:/Projects/Flow/app.ts": {
          type: "update",
          unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
        },
      },
    }),
  ]);
  assert.equal(s.turns[0].tasks[0].files.length, 0);
  assert.equal(s.evidence[0].attemptedFiles[0].relativePath, "app.ts");
  assert.ok(s.evidence[0].attemptedFiles[0].diff.includes("-old"));
});
