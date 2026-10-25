import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(".local/e2e");
const target = path.join(root, "source-choice-project");
const empty = path.join(root, "source-choice-empty");
const record = path.join(root, "source-choice.jsonl");

test.beforeEach(async ({ request }) => {
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(empty, { recursive: true });
  await fs.writeFile(
    record,
    [
      { type: "session_meta", payload: { id: "source-choice", cwd: target } },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "choice-turn",
          item: {
            type: "UserMessage",
            id: "q",
            content: "출처 선택 대상 질문",
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  await request.put("/api/config", {
    data: { project: root, sessionsRoot: root },
  });
  await request.put("/api/state/browser-session", {
    data: {
      selected: "t2:a3",
      expanded: ["t2"],
      pinned: ["t2:a3"],
      notes: { "t2:a3": "보존할 메모" },
    },
  });
});
test.afterEach(async ({ request }) => {
  await request.put("/api/config", {
    data: { project: root, sessionsRoot: root },
  });
  await fs.rm(record, { force: true });
});

test("ChatGPT is an honest preview without path inputs or connection writes; cancelling preserves the active conversation", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
  const before = await (await request.get("/api/connection")).json();
  const state = await (await request.get("/api/state/browser-session")).json();
  const writes: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PUT" && /\/api\/(config|connection)$/.test(req.url()))
      writes.push(req.url());
  });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "ChatGPT 대화", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "ChatGPT 대화", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "ChatGPT 직접 연결", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("프로젝트 폴더", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel(/Codex 기록 폴더/)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /프로젝트 연결|로그인|동기화|가져오기/ }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "ChatGPT 대화", exact: true })
    .press("Enter");
  await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
  expect(writes).toEqual([]);
  expect((await (await request.get("/api/connection")).json()).config).toEqual(
    before.config,
  );
  expect(
    await (await request.get("/api/state/browser-session")).json(),
  ).toMatchObject(state);
});

test("a missing project reports a useful error; source switching isolates feedback and reopening discards cancelled drafts", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
  const before = await (await request.get("/api/connection")).json();
  const state = await (await request.get("/api/state/browser-session")).json();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .getByLabel("프로젝트 폴더", { exact: true })
    .fill(path.join(root, "missing-project-folder"));
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(page.locator(".form-error")).toContainText(
    "입력한 프로젝트 폴더가 없습니다",
  );
  await expect(page.locator(".error-banner")).toHaveCount(0);
  expect(
    (await (await request.get("/api/connection")).json()).config.connectionId,
  ).toBe(before.config.connectionId);
  expect(
    await (await request.get("/api/state/browser-session")).json(),
  ).toMatchObject(state);
  await page.getByRole("button", { name: "ChatGPT 대화", exact: true }).click();
  await expect(page.locator(".form-error")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Codex 프로젝트", exact: true })
    .click();
  await expect(page.locator(".form-error")).toHaveCount(0);
  await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(page.getByLabel("프로젝트 폴더", { exact: true })).toHaveValue(
    root,
  );
  await expect(page.getByLabel(/Codex 기록 폴더/)).toHaveValue(root);
});

test("known exact project choices are available while connected and only apply after confirmation", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
  const before = await (await request.get("/api/connection")).json();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  const picker = page.getByRole("combobox", {
    name: "기록에 있는 프로젝트",
    exact: true,
  });
  await picker.selectOption(target);
  await expect(page.getByLabel("프로젝트 폴더", { exact: true })).toHaveValue(
    target,
  );
  expect(
    (await (await request.get("/api/connection")).json()).config.connectionId,
  ).toBe(before.config.connectionId);
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "프로젝트 대화" })
      .getByRole("button", { name: /출처 선택 대상 질문/ }),
  ).toBeVisible();
  expect((await (await request.get("/api/config")).json()).project).toBe(
    target,
  );
});

test("unreadable record location keeps the active connection and changing its input clears the form error", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
  const before = await (await request.get("/api/connection")).json();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .getByLabel(/Codex 기록 폴더/)
    .fill(path.join(root, "missing-record-source"));
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(page.locator(".form-error")).toContainText(
    "기록을 읽지 못했습니다",
  );
  expect(
    (await (await request.get("/api/connection")).json()).config.connectionId,
  ).toBe(before.config.connectionId);
  await page.getByLabel(/Codex 기록 폴더/).fill(root);
  await expect(page.locator(".form-error")).toHaveCount(0);
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "설정 닫기", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
});

test("an existing project without matching history remains distinct from missing folders and can recover", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByLabel("프로젝트 폴더", { exact: true }).fill(empty);
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(
    page
      .getByText(
        "폴더는 연결됐지만 이 경로에 해당하는 Codex 대화 기록이 없습니다.",
        { exact: true },
      )
      .first(),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "기록에 있는 프로젝트", exact: true })
    .selectOption(root);
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
});

test("keyboard focus stays inside settings and Escape cancels back to its opener", async ({
  page,
}) => {
  await page.goto("/");
  const opener = page.getByRole("button", { name: "설정", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "기록 연결 설정" });
  await expect
    .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
    .toBe(true);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.getByRole("button", { name: "ChatGPT 대화", exact: true }).click();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("a conversation read failure after a successful connection stays a runtime error and does not claim rollback", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
  await page.route("**/api/sessions/source-choice", (route) =>
    route.fulfill({ status: 503, json: { error: "대화 조회 실패" } }),
  );
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByLabel("프로젝트 폴더", { exact: true }).fill(target);
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(page.locator(".form-error")).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "기록 연결 설정" }),
  ).toHaveCount(0);
  await expect(page.locator(".error-banner")).toContainText("대화 조회 실패");
  expect((await (await request.get("/api/config")).json()).project).toBe(
    target,
  );
  await page.unroute("**/api/sessions/source-choice");
  await page.reload();
  await expect(
    page
      .getByRole("navigation", { name: "프로젝트 대화" })
      .getByRole("button", { name: /출처 선택 대상 질문/ }),
  ).toBeVisible();
});

test("a prior preference save failure blocks configuration and remains visible after source preview", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
  const before = await (await request.get("/api/config")).json();
  await page.route("**/api/state/**", (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, json: { error: "메모 저장 실패" } })
      : route.continue(),
  );
  await page
    .getByRole("button", { name: "작업 고정 해제", exact: true })
    .click();
  await expect(page.locator(".error-banner")).toContainText("메모 저장 실패");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByLabel("프로젝트 폴더", { exact: true }).fill(target);
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(page.locator(".form-error")).toHaveCount(0);
  await expect(page.locator(".error-banner")).toContainText(
    "메모를 저장하지 못해 연결을 변경하지 않았습니다",
  );
  expect((await (await request.get("/api/config")).json()).connectionId).toBe(
    before.connectionId,
  );
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("button", { name: "ChatGPT 대화", exact: true }).click();
  await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
  await expect(page.locator(".error-banner")).toContainText(
    "메모를 저장하지 못해 연결을 변경하지 않았습니다",
  );
});
