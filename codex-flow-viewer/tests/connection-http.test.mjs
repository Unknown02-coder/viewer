import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { SessionRepository } from "../server/repository.mjs";
import { ViewerStore } from "../server/store.mjs";
import { createViewerServer } from "../server/http.mjs";

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-connect-http-"));
  const a = path.join(dir, "a"),
    b = path.join(dir, "b"),
    records = path.join(dir, "records");
  await Promise.all([a, b, records].map((p) => fs.mkdir(p)));
  for (const [id, project] of [
    ["a", a],
    ["b", b],
  ])
    await fs.writeFile(
      path.join(records, id + ".jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id, cwd: project } }) +
        "\n",
    );
  const repository = new SessionRepository({
    project: a,
    sessionsRoot: records,
  });
  await repository.refresh();
  const store = new ViewerStore(":memory:");
  const server = createViewerServer({
    repository,
    store,
    config: { project: a, sessionsRoot: records },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    a,
    b,
    records,
    repository,
    store,
    server,
    base: "http://127.0.0.1:" + server.address().port,
  };
}
test("connection snapshot is atomic and stale scoped session/state requests cannot affect a new connection", async (t) => {
  const { base, b, records, store } = await setup(t);
  const response = await fetch(base + "/api/connection");
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.sessions[0].id, "a");
  assert.ok(first.config.connectionId);
  const switched = await fetch(base + "/api/connection", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: b, sessionsRoot: records }),
  });
  assert.equal(switched.status, 200);
  const next = await switched.json();
  assert.equal(next.sessions[0].id, "b");
  assert.notEqual(next.config.connectionId, first.config.connectionId);
  for (const [url, method, body] of [
    ["/api/sessions/b", "GET"],
    ["/api/state/b", "PUT", JSON.stringify({ notes: { q: "stale" } })],
  ]) {
    const r = await fetch(base + url, {
      method,
      headers: {
        "X-Viewer-Connection": first.config.connectionId,
        "Content-Type": "application/json",
      },
      body,
    });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, "CONNECTION_CHANGED");
  }
  assert.deepEqual(store.get("session:b"), {});
  assert.deepEqual(store.get("settings"), {
    project: b,
    sessionsRoot: records,
  });
});

test("a state request whose body arrives after a connection switch is rejected before saving", async (t) => {
  const { base, b, records, repository, store, server } = await setup(t);
  const scope = repository.connectionId;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  server.on("request", (request) => {
    if (request.url === "/api/state/a") started();
  });
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request(
      base + "/api/state/a",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Viewer-Connection": scope,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.write('{"notes":');
  });
  await ready;
  await fetch(base + "/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: b, sessionsRoot: records }),
  });
  request.end('{"q":"late old state"}}');
  assert.equal(await result, 409);
  assert.deepEqual(store.get("session:a"), {});
});

test("settings failure returns an error without switching the active API connection", async (t) => {
  const { base, a, b, records, store } = await setup(t);
  const original = store.set.bind(store);
  store.set = (key, value) => {
    if (key === "settings") throw new Error("settings unavailable");
    original(key, value);
  };
  const response = await fetch(base + "/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: b, sessionsRoot: records }),
  });
  assert.equal(response.status, 400);
  assert.equal((await (await fetch(base + "/api/config")).json()).project, a);
  assert.equal((await (await fetch(base + "/api/sessions")).json())[0].id, "a");
});
