import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { ViewerStore } from "../server/store.mjs";
import { SessionRepository } from "../server/repository.mjs";
import { ChatGptRepository } from "../server/chatgpt/repository.mjs";
import { RecordSourceRouter } from "../server/record-source-router.mjs";
import { createViewerServer } from "../server/http.mjs";
import { snapshot, bytes } from "./helpers/chatgpt.mjs";
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-chat-http-"));
  const records = path.join(dir, "records");
  await fs.mkdir(records);
  await fs.writeFile(
    path.join(records, "source.jsonl"),
    JSON.stringify({
      type: "session_meta",
      payload: { id: "codex-existing", cwd: dir },
    }) + "\n",
  );
  const store = new ViewerStore(":memory:");
  store.set("settings", { project: dir, sessionsRoot: records });
  const codex = new SessionRepository({ project: dir, sessionsRoot: records });
  const imports = new ChatGptRepository({
    root: path.join(dir, "imports"),
    store,
  });
  const repository = new RecordSourceRouter({ codex, imports, store });
  await repository.refresh();
  const server = createViewerServer({
    repository,
    store,
    config: { project: dir, sessionsRoot: records },
    imports,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const put = (url, value, headers = {}) =>
    fetch(base + url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(value),
    });
  return { dir, records, store, repository, imports, base, put, server };
}
test("import does not switch source; explicit ChatGPT connection supports scoped notes and exact raw original download", async (t) => {
  const { base, store, put, dir, records } = await setup(t);
  const before = await (await fetch(base + "/api/connection")).json();
  const raw = bytes(snapshot({ truncated: true }));
  const result = await (
    await fetch(base + "/api/chatgpt/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
    })
  ).json();
  assert.equal(result.applied, true);
  assert.equal(
    (await (await fetch(base + "/api/connection")).json()).config.connectionId,
    before.config.connectionId,
  );
  const selected = await (
    await put("/api/connection", {
      sourceKind: "chatgpt",
      conversationId: result.id,
    })
  ).json();
  assert.equal(selected.config.sourceKind, "chatgpt");
  assert.equal(selected.sessions[0].id, result.id);
  const headers = { "X-Viewer-Connection": selected.config.connectionId };
  assert.equal(
    (
      await put(
        "/api/state/" + encodeURIComponent(result.id),
        { notes: { answer: "memo" }, pinned: ["answer"] },
        headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (await put("/api/state/codex-existing", { notes: {} }, headers)).status,
    404,
  );
  const source = await fetch(
    base +
      "/api/chatgpt/imports/" +
      encodeURIComponent(result.id) +
      "/source/" +
      result.snapshotId,
  );
  assert.match(source.headers.get("content-disposition"), /attachment/);
  assert.deepEqual(Buffer.from(await source.arrayBuffer()), raw);
  const back = await (
    await put("/api/connection", {
      sourceKind: "codex",
      project: dir,
      sessionsRoot: records,
    })
  ).json();
  assert.equal(back.sessions[0].id, "codex-existing");
  assert.equal(
    (
      await put(
        "/api/state/" + encodeURIComponent(result.id),
        { notes: {} },
        headers,
      )
    ).status,
    409,
  );
  assert.deepEqual(store.get("session:" + result.id).notes, { answer: "memo" });
});
test("bad uploads and failed/unknown source changes preserve existing catalog and active source", async (t) => {
  const { base, put, repository, store } = await setup(t);
  const imported = await (
    await fetch(base + "/api/chatgpt/imports", {
      method: "POST",
      body: bytes(snapshot()),
    })
  ).json();
  const before = repository.snapshot();
  const catalog = store.get("chatgpt:catalog");
  assert.equal(
    (
      await fetch(base + "/api/chatgpt/imports", {
        method: "POST",
        body: "{invalid",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await put("/api/connection", {
        sourceKind: "chatgpt",
        conversationId: "missing",
      })
    ).status,
    400,
  );
  assert.deepEqual(repository.snapshot(), before);
  assert.deepEqual(store.get("chatgpt:catalog"), catalog);
  assert.equal(
    (
      await fetch(base + "/api/chatgpt/imports", {
        method: "POST",
        headers: { Origin: "https://external.test" },
        body: bytes(snapshot()),
      })
    ).status,
    403,
  );
  assert.equal(
    (await put("/api/connection", { sourceKind: "unknown" })).status,
    400,
  );
  assert.equal(
    (await (await fetch(base + "/api/chatgpt/imports")).json()).conversations[0]
      .id,
    imported.id,
  );
});
test("source selection persistence rolls back together with Codex settings on failure and restores imported source on restart", async (t) => {
  const { store, repository, imports, dir, records } = await setup(t);
  const imported = await imports.import(bytes(snapshot()));
  await repository.configure({
    sourceKind: "chatgpt",
    conversationId: imported.id,
  });
  const before = repository.snapshot();
  const old = store.set.bind(store);
  store.set = (key, value) => {
    if (key === "record-source") throw new Error("save failed");
    old(key, value);
  };
  await assert.rejects(
    repository.configure(
      { sourceKind: "codex", project: dir, sessionsRoot: records },
      (value) => store.set("settings", value),
    ),
    /save failed/,
  );
  assert.equal(repository.connectionId, before.connectionId);
  assert.equal(repository.sourceKind, "chatgpt");
  store.set = old;
  const restarted = new RecordSourceRouter({
    codex: new SessionRepository({ project: dir, sessionsRoot: records }),
    imports,
    store,
  });
  await restarted.refresh();
  assert.equal(restarted.snapshot().sourceKind, "chatgpt");
  assert.equal(restarted.get(imported.id).id, imported.id);
});

test("delayed Codex state cannot save after switching to ChatGPT and oversized imports keep prior catalog", async (t) => {
  const { server, base, repository, put, store, imports } = await setup(t);
  const imported = await imports.import(bytes(snapshot()));
  const scope = repository.connectionId;
  let start;
  const ready = new Promise((resolve) => {
    start = resolve;
  });
  server.on("request", (req) => {
    if (req.url === "/api/state/codex-existing") start();
  });
  let req;
  const result = new Promise((resolve, reject) => {
    req = http.request(
      base + "/api/state/codex-existing",
      {
        method: "PUT",
        headers: {
          "X-Viewer-Connection": scope,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.write('{"notes":');
  });
  await ready;
  await put("/api/connection", {
    sourceKind: "chatgpt",
    conversationId: imported.id,
  });
  req.end('{"q":"late"}}');
  assert.equal(await result, 409);
  assert.deepEqual(store.get("session:codex-existing"), {});
  const before = store.get("chatgpt:catalog");
  const response = await fetch(base + "/api/chatgpt/imports", {
    method: "POST",
    body: Buffer.alloc(50 * 1024 * 1024 + 1, 32),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /50/);
  assert.deepEqual(store.get("chatgpt:catalog"), before);
});
