import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

test.beforeEach(async ({ page, request }) => {
  await request.put("/api/state/browser-session", {
    data: {
      selected: "t2:a3",
      expanded: ["t1", "t2"],
      pinned: ["t2:a3"],
      notes: {},
      titles: {},
      positions: {},
      relations: [],
    },
  });
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
});

test("overview is a concise question timeline linked to files and source evidence, with the unwanted header removed", async ({
  page,
}) => {
  const header = page.locator(".app-header");
  await expect(
    header.locator(".breadcrumb,.readonly-label,.live-label"),
  ).toHaveCount(0);
  await expect(
    header.getByRole("button", { name: "설정", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "한눈에 보기", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "질문 진행 타임라인" }),
  ).toBeVisible();
  await expect(page.locator(".react-flow")).toHaveCount(0);
  await expect(page.getByTestId("overview-t1")).toContainText(
    "입력 화면 구성을 기록했습니다.",
  );
  await expect(page.getByTestId("overview-t2")).toContainText("파일 3");
  await page.getByTestId("overview-t2").click();
  await expect(page.getByTestId("details-title")).toHaveText(
    "저장하면 배경색이 사라져",
  );
  await page.getByRole("tab", { name: /변경 파일/ }).click();
  await expect(page.getByText("src/export.ts", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /근거 기록/ }).click();
  await expect(page.getByText(/원본 JSONL/).first()).toBeVisible();
  await page.getByRole("textbox", { name: "기록 검색" }).fill("src/export.ts");
  await expect(page.getByTestId("overview-t1")).toHaveCount(0);
  await expect(page.getByTestId("overview-t2")).toBeVisible();
  await page.getByRole("textbox", { name: "기록 검색" }).fill("없는검색");
  await expect(
    page.getByText("조건에 맞는 질문이 없습니다.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "고정한 작업" })
    .getByRole("button")
    .click();
  await expect(page.getByTestId("overview-t2")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("textbox", { name: "기록 검색" })).toHaveValue(
    "",
  );
});

test("switching to the timeline and back preserves the graph camera", async ({
  page,
}) => {
  await page.waitForTimeout(200);
  const camera = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await page.getByRole("button", { name: "한눈에 보기", exact: true }).click();
  await page.getByTestId("overview-t1").click();
  await page.getByRole("button", { name: "작업 보기", exact: true }).click();
  await expect
    .poll(() => page.locator(".react-flow__viewport").getAttribute("style"))
    .toBe(camera);
});

test("timeline reading position survives live updates and mode switches, and follows only when enabled", async ({
  page,
}) => {
  await page.route("**/api/sessions/browser-session", async (route) => {
    const response = await route.fetch(),
      session = await response.json();
    session.turns.push(
      ...Array.from({ length: 16 }, (_, i) => ({
        ...session.turns[0],
        id: "overview-long-" + i,
        title: "흐름 질문 " + i,
        result: "기록된 답변 " + i,
        tasks: [],
      })),
    );
    await route.fulfill({ json: session });
  });
  await page.reload();
  await page.waitForTimeout(200);
  const graphCamera = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await page.getByRole("button", { name: "한눈에 보기", exact: true }).click();
  const region = page.getByRole("region", { name: "질문 진행 타임라인" });
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeLessThanOrEqual(await page.evaluate(() => innerHeight));
  await region.hover();
  await page.mouse.wheel(0, 450);
  await expect
    .poll(() => region.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(300);
  const top = await region.evaluate((el) => el.scrollTop);
  await fs.appendFile(
    path.resolve(".local/e2e/fixture.jsonl"),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "t2",
        item: {
          id: "overview-live",
          type: "AgentMessage",
          phase: "commentary",
          content: [{ type: "Text", text: "타임라인 갱신 설명" }],
        },
      },
    }) + "\n",
  );
  await expect
    .poll(async () =>
      JSON.stringify(
        await (await page.request.get("/api/sessions/browser-session")).json(),
      ),
    )
    .toContain("타임라인 갱신 설명");
  await page.waitForTimeout(250);
  expect(await region.evaluate((el) => el.scrollTop)).toBeCloseTo(top, 0);
  await page.getByRole("button", { name: /현재 작업 따라가기/ }).click();
  await expect
    .poll(() =>
      region.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThan(2);
  await expect(
    page.getByRole("button", { name: /현재 작업 따라가기/ }),
  ).toHaveClass(/enabled/);
  await region.hover();
  await page.mouse.wheel(0, -250);
  await expect(
    page.getByRole("button", { name: /현재 작업 따라가기/ }),
  ).not.toHaveClass(/enabled/);
  await page
    .getByRole("navigation", { name: "고정한 작업" })
    .getByRole("button")
    .click();
  await region.hover();
  await page.mouse.wheel(0, 450);
  await page.waitForTimeout(100);
  const reading = await region.evaluate((el) => el.scrollTop);
  await page.getByRole("button", { name: "작업 보기", exact: true }).click();
  await page.waitForTimeout(400);
  await expect
    .poll(() => page.locator(".react-flow__viewport").getAttribute("style"))
    .toBe(graphCamera);
  await page.getByRole("button", { name: "한눈에 보기", exact: true }).click();
  await expect
    .poll(() => region.evaluate((el) => el.scrollTop))
    .toBeCloseTo(reading, 0);
  await page.getByRole("button", { name: "첫 질문으로 이동" }).click();
  await expect
    .poll(() => region.evaluate((el) => el.scrollTop))
    .toBeLessThan(1);
  await page.getByRole("button", { name: "마지막 기록으로 이동" }).click();
  await expect
    .poll(() =>
      region.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThan(2);
});
