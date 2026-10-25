import { test, expect, type Locator } from "@playwright/test";

const transform = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).transform);

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
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeInViewport();
  await page.waitForTimeout(350);
});

for (const target of [
  {
    id: "t1",
    card: ".request-card",
    title: "프로젝트 화면 구성해줘",
    label: "question",
  },
  {
    id: "t2:a3",
    card: ".task-card",
    title:
      "PNG 저장 오류를 수정하겠습니다. 선택한 배경색을 저장 함수에 전달합니다.",
    label: "task",
  },
]) {
  test(`a slight mouse slip still selects a ${target.label} block without moving it or the canvas`, async ({
    page,
    request,
  }) => {
    const node = page.locator(`.react-flow__node[data-id="${target.id}"]`);
    const card = node.locator(target.card);
    const originalNode = await transform(node);
    const originalViewport = await transform(
      page.locator(".react-flow__viewport"),
    );
    const box = (await card.boundingBox())!;
    const x = box.x + 75,
      y = box.y + 38;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 14, y + 10, { steps: 5 });
    await page.mouse.up();
    // Releasing over the same card must select it even with a small hand movement.
    await expect(page.getByTestId("details-title")).toHaveText(target.title);
    expect(await transform(node)).toBe(originalNode);
    expect(await transform(page.locator(".react-flow__viewport"))).toBe(
      originalViewport,
    );
    await page.waitForTimeout(400);
    const saved = await (
      await request.get("/api/state/browser-session")
    ).json();
    expect(saved.positions).toEqual({});
  });
}

test("hover lifts the card and pressing gives feedback without changing graph coordinates", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const card = page.getByTestId("task-t2:a3");
  const node = page.locator('.react-flow__node[data-id="t2:a3"]');
  await page.mouse.move(250, 100);
  const originalNode = await transform(node);
  await card.hover();
  await expect
    .poll(() =>
      card.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).m42),
    )
    .toBeLessThan(-1);
  expect(await card.evaluate((e) => getComputedStyle(e).boxShadow)).not.toBe(
    "none",
  );
  await page.mouse.down();
  await expect
    .poll(() =>
      card.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).m11),
    )
    .toBeLessThan(0.999);
  await page.mouse.up();
  await page.mouse.move(250, 100);
  await expect
    .poll(() =>
      card.evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).m42),
    )
    .toBe(0);
  expect(await transform(node)).toBe(originalNode);
});

test("reduced-motion preference keeps hover feedback stationary", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const card = page.getByTestId("task-t2:a3");
  await card.hover();
  expect(await transform(card)).toBe("none");
  expect(
    await card.evaluate((e) => getComputedStyle(e).transitionDuration),
  ).toBe("0s");
});

test("dragging empty canvas space still pans the flow", async ({ page }) => {
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  const viewport = page.locator(".react-flow__viewport");
  const before = await transform(viewport);
  await page.mouse.move(pane.x + 6, pane.y + 75);
  await page.mouse.down();
  await page.mouse.move(pane.x + 56, pane.y + 105, { steps: 5 });
  await page.mouse.up();
  expect(await transform(viewport)).not.toBe(before);
});

test("following a collapsed latest branch centers the new card without initial camera snapback", async ({
  page,
  request,
}) => {
  await request.put("/api/state/browser-session", {
    data: {
      selected: "t1:a1",
      expanded: ["t1"],
      pinned: [],
      notes: {},
      titles: {},
      positions: {},
      relations: [],
      viewport: { x: 30, y: 10, zoom: 1 },
    },
  });
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.reload();
  await page.getByRole("button", { name: /현재 작업 따라가기/ }).click();
  const card = page.getByTestId("task-t2:a3");
  await expect(card).toBeInViewport();
  await expect
    .poll(async () => {
      const block = (await card.boundingBox())!;
      const canvas = (await page.locator(".canvas-frame").boundingBox())!;
      return Math.abs(
        block.y + block.height / 2 - canvas.y - canvas.height / 2,
      );
    })
    .toBeLessThan(20);
});
