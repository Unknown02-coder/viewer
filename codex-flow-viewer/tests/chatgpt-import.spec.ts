import { test, expect } from "@playwright/test";
import { snapshot, bytes } from "./helpers/chatgpt.mjs";
import path from "node:path";

test.beforeEach(async ({ request }) => {
  await request.put("/api/connection", {
    data: {
      sourceKind: "codex",
      project: path.resolve(".local/e2e"),
      sessionsRoot: path.resolve(".local/e2e"),
    },
  });
});
test("upload, explicit source selection, excerpts, original references, search, pin and note survive reload and duplicate/failed import", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "ChatGPT 대화", exact: true })
    .click();
  const bundle = snapshot({
    threadId: "browser-chat",
    title: "브라우저 가져오기 대화",
    text: "고유한 답변 발췌 <script>window.importExecuted=true</script>",
    truncated: true,
  });
  await dialog
    .getByLabel("ChatGPT 사본 파일")
    .setInputFiles({
      name: "capture.cflow.json",
      mimeType: "application/json",
      buffer: bytes(bundle),
    });
  await expect(dialog.getByRole("status")).toContainText("일부 가져왔습니다");
  expect((await (await request.get("/api/config")).json()).sourceKind).toBe(
    "codex",
  );
  await dialog.getByRole("button", { name: "대화 열기", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "한눈에 보기", exact: true }),
  ).toBeVisible();
  const timeline = page.getByRole("region", { name: "질문 진행 타임라인" });
  await expect(timeline).toContainText("질문 원문을 보여줘");
  await expect(timeline).toContainText("고유한 답변 발췌");
  await expect(page.getByTestId("chatgpt-coverage")).toContainText(
    "잘린 메시지 1개",
  );
  await timeline.getByRole("button").first().click();
  await page.getByRole("tab", { name: /근거 기록/ }).click();
  await expect(page.locator(".evidence-card").first()).toContainText(
    "페이지 1",
  );
  await expect(page.locator(".detail-body")).toContainText("question-one");
  await expect(
    page.getByRole("link", { name: "보존한 원문 사본 내려받기" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, "importExecuted")),
  ).toBeUndefined();
  await page.getByRole("tab", { name: "요약", exact: true }).click();
  await page.getByLabel("작업 메모").fill("가져온 대화 기억");
  await page.getByRole("button", { name: "메모 저장", exact: true }).click();
  await expect(page.getByText("저장했습니다.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "작업 고정", exact: true }).click();
  const active = await (await request.get("/api/connection")).json();
  await expect
    .poll(
      async () =>
        (
          (
            await (
              await request.get(
                "/api/state/" + encodeURIComponent(active.sessions[0].id),
              )
            ).json()
          ).pinned || []
        ).length,
    )
    .toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "한눈에 보기", exact: true }).click();
  await expect(page.getByLabel("작업 메모")).toHaveValue("가져온 대화 기억");
  await expect(
    page.getByRole("button", { name: "작업 고정 해제", exact: true }),
  ).toBeVisible();
  await page.getByLabel("기록 검색").fill("고유한 답변");
  await expect(timeline.locator(".overview-entry")).toHaveCount(1);
  await page.getByLabel("기록 검색").fill("없는단어");
  await expect(timeline.locator(".overview-entry")).toHaveCount(0);
  await page.getByLabel("기록 검색").fill("");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await dialog
    .getByLabel("ChatGPT 사본 파일")
    .setInputFiles({
      name: "repeat.json",
      mimeType: "application/json",
      buffer: bytes(bundle),
    });
  await expect(dialog.getByRole("status")).toContainText("내용이 같아");
  await dialog
    .getByLabel("ChatGPT 사본 파일")
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from("{bad"),
    });
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "설정 닫기" }).click();
  await expect(page.getByLabel("작업 메모")).toHaveValue("가져온 대화 기억");
  await expect(
    page.getByRole("button", { name: "작업 고정 해제", exact: true }),
  ).toBeVisible();
});

test("source preview and cancellation preserve Codex connection and errors do not leak between sources", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const before = await (await request.get("/api/connection")).json();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("프로젝트 폴더", { exact: true })
    .fill("C:\\missing-project-for-import-test");
  await dialog
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog
    .getByRole("button", { name: "ChatGPT 대화", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByLabel("프로젝트 폴더", { exact: true })).toHaveCount(
    0,
  );
  await dialog.getByRole("button", { name: "설정 닫기" }).click();
  expect((await (await request.get("/api/config")).json()).connectionId).toBe(
    before.config.connectionId,
  );
});

test("same-title originals keep separate preferences and switching sources preserves saved Codex and ChatGPT state", async ({
  page,
  request,
}) => {
  const root = path.resolve(".local/e2e");
  const codexNote = {
    notes: { "t2:a3": "Codex 원래 메모" },
    pinned: ["t2:a3"],
    selected: "t2:a3",
    expanded: ["t2"],
  };
  await request.put("/api/state/browser-session", { data: codexNote });
  const a = await (
    await request.post("/api/chatgpt/imports", {
      data: bytes(
        snapshot({
          threadId: "same-name-a",
          title: "같은 제목",
          text: "첫 대화 답변",
        }),
      ),
      headers: { "Content-Type": "application/json" },
    })
  ).json();
  const b = await (
    await request.post("/api/chatgpt/imports", {
      data: bytes(
        snapshot({
          threadId: "same-name-b",
          title: "같은 제목",
          text: "둘째 대화 답변",
        }),
      ),
      headers: { "Content-Type": "application/json" },
    })
  ).json();
  await page.goto("/");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "ChatGPT 대화", exact: true })
    .click();
  await dialog.getByLabel("저장된 대화", { exact: true }).selectOption(a.id);
  await dialog.getByRole("button", { name: "대화 열기", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "질문 진행 타임라인" }),
  ).toContainText("첫 대화 답변");
  await page.getByLabel("작업 메모").fill("첫 대화에만 저장");
  await page.getByRole("button", { name: "메모 저장", exact: true }).click();
  await expect(page.getByText("저장했습니다.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await dialog.getByLabel("저장된 대화", { exact: true }).selectOption(b.id);
  await dialog.getByRole("button", { name: "대화 열기", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "질문 진행 타임라인" }),
  ).toContainText("둘째 대화 답변");
  await expect(page.getByLabel("작업 메모")).toHaveValue("");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Codex 프로젝트", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  expect((await (await request.get("/api/config")).json()).project).toBe(root);
  await page.getByRole("tab", { name: "요약", exact: true }).click();
  await expect(page.getByLabel("작업 메모")).toHaveValue("Codex 원래 메모");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await dialog
    .getByRole("button", { name: "ChatGPT 대화", exact: true })
    .click();
  await dialog.getByLabel("저장된 대화", { exact: true }).selectOption(a.id);
  await dialog.getByRole("button", { name: "대화 열기", exact: true }).click();
  await expect(page.getByLabel("작업 메모")).toHaveValue("첫 대화에만 저장");
});
