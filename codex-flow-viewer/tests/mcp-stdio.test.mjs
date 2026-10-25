import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {ToolListChangedNotificationSchema} from '@modelcontextprotocol/sdk/types.js';

test("desktop prerequisite: official MCP client initializes, discovers and calls local status without ingestion or stdout contamination", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-mcp-probe-"));
  const evidence = path.join(dir, "probe.json");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("server/mcp/stdio.mjs")],
    env: {
      ...process.env,
      FLOW_MCP_EVIDENCE: evidence,
      VIEWER_DB: path.join(dir, "state.sqlite"),
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "flow-sdk-verification",
    version: "1.0.0",
  });
  let notify;const changed=new Promise(resolve=>{notify=resolve;});
  client.setNotificationHandler(ToolListChangedNotificationSchema,()=>{notify(true);});
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await client.connect(transport);
  assert.equal(client.getServerVersion().version,'0.2.1');
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t=>t.name).sort(),['flow_status','flow_list_projects','flow_create_project','flow_start_conversation','flow_record'].sort());
  assert.equal(await Promise.race([changed,new Promise(resolve=>setTimeout(()=>resolve(false),500))]),true,'reconnected desktop must receive a tool-list refresh notification');
  assert.ok(tools.tools.some((tool) => tool.name === "flow_status"));
  const result = await client.callTool({ name: "flow_status", arguments: {} });
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.status, "ready");
  assert.equal(result.structuredContent.recordingAvailable, true);
  const saved = JSON.parse(await fs.readFile(evidence, "utf8"));
  assert.equal(saved.client.name, "flow-sdk-verification");
  assert.ok(saved.initializedAt);
  assert.ok(saved.lastCallAt);
  assert.equal(saved.lastTool, "flow_status");
  assert.equal(stderr, "");
});

test("official MCP calls create project/conversation and record one pair exactly once with durable receipt", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-mcp-call-"));
  const client = new Client({ name: "flow-sdk-integration", version: "1" }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("server/mcp/stdio.mjs")],
      env: {
        ...process.env,
        VIEWER_DB: path.join(dir, "state.sqlite"),
        FLOW_MCP_EVIDENCE: path.join(dir, "probe.json"),
      },
      stderr: "pipe",
    });
  t.after(async () => {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await client.connect(transport);
  const call = async (name, args) =>
    await client.callTool({ name, arguments: args });
  const p = (
    await call("flow_create_project", {
      name: "MCP 시험",
      requestId: randomUUID(),
    })
  ).structuredContent;
  const c = (
    await call("flow_start_conversation", {
      projectId: p.projectId,
      title: "직접 수신",
      requestId: randomUUID(),
    })
  ).structuredContent;
  const args = {
    conversationId: c.conversationId,
    question: "SDK 질문",
    answer: "SDK 답변",
    summary: "별도 요약",
    requestId: randomUUID(),
  };
  const a = await call("flow_record", args),
    b = await call("flow_record", args);
  assert.equal(a.structuredContent.saved, true);
  assert.equal(b.structuredContent.duplicate, true);
  const conflict = await call("flow_record", { ...args, answer: "충돌" });
  assert.equal(conflict.isError, true);
  const bad = await call("flow_record", { ...args, command: "never-run" });
  assert.equal(bad.isError, true);
  const status = (await call("flow_status", {})).structuredContent;
  assert.equal(status.recordCount, 1);
  assert.ok(status.lastReceivedAt);
});

test("two independent MCP processes serialize the same retry and preserve distinct simultaneous records", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-mcp-race-")),
    clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (let n = 0; n < 2; n++) {
    const c = new Client({ name: "flow-concurrency-" + n, version: "1" });
    clients.push(c);
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("server/mcp/stdio.mjs")],
        env: {
          ...process.env,
          VIEWER_DB: path.join(dir, "shared.sqlite"),
          FLOW_MCP_EVIDENCE: path.join(dir, "probe-" + n + ".json"),
        },
        stderr: "pipe",
      }),
    );
  }
  const call = async (c, name, args) => {
    const r = await c.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
    return r.structuredContent;
  };
  const p = await call(clients[0], "flow_create_project", {
      name: "동시 수신",
      requestId: randomUUID(),
    }),
    c = await call(clients[0], "flow_start_conversation", {
      projectId: p.projectId,
      title: "동시 시험",
      requestId: randomUUID(),
    });
  const value = {
    conversationId: c.conversationId,
    question: "동일 질문",
    answer: "동일 답변",
    requestId: randomUUID(),
  };
  const repeated = await Promise.all(
    clients.map((client) => call(client, "flow_record", value)),
  );
  assert.equal(repeated.filter((r) => r.duplicate).length, 1);
  await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      call(clients[n % 2], "flow_record", {
        ...value,
        requestId: randomUUID(),
        answer: "답변 " + n,
      }),
    ),
  );
  assert.equal((await call(clients[0], "flow_status", {})).recordCount, 9);
});
