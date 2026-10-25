import { test, expect } from "@playwright/test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
async function connect() {
  const client = new Client({ name: "flow-edge-verification", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("server/mcp/stdio.mjs")],
      env: {
        ...process.env,
        VIEWER_DB: process.env.FLOW_E2E_DB!,
        FLOW_MCP_EVIDENCE: path.resolve(
          ".local/e2e/direct-" + randomUUID() + ".json",
        ),
      },
      stderr: "pipe",
    }),
  );
  return client;
}
test.beforeEach(async ({ request }) => {
  await request.put("/api/connection", {
    data: {
      sourceKind: "codex",
      project: path.resolve(".local/e2e"),
      sessionsRoot: path.resolve(".local/e2e"),
    },
  });
});
test("direct setup has no file import, creation and cancellation keep active Codex connection", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const before = await (await request.get("/api/connection")).json();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "ChatGPT 대화", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "ChatGPT 직접 연결" }),
  ).toBeVisible();
  await expect(dialog.locator("input[type=file]")).toHaveCount(0);
  await expect(dialog.getByLabel("프로젝트 폴더", { exact: true })).toHaveCount(
    0,
  );
  await dialog
    .getByLabel("새 프로젝트 이름", { exact: true })
    .fill("Edge 연결 프로젝트");
  await dialog
    .getByRole("button", { name: "프로젝트 만들기", exact: true })
    .click();
  await expect(
    dialog.getByLabel("직접 연결 프로젝트", { exact: true }),
  ).not.toHaveValue("");
  await dialog.getByRole("button", { name: "설정 닫기" }).click();
  expect((await (await request.get("/api/config")).json()).connectionId).toBe(
    before.config.connectionId,
  );
});
test("official MCP received pair appears live with receipt evidence, search, pin/note, reload and Codex return", async ({
  page,
  request,
}) => {
  const client = await connect();
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).not.toBe(true);
      return r.structuredContent as Record<string, any>;
    };
    const p = await call("flow_create_project", {
        name: "실시간 질문 답변",
        requestId: randomUUID(),
      }),
      c = await call("flow_start_conversation", {
        projectId: p.projectId,
        title: "직접 전송한 대화",
        requestId: randomUUID(),
      });
    await page.goto("/");
    await page.getByRole("button", { name: "설정", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "ChatGPT 대화", exact: true })
      .click();
    await dialog
      .getByLabel("직접 연결 프로젝트", { exact: true })
      .selectOption(p.projectId);
    await dialog
      .getByRole("button", { name: "프로젝트 열기", exact: true })
      .click();
    await expect(
      page.getByText("아직 전달받은 질문·답변이 없습니다.", { exact: true }),
    ).toBeVisible();
    const key = randomUUID(),
      args = {
        conversationId: c.conversationId,
        question: "직접 연결 질문",
        answer: "고유 답변 <script>window.directExecuted=true</script>",
        summary: "본문과 분리된 요약",
        requestId: key,
      };
    await call("flow_record", args);
    const region = page.getByRole("region", { name: "질문 진행 타임라인" });
    await expect(region).toContainText("직접 연결 질문", { timeout: 10000 });
    await expect(region).toContainText("고유 답변");
    await region.locator(".overview-entry").click();
    await page.getByRole("tab", { name: /근거 기록/ }).click();
    await expect(page.locator(".detail-body")).toContainText(key);
    await expect(page.locator(".detail-body")).toContainText("MCP 전달");
    await expect(page.locator(".detail-body")).not.toContainText("원본 JSONL");
    await expect(page.locator('.detail-bottom a[href^="codex:"]')).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(() => Reflect.get(window, "directExecuted")),
    ).toBeUndefined();
    await page.getByRole("tab", { name: "요약", exact: true }).click();
    await expect(page.locator(".detail-body")).toContainText(
      "본문과 분리된 요약",
    );
    await page.getByLabel("작업 메모").fill("연결 메모");
    await page.getByRole("button", { name: "메모 저장", exact: true }).click();
    await expect(
      page.getByText("저장했습니다.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "작업 고정", exact: true }).click();
    const id = "mcp:" + c.conversationId;
    await expect
      .poll(
        async () =>
          (
            (
              await (
                await request.get("/api/state/" + encodeURIComponent(id))
              ).json()
            ).pinned || []
          ).length,
      )
      .toBe(1);
    await call("flow_record", args);
    await call("flow_record", {
      conversationId: c.conversationId,
      question: "다음 질문",
      answer: "다음 답변",
      requestId: randomUUID(),
    });
    await expect(region.locator(".overview-entry")).toHaveCount(2, {
      timeout: 10000,
    });
    await expect(page.getByLabel("작업 메모")).toHaveValue("연결 메모");
    await page.getByLabel("기록 검색").fill("고유 답변");
    await expect(region.locator(".overview-entry")).toHaveCount(1);
    await page.getByLabel("기록 검색").fill("");
    await page.reload();
    await expect(page.getByLabel("작업 메모")).toHaveValue("연결 메모");
    await expect(
      page.getByRole("button", { name: "작업 고정 해제", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Codex 프로젝트", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "프로젝트 연결", exact: true })
      .click();
    await expect(page.getByTestId("task-t2:a3")).toBeVisible();
    expect(
      (await (await request.get("/api/state/browser-session")).json()).notes,
    ).toBeDefined();
  } finally {
    await client.close();
  }
});
