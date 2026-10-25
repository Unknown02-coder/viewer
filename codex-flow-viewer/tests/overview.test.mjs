import test from "node:test";
import assert from "node:assert/strict";
import { overviewRows } from "../src/overview.ts";

const turn = (id, extra = {}) => ({
  id,
  title: "질문 " + id,
  requests: [{ id: "q" + id, text: "요청", line: 1 }],
  tasks: [],
  plans: [],
  artifacts: [],
  result: "",
  status: "unknown",
  evidenceIds: [],
  ...extra,
});
const file = (path) => ({ path, relativePath: path });
const task = (id, text, files = []) => ({
  id,
  text,
  title: text,
  files,
  status: "completed",
  evidenceIds: [],
});

test("overview uses actual answer excerpts and distinct confirmed files, excluding linked artifacts", () => {
  const rows = overviewRows([
    turn("a", {
      result: "**기록된 답변**입니다.\n원본 내용",
      tasks: [
        task("a1", "다른 설명", [file("C:/Project/a.ts")]),
        task("a2", "설명", [file("c:\\project\\a.ts")]),
      ],
      artifacts: [{ path: "preview.png" }],
    }),
  ]);
  assert.equal(rows[0].excerpt, "기록된 답변입니다. 원본 내용");
  assert.equal(rows[0].excerptLabel, "답변 발췌");
  assert.equal(rows[0].fileCount, 1);
});

test("missing answers remain labelled explanations, plans or missing records, never invented results", () => {
  const rows = overviewRows(
    [
      turn("a", {
        tasks: [task("a1", "앞선 설명"), task("a2", "가장 최근 설명")],
      }),
      turn("b", { plans: [{ text: "기록된 계획" }] }),
      turn("c"),
    ],
    new Set(),
    false,
    [
      { id: "a1", kind: "message", text: "앞선 설명" },
      { id: "a2", kind: "message", text: "가장 최근 설명" },
    ],
  );
  assert.equal(rows[0].excerpt, "가장 최근 설명");
  assert.equal(rows[0].excerptLabel, "작업 설명 발췌");
  assert.equal(rows[1].excerpt, "기록된 계획");
  assert.equal(rows[1].excerptLabel, "계획 발췌");
  assert.equal(rows[2].excerpt, "");
  assert.equal(rows[2].excerptLabel, "답변 기록 없음");
});

test("task matches preserve question context and original request numbering without fabricating requestless turns", () => {
  const turns = [
    turn("empty", { requests: [] }),
    turn("a"),
    turn("b", { tasks: [task("b1", "찾는 설명")] }),
    turn("c"),
  ];
  const rows = overviewRows(turns, new Set(["b1"]), true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turn.id, "b");
  assert.equal(rows[0].number, 2);
  assert.deepEqual(overviewRows(turns, new Set(), true), []);
});

test("an execution grouping placeholder without message evidence cannot be presented as an original excerpt", () => {
  const rows = overviewRows([
    turn("a", {
      tasks: [
        task(
          "a:execution",
          "연결할 진행 설명이 없어 실행 기록을 시간순으로 묶었습니다.",
        ),
      ],
      plans: [{ text: "실제 계획" }],
    }),
  ]);
  assert.equal(rows[0].excerpt, "실제 계획");
  assert.equal(rows[0].excerptLabel, "계획 발췌");
});
