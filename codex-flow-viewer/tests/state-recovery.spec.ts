import { test, expect } from "@playwright/test";

test("stale saved node ids recover current task branches after a source replacement", async ({
  page,
  request,
}) => {
  await request.put("/api/state/browser-session", {
    data: {
      selected: "old-task",
      expanded: ["old-turn"],
      pinned: [],
      notes: {},
      titles: {},
      positions: {},
      viewport: { x: 50000, y: 50000, zoom: 1 },
      relations: [],
    },
  });
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeInViewport();
  await page.getByTestId("task-t2:a3").click();
  await page.getByRole("tab", { name: /변경 파일/ }).click();
  await expect(page.getByText("export.test.ts", { exact: true })).toBeVisible();
});
