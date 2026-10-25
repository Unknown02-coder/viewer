import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".local/e2e");
process.env.FLOW_E2E_RUN ||= String(Date.now());
process.env.FLOW_E2E_DB = path.join(
  root,
  `state-${process.env.FLOW_E2E_RUN}.sqlite`,
);
fs.mkdirSync(root, { recursive: true });
const source = path.join(root, "fixture.jsonl");
const event = (turn: string, type: string, extra = {}) => ({
  type: "event_msg",
  timestamp: "2026-10-24T12:00:00Z",
  payload: { type, turn_id: turn, ...extra },
});
const item = (turn: string, type: string, id: string, extra = {}) =>
  event(turn, "item_completed", { item: { type, id, ...extra } });
const rows = [
  {
    type: "session_meta",
    payload: {
      id: "browser-session",
      cwd: path.join(root, "new-chat"),
      originator: "test fixture",
      cli_version: "fixture",
    },
  },
  event("t1", "task_started"),
  { type: "turn_context", payload: { turn_id: "t1", cwd: root } },
  item("t1", "UserMessage", "q1", { content: "프로젝트 화면 구성해줘" }),
  item("t1", "AgentMessage", "a1", {
    phase: "commentary",
    content: [
      {
        type: "Text",
        text: "입력 화면을 구성하겠습니다. URL 입력과 미리보기를 배치합니다.",
      },
    ],
  }),
  item("t1", "CommandExecution", "c1", {
    status: "completed",
    exit_code: 0,
    command: "npm test",
    aggregated_output: "2 tests passed",
  }),
  item("t1", "AgentMessage", "a2", {
    phase: "commentary",
    content: [
      {
        type: "Text",
        text: "색상 선택을 연결하겠습니다. 선택한 색상을 미리보기에 전달합니다.",
      },
    ],
  }),
  item("t1", "AgentMessage", "f1", {
    phase: "final_answer",
    content: [{ type: "Text", text: "입력 화면 구성을 기록했습니다." }],
  }),
  event("t1", "task_complete"),
  event("t2", "task_started"),
  item("t2", "UserMessage", "q2", { content: "저장하면 배경색이 사라져" }),
  item("t2", "AgentMessage", "a3", {
    phase: "commentary",
    content: [
      {
        type: "Text",
        text: "PNG 저장 오류를 수정하겠습니다. 선택한 배경색을 저장 함수에 전달합니다.",
      },
    ],
  }),
  item("t2", "FileChange", "patch", {
    status: "completed",
    changes: {
      [path.join(root, "tests/export.test.ts")]: {
        type: "add",
        content:
          'test("background", () => {\n  expect(color).toBe("purple");\n});\n',
      },
      [path.join(root, "src/export.ts")]: {
        type: "update",
        unified_diff:
          "@@ -1 +1 @@\n-background: undefined\n+background: selectedColor\n",
      },
      [path.join(root, "src/Preview.tsx")]: {
        type: "update",
        unified_diff: "@@ -1 +1 @@\n-exportImage()\n+exportImage(background)\n",
      },
    },
  }),
  item("t2", "AgentMessage", "f2", {
    phase: "final_answer",
    content: [
      {
        type: "Text",
        text: `[미리보기](${root.replaceAll("\\", "/")}/preview.png)`,
      },
    ],
  }),
];
fs.writeFileSync(source, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
fs.writeFileSync(
  path.join(root, "second.jsonl"),
  [
    { type: "session_meta", payload: { id: "second-session", cwd: root } },
    item("other-turn", "UserMessage", "other-q", { content: "별도 대화" }),
    item("other-turn", "AgentMessage", "other-a", {
      phase: "commentary",
      content: [{ type: "Text", text: "분리된 작업 설명" }],
    }),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);
export default defineConfig({
  testDir: "./tests",
  testMatch: [
    "viewer.spec.ts",
    "state-recovery.spec.ts",
    "interaction.spec.ts",
    "layout.spec.ts",
    "project-connect.spec.ts",
    "navigation.spec.ts",
    "overview.spec.ts",
    "connection-reliability.spec.ts",
    "record-source-settings.spec.ts",
    "mcp-direct.spec.ts",
  ],
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4320",
    channel: "msedge",
    headless: true,
    viewport: { width: 1728, height: 1140 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node server/start.mjs --dev",
    url: "http://127.0.0.1:4320/api/config",
    reuseExistingServer: false,
    env: {
      VIEWER_PORT: "4320",
      VIEWER_PROJECT: root,
      VIEWER_SESSIONS: root,
      VIEWER_DB: process.env.FLOW_E2E_DB,
      VIEWER_IMPORTS: path.join(root, `imports-${Date.now()}`),
    },
  },
});
