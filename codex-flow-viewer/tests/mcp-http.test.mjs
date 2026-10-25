import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import http from 'node:http';

test('late state body cannot cross direct projects and failed selection persistence keeps active source',async t=>{
 const {direct,repo,store,base,put,server}=await setup(t);
 const a=direct.createProject({name:'A',requestId:randomUUID()}),b=direct.createProject({name:'B',requestId:randomUUID()}),c=direct.startConversation({projectId:a.projectId,title:'A 대화',requestId:randomUUID()});await repo.refresh();
 await put('/api/connection',{sourceKind:'chatgpt-mcp',projectId:a.projectId});const scope=repo.connectionId,id='mcp:'+c.conversationId;
 let started;const ready=new Promise(r=>{started=r;});server.on('request',req=>{if(req.url==='/api/state/'+encodeURIComponent(id))started();});
 let req;const result=new Promise((resolve,reject)=>{req=http.request(base+'/api/state/'+encodeURIComponent(id),{method:'PUT',headers:{'X-Viewer-Connection':scope}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write('{"notes":');});await ready;
 await put('/api/connection',{sourceKind:'chatgpt-mcp',projectId:b.projectId});req.end('{"old":"late value"}}');assert.equal(await result,409);assert.deepEqual(store.get('session:'+id),{});
 const before=repo.snapshot(),set=store.set.bind(store);store.set=(key,value)=>{if(key==='record-source')throw new Error('injected selection failure');set(key,value);};
 const failed=await put('/api/connection',{sourceKind:'chatgpt-mcp',projectId:a.projectId});assert.equal(failed.status,400);assert.equal(repo.connectionId,before.connectionId);assert.equal(repo.mcpProjectId,b.projectId);store.set=set;
});
import { ViewerStore } from "../server/store.mjs";
import { SessionRepository } from "../server/repository.mjs";
import { RecordSourceRouter } from "../server/record-source-router.mjs";
import { DirectRecords } from "../server/mcp/records.mjs";
import { createViewerServer } from "../server/http.mjs";
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-direct-http-"));
  await fs.writeFile(
    path.join(dir, "codex.jsonl"),
    JSON.stringify({
      type: "session_meta",
      payload: { id: "old-codex", cwd: dir },
    }) + "\n",
  );
  const store = new ViewerStore(":memory:"),
    direct = new DirectRecords(store),
    config = { project: dir, sessionsRoot: dir },
    codex = new SessionRepository(config),
    repo = new RecordSourceRouter({ codex, direct, store });
  await repo.refresh();
  const server = createViewerServer({
    repository: repo,
    direct,
    store,
    config,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + server.address().port,
    put = (p, v, h = {}) =>
      fetch(base + p, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...h },
        body: JSON.stringify(v),
      });
  return { direct, repo, store, base, put, dir,server };
}
test("MCP project source is explicit, scope-safe and follows newly received rows without overwriting preferences", async (t) => {
  const { direct, repo, store, base, put, dir } = await setup(t);
  const first = repo.snapshot();
  const p = await (
    await fetch(base + "/api/direct/projects", {
      method: "POST",
      body: JSON.stringify({ name: "수신 프로젝트", requestId: randomUUID() }),
    })
  ).json();
  assert.equal(repo.connectionId, first.connectionId);
  const c = direct.startConversation({
    projectId: p.projectId,
    title: "실시간 수신",
    requestId: randomUUID(),
  });
  direct.record({
    conversationId: c.conversationId,
    question: "첫 질문",
    answer: "첫 답변",
    requestId: randomUUID(),
  });
  await repo.refresh();
  const connected = await (
    await put("/api/connection", {
      sourceKind: "chatgpt-mcp",
      projectId: p.projectId,
    })
  ).json();
  assert.equal(connected.config.sourceKind, "chatgpt-mcp");
  assert.equal(connected.sessions.length, 1);
  const id = connected.sessions[0].id,
    headers = { "X-Viewer-Connection": connected.config.connectionId };
  assert.equal(
    (
      await put(
        "/api/state/" + encodeURIComponent(id),
        { notes: { q: "보존" }, pinned: ["q"] },
        headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (await fetch(base + "/api/sessions/old-codex", { headers })).status,
    404,
  );
  direct.record({
    conversationId: c.conversationId,
    question: "새 질문",
    answer: "새 답변",
    requestId: randomUUID(),
  });
  await repo.refresh();
  assert.equal(repo.get(id).turns.length, 2);
  assert.deepEqual(store.get("session:" + id).notes, { q: "보존" });
  const other = direct.createProject({
    name: "수신 프로젝트",
    requestId: randomUUID(),
  });
  const b = direct.startConversation({
    projectId: other.projectId,
    title: "다른 대화",
    requestId: randomUUID(),
  });
  await repo.refresh();
  assert.equal(
    (
      await fetch(
        base + "/api/sessions/" + encodeURIComponent("mcp:" + b.conversationId),
      )
    ).status,
    404,
  );
  await put("/api/connection", {
    sourceKind: "codex",
    project: dir,
    sessionsRoot: dir,
  });
  assert.equal(
    (await put("/api/state/" + encodeURIComponent(id), { notes: {} }, headers))
      .status,
    409,
  );
});
test("failed switch, external project creation and retired import endpoints do not change active records", async (t) => {
  const { base, repo, put } = await setup(t);
  const before = repo.snapshot();
  assert.equal(
    (
      await put("/api/connection", {
        sourceKind: "chatgpt-mcp",
        projectId: randomUUID(),
      })
    ).status,
    400,
  );
  assert.equal(repo.connectionId, before.connectionId);
  assert.equal(
    (
      await fetch(base + "/api/direct/projects", {
        method: "POST",
        headers: { Origin: "https://foreign.test" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(base + "/api/chatgpt/imports", { method: "POST", body: "{}" }))
      .status,
    404,
  );
  assert.equal(
    (await fetch(base + "/api/direct/record", { method: "POST", body: "{}" }))
      .status,
    404,
  );
  const status = await (await fetch(base + "/api/direct/status")).json();
  assert.equal(status.recordingAvailable, true);
  assert.equal(status.activeClients.length, 0);
  assert.equal(status.recordCount, 0);
});
