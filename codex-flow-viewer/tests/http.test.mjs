import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createViewerServer } from "../server/http.mjs";
import { SessionRepository } from "../server/repository.mjs";
import { ViewerStore } from "../server/store.mjs";
import http from "node:http";

test("API is scoped to discovered sessions and rejects foreign Origin writes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-http-"));
  const file = path.join(dir, "one.jsonl");
  await fs.writeFile(
    file,
    JSON.stringify({ type: "session_meta", payload: { id: "one", cwd: dir } }) +
      "\n",
  );
  const repo = new SessionRepository({ sessionsRoot: dir, project: dir });
  await repo.refresh();
  const store = new ViewerStore(":memory:");
  const server = createViewerServer({
    repository: repo,
    store,
    config: { project: dir, sessionsRoot: dir },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + "/api/sessions")).status, 200);
  assert.equal((await fetch(base + "/api/sessions/not-found")).status, 404);
  assert.equal((await fetch(base + "/api/sessions/..%2Fsecret")).status, 404);
  assert.equal(
    (
      await fetch(base + "/api/state/one", {
        method: "PUT",
        headers: {
          origin: "https://foreign.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/state/one", {
        method: "PUT",
        headers: { origin: base, "Content-Type": "application/json" },
        body: '{"notes":{"task":"내 메모"}}',
      })
    ).status,
    200,
  );
  const saved = await (await fetch(base + "/api/state/one")).json();
  assert.equal(saved.notes.task, "내 메모");
  const malformed = await fetch(base + "/api/state/one", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: '{"pinned":null,"notes":null}',
  });
  assert.equal(malformed.status, 400);
  store.set("session:one", {
    pinned: null,
    notes: null,
    viewport: { x: "bad", zoom: -10 },
  });
  const repaired = await (await fetch(base + "/api/state/one")).json();
  assert.deepEqual(repaired.pinned, []);
  assert.deepEqual(repaired.notes, {});
  const status = await new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port: server.address().port, path: "http://[" },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 400);
});
