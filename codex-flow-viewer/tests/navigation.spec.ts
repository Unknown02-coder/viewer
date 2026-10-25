import { test, expect, type Page } from "@playwright/test";

const camera = (page: Page) =>
  page.locator(".react-flow__viewport").evaluate((el) => {
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return { x: m.m41, y: m.m42, zoom: m.m11 };
  });
test.beforeEach(async ({ page, request }) => {
  await request.put("/api/state/browser-session", {
    data: {
      selected: "t1:a1",
      expanded: ["t1", "t2"],
      pinned: [],
      notes: {},
      titles: {},
      positions: {},
      relations: [],
    },
  });
  await page.route("**/api/sessions/browser-session", async (route) => {
    const response = await route.fetch();
    const session = await response.json();
    session.turns.push(
      ...Array.from({ length: 12 }, (_, i) => ({
        ...session.turns[0],
        id: `scroll-q-${i}`,
        title: `스크롤 확인 질문 ${i + 1}`,
        tasks: [],
      })),
    );
    await route.fulfill({ json: session });
  });
  await page.goto("/");
  await expect(page.locator('.react-flow__node[data-id="t1"]')).toBeVisible();
  await page.waitForTimeout(300);
});

test("a fresh conversation starts at the first question and fits its full width", async ({
  page,
}) => {
  const q = (await page
    .locator('.react-flow__node[data-id="t1"]')
    .boundingBox())!;
  const frame = (await page.locator(".react-flow").boundingBox())!;
  expect(q.y - frame.y).toBeGreaterThan(20);
  expect(q.y - frame.y).toBeLessThan(80);
  expect(q.x).toBeGreaterThan(frame.x);
  expect(q.x + q.width).toBeLessThan(frame.x + frame.width - 10);
  expect((await camera(page)).zoom).toBeGreaterThan(0.6);
});

test("wheel over a card scrolls without scaling; Ctrl wheel zooms without changing browser size", async ({
  page,
  request,
}) => {
  const card = page.getByTestId("task-t1:a1");
  await card.hover();
  const before = await camera(page);
  const width = await page.evaluate(() => innerWidth);
  await page.mouse.wheel(0, 220);
  await expect
    .poll(async () => (await camera(page)).y)
    .toBeLessThan(before.y - 100);
  expect((await camera(page)).zoom).toBeCloseTo(before.zoom, 4);
  expect((await camera(page)).x).toBeCloseTo(before.x, 4);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 150);
  await page.keyboard.up("Control");
  await expect
    .poll(async () => (await camera(page)).zoom)
    .toBeLessThan(before.zoom);
  expect(await page.evaluate(() => innerWidth)).toBe(width);
  const after = await camera(page);
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/state/browser-session")).json())
          .viewport?.zoom,
    )
    .toBeCloseTo(after.zoom, 4);
  const rail = page.getByRole("region", { name: "작업 흐름 세로 스크롤" });
  expect(await rail.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.reload();
  await expect
    .poll(async () => (await camera(page)).zoom)
    .toBeCloseTo(after.zoom, 4);
  await expect.poll(async () => (await camera(page)).y).toBeCloseTo(after.y, 1);
});

test("native scrollbar moves the flow, follows wheel scrolling, and can return to the beginning", async ({
  page,
}) => {
  const rail = page.getByRole("region", { name: "작업 흐름 세로 스크롤" });
  await expect(rail).toBeVisible();
  await rail.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await camera(page)).y).toBeLessThan(-500);
  expect(await rail.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
  await page.getByRole("button", { name: "첫 질문으로 이동" }).click();
  await expect.poll(async () => (await camera(page)).y).toBeCloseTo(56, 0);
  await expect.poll(() => rail.evaluate((el) => el.scrollTop)).toBeLessThan(1);
});

test("reading tools sit beside search and the bottom action moves to the last visible record without scaling", async ({
  page,
}) => {
  const bottom = page.getByRole("button", { name: "마지막 기록으로 이동" });
  await expect(bottom).toBeVisible();
  for (const width of [1728, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const search = (await page
      .getByRole("textbox", { name: "기록 검색" })
      .locator("..")
      .boundingBox())!;
    const tools = (await page.locator(".reading-tools").boundingBox())!;
    expect(tools.x).toBeGreaterThanOrEqual(search.x + search.width);
    expect(
      Math.abs(tools.y + tools.height / 2 - (search.y + search.height / 2)),
    ).toBeLessThan(3);
    expect(tools.x + tools.width).toBeLessThan(width);
  }
  const before = await camera(page);
  await bottom.click();
  const rail = page.getByRole("region", { name: "작업 흐름 세로 스크롤" });
  await expect
    .poll(() =>
      rail.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThan(2);
  expect((await camera(page)).zoom).toBeCloseTo(before.zoom, 4);
  expect((await camera(page)).x).toBeCloseTo(before.x, 4);
  const last = (await page
    .locator('.react-flow__node[data-id="scroll-q-11"]')
    .boundingBox())!;
  const frame = (await page.locator(".react-flow").boundingBox())!;
  expect(last.y).toBeGreaterThan(frame.y);
  expect(last.y + last.height).toBeLessThan(frame.y + frame.height);
  await page.getByRole("button", { name: "첫 질문으로 이동" }).click();
  await expect.poll(() => rail.evaluate((el) => el.scrollTop)).toBeLessThan(1);
});

test("ordinary wheel stops at the first and last record rather than adding endless blank space", async ({
  page,
}) => {
  const frame = (await page.locator(".react-flow").boundingBox())!;
  await page.mouse.move(frame.x + 5, frame.y + 120);
  const first = await camera(page);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(150);
  expect((await camera(page)).y).toBeCloseTo(first.y, 1);
  const rail = page.getByRole("region", { name: "작업 흐름 세로 스크롤" });
  await rail.focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await camera(page)).y).toBeLessThan(-500);
  const last = await camera(page);
  await page.mouse.move(frame.x + 5, frame.y + 120);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(150);
  expect((await camera(page)).y).toBeCloseTo(last.y, 1);
});

test("a narrow center column stacks readable cards instead of shrinking the two-column grid", async ({
  page,
  request,
}) => {
  await request.put("/api/state/browser-session", {
    data: {
      selected: "t1:a1",
      expanded: ["t1", "t2"],
      pinned: [],
      notes: {},
      titles: {},
      positions: {},
      relations: [],
    },
  });
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.reload();
  await expect(page.getByTestId("task-t1:a1")).toBeVisible();
  await page.waitForTimeout(300);
  const a = (await page.getByTestId("task-t1:a1").boundingBox())!;
  const b = (await page.getByTestId("task-t1:a2").boundingBox())!;
  expect(a.x).toBeCloseTo(b.x, 0);
  expect(b.y).toBeGreaterThan(a.y + a.height + 10);
  expect((await camera(page)).zoom).toBeGreaterThan(0.9);

  await page.mouse.move(a.x + 5, a.y + 5);
  await page.mouse.wheel(0, 160);
  await page.waitForTimeout(100);
  const oldCard = (await page
    .locator('.react-flow__node[data-id="t1:a1"]')
    .boundingBox())!;
  const oldFrame = (await page.locator(".react-flow").boundingBox())!;
  const oldZoom = (await camera(page)).zoom;
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(250);
  const frame = (await page.locator(".react-flow").boundingBox())!;
  const question = (await page
    .locator('.react-flow__node[data-id="t1"]')
    .boundingBox())!;
  expect(question.x + question.width).toBeLessThan(frame.x + frame.width - 10);
  const resizedCard = (await page
    .locator('.react-flow__node[data-id="t1:a1"]')
    .boundingBox())!;
  const zoom = (await camera(page)).zoom;
  // Keep the reading line's position within the same card across the reflow.
  expect((56 - (resizedCard.y - frame.y)) / zoom).toBeCloseTo(
    (56 - (oldCard.y - oldFrame.y)) / oldZoom,
    0,
  );
});
