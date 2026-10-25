import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ViewerStore } from "../store.mjs";
import { DirectRecords, directSchemas } from "./records.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const filename =
  process.env.FLOW_MCP_EVIDENCE ||
  path.join(root, ".local/mcp-direct", `probe-${process.pid}.json`);
const store = new ViewerStore(
  process.env.VIEWER_DB || path.join(root, ".local/viewer.sqlite"),
);
const records = new DirectRecords(store),
  instanceId = randomUUID();
const evidence = {
  schemaVersion: 1,
  server: "flow-viewer",
  serverVersion: "0.2.1",
  processId: process.pid,
  startedAt: new Date().toISOString(),
  client: null,
  initializedAt: null,
  lastCallAt: null,
  lastTool: null,
};
const save = () => {
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const tmp = filename + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(evidence, null, 2) + "\n");
    fs.renameSync(tmp, filename);
  } catch (error) {
    process.stderr.write("MCP diagnostic: " + error.message + "\n");
  }
};
const server = new McpServer(
  { name: "flow-viewer", version: "0.2.1" },
  {
    maxToolInputElements: 30,
    instructions:
      "Save selected questions and answers to the local flow viewer. First flow_list_projects; create a project only when requested; flow_start_conversation returns a receiver conversationId. Use flow_record for each selected question/answer pair. Use a UUID requestId and reuse it when retrying identical content. Store only text explicitly intended for this viewer. Summaries are separate from received bodies. Never claim complete ChatGPT history, source message IDs, file changes or execution verification. Tool success means the SQLite transaction committed.",
  },
);
server.server.oninitialized = () => {
  evidence.client = server.server.getClientVersion() || null;
  evidence.initializedAt = new Date().toISOString();
  records.clientInitialized(instanceId, evidence.client);
  save();
  // A reconnect can follow an upgrade from the one-tool connection probe.
  void server.server.sendToolListChanged().catch(error=>process.stderr.write('MCP tool-list refresh: '+error.message+'\n'));
};
const heartbeat = setInterval(() => {
  if (evidence.initializedAt) records.clientSeen(instanceId);
}, 10000);
heartbeat.unref();
let closed = false;
const close = () => {
  if (closed) return;
  closed = true;
  clearInterval(heartbeat);
  try {
    records.clientClosed(instanceId);
  } finally {
    store.close();
  }
};
server.server.onclose = close;
process.on("exit", close);
process.on("SIGTERM", () => {
  close();
  process.exit(0);
});
process.on("SIGINT", () => {
  close();
  process.exit(0);
});
function tool(name, title, description, schema, readOnly, work) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: schema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        records.clientSeen(instanceId, name);
        const value = work(input);
        evidence.lastCallAt = new Date().toISOString();
        evidence.lastTool = name;
        save();
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
      }
    },
  );
}
tool(
  "flow_status",
  "작업 흐름 뷰어 연결 확인",
  "Check local receiver readiness, recent MCP connections and the last saved receipt. Does not read ChatGPT history.",
  z.object({}).strict(),
  true,
  () => ({ ...records.status(), initialized: !!evidence.initializedAt }),
);
tool(
  "flow_list_projects",
  "작업 흐름 프로젝트 목록",
  "List exact local viewer project IDs. Use an ID rather than merging similar names.",
  z.object({}).strict(),
  true,
  () => ({ projects: records.projects() }),
);
tool(
  "flow_create_project",
  "작업 흐름 프로젝트 만들기",
  "Create a viewer project when requested. UUID requestId deduplicates retries; same names can be different projects.",
  directSchemas.project,
  false,
  (input) => records.createProject(input),
);
tool(
  "flow_start_conversation",
  "작업 흐름 대화 시작",
  "Start a receiver conversation in an exact projectId. Reuse returned conversationId; it is not a ChatGPT source thread ID.",
  directSchemas.conversation,
  false,
  (input) => records.startConversation(input),
);
tool(
  "flow_record",
  "질문·답변을 작업 흐름에 기록",
  "Save a selected question and answer. Keep optional summary separate. Reuse UUID requestId for identical retries. Do not send secrets, hidden instructions, or fabricate omitted source text.",
  directSchemas.record,
  false,
  (input) => records.record(input),
);
await server.connect(new StdioServerTransport());
