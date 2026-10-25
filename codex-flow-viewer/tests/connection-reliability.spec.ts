import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
const root = path.resolve(".local/e2e"),
  target = path.join(root, "connection-target"),
  empty = path.join(root, "connection-empty");
const home = path.join(root, "connection-home"),
  active = path.join(home, "sessions"),
  archive = path.join(home, "archived_sessions");
const file = path.join(root, "connection-target.jsonl");
const rows = () =>
  Buffer.from(
    [
      {
        type: "session_meta",
        payload: { id: "connection-target", cwd: target },
      },
      {
        type: "turn_context",
        payload: { turn_id: "target-turn", cwd: target },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "target-turn",
          item: { id: "q", type: "UserMessage", content: "대상 프로젝트 질문" },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "target-turn",
          item: {
            id: "a",
            type: "AgentMessage",
            phase: "commentary",
            content: [{ type: "Text", text: "대상 프로젝트 작업 설명" }],
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
test.beforeEach(async ({ request }) => {
  await Promise.all(
    [target, empty, active, archive].map((p) =>
      fs.mkdir(p, { recursive: true }),
    ),
  );
  await fs.writeFile(file, rows());
  await fs.writeFile(
    path.join(archive, "target.jsonl.zst"),
    zstdCompressSync(rows()),
  );
  await request.put("/api/config", {
    data: { project: root, sessionsRoot: root },
  });
});
test.afterEach(async ({ request }) => {
  await request.put("/api/config", {
    data: { project: root, sessionsRoot: root },
  });
  await fs.rm(file, { force: true });
  await fs.rm(path.join(archive, "target.jsonl.zst"), { force: true });
});

test("quoted project paths and Codex home connect archived records and show normalized inputs", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .getByLabel("프로젝트 폴더", { exact: true })
    .fill('  "' + target + '"  ');
  await page.getByLabel(/Codex 기록 폴더/).fill(' "' + home + '" ');
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(page.getByTestId("task-target-turn:a")).toBeVisible();
  const config = await (await request.get("/api/config")).json();
  expect(config.diagnostics.conversationCount).toBe(1);
  expect(config.diagnostics.archivedFiles).toBe(1);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(page.getByLabel("프로젝트 폴더", { exact: true })).toHaveValue(
    target,
  );
  await expect(page.getByLabel(/Codex 기록 폴더/)).toHaveValue(active);
});

test("a valid folder without history explains the mismatch and offers actual recorded projects", async ({
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
  const picker = page
    .getByRole("combobox", { name: "기록에 있는 프로젝트" })
    .first();
  await picker.selectOption(root);
  await expect(page.getByLabel("프로젝트 폴더", { exact: true })).toHaveValue(
    root,
  );
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
});

test("a delayed old conversation response cannot overwrite a newly connected project", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
  let release!: () => void, fetched!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      fetched = resolve;
    });
  await page.route("**/api/sessions/second-session", async (route) => {
    const response = await route.fetch();
    fetched();
    await held;
    await route.fulfill({ response });
  });
  await page
    .getByRole("navigation", { name: "프로젝트 대화" })
    .getByRole("button", { name: /별도 대화/ })
    .click();
  await ready;
  try {
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("프로젝트 폴더", { exact: true }).fill(target);
    await page
      .getByRole("button", { name: "프로젝트 연결", exact: true })
      .click();
    await expect(page.getByTestId("task-target-turn:a")).toBeVisible();
  } finally {
    release();
  }
  await page.waitForTimeout(500);
  await expect(page.getByTestId("details-title")).toHaveText(
    "대상 프로젝트 작업 설명",
  );
  await expect(page.getByTestId("task-t2:a3")).toHaveCount(0);
  await expect(page.locator(".project-card")).toContainText(
    "connection-target",
  );
});

test("reconnecting the event stream resynchronizes a project changed elsewhere even when change events were missed", async ({
  page,
  request,
}) => {
  await page.route("**/api/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: "retry: 150\nevent: ready\ndata: {}\n\n",
    }),
  );
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
  await request.put("/api/config", {
    data: { project: target, sessionsRoot: root },
  });
  await expect(page.getByTestId("task-target-turn:a")).toBeVisible({
    timeout: 10000,
  });
  await expect(page.locator(".project-card")).toContainText(
    "connection-target",
  );
  await expect(page.getByTestId("task-t2:a3")).toHaveCount(0);
});

test("a newer memo and project connection wait for the earlier state write, preserving the latest value", async ({
  page,
  request,
}) => {
  await request.put("/api/state/browser-session", {
    data: {
      selected: "t2:a3",
      expanded: ["t1", "t2"],
      pinned: [],
      notes: {},
      titles: {},
      positions: {},
      relations: [],
    },
  });
  await page.goto("/");
  await page.getByTestId("task-t2:a3").click();
  await page.getByRole("tab", { name: /요약/ }).click();
  await page.waitForTimeout(400);
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const notes: string[] = [];
  let connectionSent = false;
  await page.route("**/api/state/browser-session", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const note = route.request().postDataJSON().notes["t2:a3"];
    if (note) {
      notes.push(note);
      if (note === "old") {
        entered();
        await hold;
      }
    }
    return route.continue();
  });
  await page.route("**/api/connection", async (route) => {
    if (route.request().method() === "PUT") connectionSent = true;
    await route.continue();
  });
  await page.getByLabel("작업 메모").fill("old");
  await page.getByRole("button", { name: "메모 저장", exact: true }).click();
  await ready;
  try {
    await page.getByLabel("작업 메모").fill("new");
    await page.getByRole("button", { name: "메모 저장", exact: true }).click();
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await page.getByLabel("프로젝트 폴더", { exact: true }).fill(target);
    await page
      .getByRole("button", { name: "프로젝트 연결", exact: true })
      .click();
    await page.waitForTimeout(200);
    expect(notes).toEqual(["old"]);
    expect(connectionSent).toBe(false);
  } finally {
    release();
  }
  await expect(page.getByTestId("task-target-turn:a")).toBeVisible();
  await request.put("/api/config", {
    data: { project: root, sessionsRoot: root },
  });
  const saved = await (await request.get("/api/state/browser-session")).json();
  expect(saved.notes["t2:a3"]).toBe("new");
});

test("pending preferences survive a conversation disappearing and return when its records are restored", async ({
  page,
  request,
}) => {
  await request.put("/api/state/browser-session", {
    data: {
      selected: "t2:a3",
      expanded: ["t1", "t2"],
      pinned: [],
      notes: {},
      titles: {},
      positions: {},
      relations: [],
    },
  });
  await page.addInitScript(() => {
    class LocalEvents extends EventTarget {
      onerror = null;
      constructor() {
        super();
        (window as any).__viewerEvents = this;
        queueMicrotask(() =>
          this.dispatchEvent(new MessageEvent("ready", { data: "{}" })),
        );
      }
      close() {}
    }
    (window as any).EventSource = LocalEvents;
  });
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
  const source = path.join(root, "fixture.jsonl"),
    bytes = await fs.readFile(source);
  try {
    await fs.unlink(source);
    await expect
      .poll(async () =>
        (await (await request.get("/api/sessions")).json()).some(
          (s: { id: string }) => s.id === "browser-session",
        ),
      )
      .toBe(false);
    await page.getByRole("button", { name: "작업 고정", exact: true }).click();
    await page.evaluate(() =>
      (window as any).__viewerEvents.dispatchEvent(
        new MessageEvent("change", { data: "{}" }),
      ),
    );
    await expect(page.getByTestId("details-title")).toHaveText(
      "분리된 작업 설명",
    );
  } finally {
    await fs.writeFile(source, bytes);
  }
  await expect
    .poll(async () =>
      (await (await request.get("/api/sessions")).json()).some(
        (s: { id: string }) => s.id === "browser-session",
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    (window as any).__viewerEvents.dispatchEvent(
      new MessageEvent("change", { data: "{}" }),
    ),
  );
  await expect(
    page
      .getByRole("navigation", { name: "프로젝트 대화" })
      .getByRole("button", { name: /프로젝트 화면 구성해줘/ }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "프로젝트 대화" })
    .getByRole("button", { name: /프로젝트 화면 구성해줘/ })
    .click();
  await expect(
    page.getByRole("button", { name: "작업 고정 해제", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/state/browser-session")).json()).pinned,
    )
    .toContain("t2:a3");
});

test("a failed source change explains the error and keeps the previous working project", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByLabel("프로젝트 폴더", { exact: true }).fill(target);
  await page
    .getByLabel(/Codex 기록 폴더/)
    .fill(path.join(root, "missing-records"));
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await expect(page.locator(".form-error")).toContainText(
    "기록 경로를 확인할 수 없습니다",
  );
  expect((await (await request.get("/api/config")).json()).project).toBe(root);
  await page.getByRole("button", { name: "설정 닫기", exact: true }).click();
  await expect(page.getByTestId("task-t2:a3")).toBeVisible();
});

test("connection progress disables conflicting edits and duplicate submissions until its response arrives", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "설정", exact: true }).click();
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
  await page.route("**/api/connection", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    entered();
    await hold;
    await route.fulfill({ response });
  });
  await page.getByLabel("프로젝트 폴더", { exact: true }).fill(target);
  await page
    .getByRole("button", { name: "프로젝트 연결", exact: true })
    .click();
  await ready;
  try {
    await expect(
      page.getByRole("button", { name: "ChatGPT 대화", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Codex 프로젝트", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("combobox", { name: "기록에 있는 프로젝트", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel("프로젝트 폴더", { exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel(/Codex 기록 폴더/)).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "설정 닫기", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "연결하는 중…", exact: false }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByTestId("task-target-turn:a")).toBeVisible();
});
