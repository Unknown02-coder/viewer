import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

test.describe.configure({ mode: "serial" });

test("shows real questions, explanations, changed files, linked artifacts and source lines", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("프로젝트 화면 구성해줘", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("저장하면 배경색이 사라져", { exact: true }).first(),
  ).toBeVisible();
  await page.getByTestId("task-t2:a3").click();
  await page.getByRole("tab", { name: /변경 파일/ }).click();
  await expect(page.getByText("export.test.ts", { exact: true })).toBeVisible();
  await expect(page.getByText("src/export.ts", { exact: true })).toBeVisible();
  await expect(page.getByText("연결된 결과물", { exact: true })).toBeVisible();
  await expect(page.getByText("preview.png", { exact: true })).toBeVisible();
  await expect(page.getByText("생성 1", { exact: true })).toBeVisible();
  await expect(page.getByText("수정 2", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /근거 기록/ }).click();
  await expect(
    page.getByText("원본 JSONL", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("기능 동작 확인 근거 없음", { exact: true }).first(),
  ).toBeVisible();
});

test("pin, edited title and memo persist after reloading, and search retains question context", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("task-t2:a3").click();
  await page.getByRole("button", { name: "작업 고정", exact: true }).click();
  await page.getByRole("tab", { name: /요약/ }).click();
  await page.getByLabel("작업 제목 편집").fill("저장 배경색 수정");
  await page.getByLabel("작업 메모").fill("내보내기 동작을 추가 확인해야 함");
  await page.getByRole("button", { name: "메모 저장", exact: true }).click();
  await expect(page.getByText("저장했습니다.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("task-t2:a3")).toContainText(
    "저장 배경색 수정",
  );
  await page.getByPlaceholder("질문, 작업, 파일 검색").fill("내보내기 동작");
  await expect(
    page.getByText("저장하면 배경색이 사라져", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByTestId("task-t1:a1")).toHaveCount(0);
  await page
    .getByPlaceholder("질문, 작업, 파일 검색")
    .fill("일치하지 않는 검색어");
  await page
    .getByRole("navigation", { name: "고정한 작업" })
    .getByRole("button", { name: "저장 배경색 수정" })
    .click();
  await expect(page.getByPlaceholder("질문, 작업, 파일 검색")).toHaveValue("");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
});

test("live append preserves selected task and viewport until following is requested", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("task-t2:a3").click();
  const transform = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  const source = path.resolve(".local/e2e/fixture.jsonl");
  await fs.appendFile(
    source,
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "t2",
        item: {
          type: "AgentMessage",
          id: "a4",
          phase: "commentary",
          content: [
            {
              type: "Text",
              text: "저장 결과를 확인하겠습니다. 새 실행 기록입니다.",
            },
          ],
        },
      },
    }) + "\n",
  );
  await expect(page.getByTestId("task-t2:a4")).toBeAttached({ timeout: 10000 });
  await expect(page.getByTestId("details-title")).toHaveText(
    "저장 배경색 수정",
  );
  expect(
    await page.locator(".react-flow__viewport").getAttribute("style"),
  ).toBe(transform);
  await page.getByRole("button", { name: /현재 작업 따라가기/ }).click();
  await expect(page.getByTestId("details-title")).not.toHaveText(
    "저장 배경색 수정",
  );
  await page.screenshot({
    path: ".local/browser-verified.png",
    fullPage: true,
  });
});

test("a delayed conversation switch cannot write old preferences into the next conversation", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByTestId("task-t2:a3").click();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/second-session", async (route) => {
    await hold;
    await route.continue();
  });
  const requested = page.waitForRequest("**/api/sessions/second-session");
  await page
    .getByRole("navigation", { name: "프로젝트 대화" })
    .getByRole("button", { name: /별도 대화/ })
    .click();
  await requested;
  await page.getByRole("button", { name: /작업 고정/ }).dispatchEvent("click");
  let during;
  try {
    await page.waitForTimeout(450);
    during = await (await request.get("/api/state/second-session")).json();
  } finally {
    release();
  }
  expect(during.pinned || []).not.toContain("t2:a3");
  expect(during.titles || {}).not.toHaveProperty("t2:a3");
  await expect(page.getByTestId("details-title")).toHaveText(
    "분리된 작업 설명",
  );
  await page.waitForTimeout(500);
  const saved = await (await request.get("/api/state/second-session")).json();
  expect(saved.pinned || []).not.toContain("t2:a3");
  expect(saved.titles || {}).not.toHaveProperty("t2:a3");
});
