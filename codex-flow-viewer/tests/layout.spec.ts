import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

async function overlaps(page: Page) {
  return page.locator(".react-flow__node").evaluateAll((nodes) => {
    const boxes = nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return {
        id: node.getAttribute("data-id"),
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
      };
    });
    const pairs: string[] = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i],
          b = boxes[j];
        if (
          a.x < b.right - 1 &&
          a.right > b.x + 1 &&
          a.y < b.bottom - 1 &&
          a.bottom > b.y + 1
        )
          pairs.push(`${a.id} / ${b.id}`);
      }
    return pairs;
  });
}

test.beforeEach(async ({ request }) => {
  await request.put("/api/state/browser-session", {
    data: {
      selected: "t1:a1",
      expanded: ["t1", "t2"],
      pinned: ["t1:a1"],
      notes: { "t1:a1": "메모 보존" },
      titles: {},
      positions: { "t1:a1": { x: 80, y: 112 }, t2: { x: 64, y: 145 } },
      relations: [],
    },
  });
});

test("legacy dragged coordinates cannot overlap questions with tasks, including after toggling branches", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeAttached();
  await expect.poll(() => overlaps(page)).toEqual([]);
  await page
    .getByRole("button", {
      name: "프로젝트 화면 구성해줘 작업 접기",
      exact: true,
    })
    .click();
  await expect.poll(() => overlaps(page)).toEqual([]);
  await page
    .getByRole("button", {
      name: "프로젝트 화면 구성해줘 작업 펼치기",
      exact: true,
    })
    .click();
  await expect.poll(() => overlaps(page)).toEqual([]);
  const saved = await (await request.get("/api/state/browser-session")).json();
  expect(saved.notes["t1:a1"]).toBe("메모 보존");
  expect(saved.pinned).toContain("t1:a1");
});

test("a late row in an older request keeps its tasks above the following question without changing viewport", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("task-t1:a1")).toBeAttached();
  await page.waitForTimeout(350);
  const viewport = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  const rows = ["late-1", "late-2"].map((id) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "t1",
        item: {
          type: "AgentMessage",
          id,
          phase: "commentary",
          content: [{ type: "Text", text: `늦게 추가된 작업 ${id}` }],
        },
      },
    }),
  );
  await fs.appendFile(
    path.resolve(".local/e2e/fixture.jsonl"),
    rows.join("\n") + "\n",
  );
  await expect(page.getByTestId("task-t1:late-2")).toBeAttached({
    timeout: 10000,
  });
  await expect.poll(() => overlaps(page)).toEqual([]);
  const last = (await page.getByTestId("task-t1:late-2").boundingBox())!;
  const question = (await page
    .locator('.react-flow__node[data-id="t2"]')
    .boundingBox())!;
  expect(last.y + last.height).toBeLessThan(question.y);
  expect(
    await page.locator(".react-flow__viewport").getAttribute("style"),
  ).toBe(viewport);
});
