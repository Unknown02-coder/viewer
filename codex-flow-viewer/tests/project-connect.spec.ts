import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

test("reconnecting a project finds a thread created elsewhere and restores its existing memo", async ({
  page,
  request,
}) => {
  const root = path.resolve(".local/e2e");
  const empty = path.join(root, "empty-project");
  await fs.mkdir(empty, { recursive: true });
  await request.put("/api/state/browser-session", {
    data: {
      selected: "t1:a1",
      expanded: ["t1", "t2"],
      pinned: ["t1:a1"],
      notes: { "t1:a1": "연결 확인 메모" },
      titles: {},
      positions: {},
      relations: [],
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByLabel("프로젝트 폴더", { exact: true }).fill(empty);
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "프로젝트 대화" }).getByRole("button"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByLabel("프로젝트 폴더", { exact: true }).fill(root);
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "프로젝트 대화" })
      .getByRole("button", { name: /프로젝트 화면 구성해줘/ }),
  ).toBeVisible();
  await page.getByTestId("task-t1:a1").click();
  await page.getByRole("tab", { name: /요약/ }).click();
  await expect(page.getByLabel("작업 메모")).toHaveValue("연결 확인 메모");
});

test("connecting another project loads its compressed conversation and original source evidence", async ({
  page,
  request,
}) => {
  const root = path.resolve(".local/e2e");
  const project = path.join(root, "school-blockchain");
  const source = path.join(root, "school-blockchain.jsonl.zst");
  await fs.mkdir(project, { recursive: true });
  const rows = [
    {
      type: "session_meta",
      payload: { id: "compressed-school", cwd: project },
    },
    { type: "turn_context", payload: { turn_id: "school-turn", cwd: project } },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "school-turn",
        item: {
          id: "school-q",
          type: "UserMessage",
          content: "학교 블록체인 개념을 정리해줘",
        },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "school-turn",
        item: {
          id: "school-a",
          type: "AgentMessage",
          phase: "commentary",
          content: [
            { type: "Text", text: "합의 알고리즘 학습 순서를 설명합니다." },
          ],
        },
      },
    },
  ];
  await fs.writeFile(
    source,
    zstdCompressSync(
      Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"),
    ),
  );
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("프로젝트 폴더", { exact: true }).fill(project);
    await page.getByLabel(/Codex 기록 폴더/).fill(source);
    await page
      .getByRole("button", { name: "프로젝트 연결", exact: true })
      .click();
    await expect(
      page
        .getByRole("navigation", { name: "프로젝트 대화" })
        .getByRole("button", { name: /학교 블록체인 개념/ }),
    ).toBeVisible();
    expect((await (await request.get("/api/config")).json()).mode).toBe(
      "import",
    );
    await page.getByTestId("task-school-turn:school-a").click();
    await page.getByRole("tab", { name: /근거 기록/ }).click();
    await expect(
      page.getByText(/school-blockchain\.jsonl\.zst/).first(),
    ).toBeVisible();
    await expect(
      page
        .getByText("합의 알고리즘 학습 순서를 설명합니다.", { exact: true })
        .last(),
    ).toBeVisible();
    const original = await fs.readFile(source);
    await fs.writeFile(source, Buffer.from("broken zstd"));
    await expect(page.locator(".warning-banner")).toContainText(
      "일부 기록을 읽지 못했습니다",
      { timeout: 8000 },
    );
    await expect(page.locator(".warning-banner")).toContainText(
      "마지막으로 읽은 기록",
    );
    await expect(page.getByTestId("task-school-turn:school-a")).toBeVisible();
    await fs.writeFile(source, original);
    await expect(page.locator(".warning-banner")).toHaveCount(0, {
      timeout: 8000,
    });
  } finally {
    await request.put("/api/config", {
      data: { project: root, sessionsRoot: root },
    });
    await fs.unlink(source);
  }
});
