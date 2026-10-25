import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const directSchemas = {
  project: z
    .object({ name: z.string().trim().min(1).max(200), requestId: uuid })
    .strict(),
  conversation: z
    .object({
      projectId: uuid,
      title: z.string().trim().min(1).max(500),
      requestId: uuid,
    })
    .strict(),
  record: z
    .object({
      conversationId: uuid,
      question: z.string().min(1).max(100000),
      answer: z.string().min(1).max(500000),
      summary: z.string().max(5000).optional().default(""),
      requestId: uuid,
    })
    .strict(),
};
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const title = (text) => text.replace(/\s+/g, " ").trim().slice(0, 90);

export class DirectRecords extends EventEmitter {
  #sessions = new Map();
  #signature = "";
  constructor(store) {
    super();
    this.store = store;
    this.error = null;
    store.db.exec(`
 PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS flow_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS flow_conversations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES flow_projects(id),title TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS flow_records(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES flow_conversations(id),question TEXT NOT NULL,answer TEXT NOT NULL,summary TEXT NOT NULL,received_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS flow_records_conversation ON flow_records(conversation_id,seq);
 CREATE TABLE IF NOT EXISTS flow_receipts(request_id TEXT PRIMARY KEY,operation TEXT NOT NULL,payload_hash TEXT NOT NULL,result_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS flow_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,version TEXT NOT NULL,initialized_at TEXT NOT NULL,last_seen TEXT NOT NULL,last_call_at TEXT,last_tool TEXT);
 `);
  }
  #parse(schema, input) {
    const result = schema.safeParse(input);
    if (!result.success)
      throw new Error(
        "수신 입력을 확인해 주세요: " +
          result.error.issues
            .map((i) => i.path.join(".") + ": " + i.message)
            .join("; "),
      );
    return result.data;
  }
  #commit(operation, input, work) {
    return this.store.transaction(() => {
      const digest = hash(input),
        existing = this.store.db
          .prepare("SELECT * FROM flow_receipts WHERE request_id=?")
          .get(input.requestId);
      if (existing) {
        if (
          existing.operation !== operation ||
          existing.payload_hash !== digest
        )
          throw new Error(
            "같은 재시도 키의 내용이 충돌합니다. 새 기록이면 새 requestId를 사용하세요.",
          );
        return { ...JSON.parse(existing.result_json), duplicate: true };
      }
      const result = work(new Date().toISOString());
      this.store.db
        .prepare("INSERT INTO flow_receipts VALUES(?,?,?,?)")
        .run(input.requestId, operation, digest, JSON.stringify(result));
      return { ...result, duplicate: false };
    });
  }
  projects() {
    return this.store.db
      .prepare(
        "SELECT p.id,p.name,p.created_at AS createdAt,(SELECT COUNT(*) FROM flow_conversations c WHERE c.project_id=p.id) AS conversationCount FROM flow_projects p ORDER BY p.created_at,p.rowid",
      )
      .all()
      .map((p) => ({ ...p }));
  }
  createProject(input) {
    const value = this.#parse(directSchemas.project, input);
    return this.#commit("project", value, (now) => {
      const projectId = randomUUID();
      this.store.db
        .prepare("INSERT INTO flow_projects VALUES(?,?,?)")
        .run(projectId, value.name, now);
      return {
        saved: true,
        projectId,
        name: value.name,
        receiptId: value.requestId,
        receivedAt: now,
      };
    });
  }
  startConversation(input) {
    const value = this.#parse(directSchemas.conversation, input);
    return this.#commit("conversation", value, (now) => {
      if (!this.projects().some((p) => p.id === value.projectId))
        throw new Error("등록된 직접 연결 프로젝트를 찾을 수 없습니다.");
      const conversationId = randomUUID();
      this.store.db
        .prepare("INSERT INTO flow_conversations VALUES(?,?,?,?)")
        .run(conversationId, value.projectId, value.title, now);
      return {
        saved: true,
        projectId: value.projectId,
        conversationId,
        title: value.title,
        receiptId: value.requestId,
        receivedAt: now,
      };
    });
  }
  record(input) {
    const value = this.#parse(directSchemas.record, input);
    return this.#commit("record", value, (now) => {
      const conversation = this.store.db
        .prepare("SELECT project_id FROM flow_conversations WHERE id=?")
        .get(value.conversationId);
      if (!conversation)
        throw new Error("등록된 직접 연결 대화를 찾을 수 없습니다.");
      this.store.db
        .prepare(
          "INSERT INTO flow_records(id,conversation_id,question,answer,summary,received_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          value.requestId,
          value.conversationId,
          value.question,
          value.answer,
          value.summary,
          now,
        );
      return {
        saved: true,
        projectId: conversation.project_id,
        conversationId: value.conversationId,
        sessionId: "mcp:" + value.conversationId,
        receiptId: value.requestId,
        receivedAt: now,
      };
    });
  }
  clientInitialized(id, client) {
    const now = new Date().toISOString();
    this.store.db
      .prepare("INSERT OR REPLACE INTO flow_clients VALUES(?,?,?,?,?,?,?)")
      .run(
        id,
        String(client?.name || "unknown").slice(0, 200),
        String(client?.version || "unknown").slice(0, 100),
        now,
        now,
        null,
        null,
      );
  }
  clientSeen(id, tool) {
    const now = new Date().toISOString();
    if (tool)
      this.store.db
        .prepare(
          "UPDATE flow_clients SET last_seen=?,last_call_at=?,last_tool=? WHERE id=?",
        )
        .run(now, now, tool, id);
    else
      this.store.db
        .prepare("UPDATE flow_clients SET last_seen=? WHERE id=?")
        .run(now, id);
  }
  clientClosed(id) {
    this.store.db
      .prepare("UPDATE flow_clients SET last_seen=? WHERE id=?")
      .run("1970-01-01T00:00:00.000Z", id);
  }
  status() {
    const now = Date.now(),
      clients = this.store.db
        .prepare(
          "SELECT name,version,initialized_at AS initializedAt,last_seen AS lastSeen,last_call_at AS lastCallAt,last_tool AS lastTool FROM flow_clients ORDER BY initialized_at DESC",
        )
        .all();
    const activeClients = clients.filter(
        (c) => now - Date.parse(c.lastSeen) < 35000,
      ),
      records = this.store.db
        .prepare(
          "SELECT COUNT(*) AS count,MAX(received_at) AS latest FROM flow_records",
        )
        .get();
    return {
      status: "ready",
      recordingAvailable: true,
      activeClients: activeClients.map((c) => ({ ...c })),
      lastInitializedAt: clients[0]?.initializedAt || null,
      lastToolCallAt:
        clients
          .map((c) => c.lastCallAt)
          .filter(Boolean)
          .sort()
          .at(-1) || null,
      recordCount: records.count,
      lastReceivedAt: records.latest || null,
      projectCount: this.projects().length,
    };
  }
  async refresh() {
    try {
      const next = this.store.transaction(() => {
        const conversations = this.store.db
            .prepare(
              "SELECT c.*,p.name AS project_name FROM flow_conversations c JOIN flow_projects p ON p.id=c.project_id ORDER BY c.created_at,c.rowid",
            )
            .all(),
          rows = this.store.db
            .prepare("SELECT * FROM flow_records ORDER BY seq")
            .all();
        return new Map(
          conversations.map((c) => {
            const s = this.#session(
              c,
              rows.filter((r) => r.conversation_id === c.id),
            );
            return [s.id, s];
          }),
        );
      });
      const signature = hash([...next].map(([id, s]) => [id, s.revision]));
      const changed = signature !== this.#signature || this.error;
      this.#sessions = next;
      this.#signature = signature;
      this.error = null;
      if (changed) this.emit("change", { sourceKind: "chatgpt-mcp" });
    } catch (error) {
      this.error =
        "직접 수신 기록을 읽지 못했습니다. 마지막 정상 화면을 유지합니다. " +
        error.message;
      this.emit("change", { sourceKind: "chatgpt-mcp", error: this.error });
    }
  }
  list(projectId) {
    return [...this.#sessions.values()]
      .filter((s) => s.mcpProjectId === projectId)
      .map((s) => ({
        id: s.id,
        title: s.title,
        project: s.project,
        sourceKind: s.sourceKind,
        turnCount: s.turns.length,
        taskCount: s.turns.length,
        status: "unknown",
        revision: s.revision,
        latestTimestamp: s.latestTimestamp,
      }))
      .sort((a, b) =>
        (b.latestTimestamp || "").localeCompare(a.latestTimestamp || ""),
      );
  }
  get(id) {
    return this.#sessions.get(id);
  }
  #session(c, rows) {
    const id = "mcp:" + c.id,
      sourcePath = this.store.filename || "SQLite 수신 기록",
      evidence = [];
    const turns = rows.map((row) => {
      const turnId = id + ":turn:" + row.id,
        questionId = turnId + ":question",
        answerId = turnId + ":answer",
        evidenceIds = [questionId, answerId];
      const base = {
        turnId,
        sourcePath,
        line: 0,
        timestamp: row.received_at,
        status: null,
        sourceKind: "chatgpt-mcp",
        receiverReference: {
          receiptId: row.id,
          conversationId: c.id,
          receivedAt: row.received_at,
        },
      };
      evidence.push(
        {
          ...base,
          id: questionId,
          kind: "request",
          text: row.question,
          phase: null,
        },
        {
          ...base,
          id: answerId,
          kind: "message",
          text: row.answer,
          phase: "final_answer",
        },
      );
      if (row.summary) {
        const summaryId = turnId + ":summary";
        evidenceIds.push(summaryId);
        evidence.push({
          ...base,
          id: summaryId,
          kind: "mcp-summary",
          text: row.summary,
          phase: null,
        });
      }
      return {
        id: turnId,
        title: title(row.question),
        requests: [{ id: questionId, text: row.question, line: 0 }],
        tasks: [
          {
            id: answerId,
            turnId,
            title: title(row.answer),
            text: row.answer,
            files: [],
            evidenceIds: [answerId],
            status: "unknown",
            verification: "none",
            grouping: "mcp-received",
            kind: "description",
            sourceKind: "chatgpt-mcp",
          },
        ],
        plans: [],
        artifacts: [],
        result: row.answer,
        receivedSummary: row.summary,
        status: "unknown",
        evidenceIds,
        sourceKind: "chatgpt-mcp",
      };
    });
    return {
      id,
      title: c.title,
      project: c.project_name,
      mcpProjectId: c.project_id,
      sourceKind: "chatgpt-mcp",
      sourcePath,
      version: "mcp-record-v1",
      originator: "MCP 전달 기록",
      turns,
      evidence,
      revision: hash({ c, rows }),
      latestTimestamp: rows.at(-1)?.received_at || c.created_at,
      pendingBytes: 0,
      invalidLines: [],
      limitations: [
        "MCP 도구로 전달받은 내용입니다. ChatGPT 전체 대화 원문 또는 누락 없는 자동 수집을 보장하지 않습니다.",
        "표시된 시각과 ID는 뷰어의 수신 시각·수신 ID입니다. 파일 변경·명령 실행은 이 입력에서 확인하지 않습니다.",
      ],
      loadedAt: new Date().toISOString(),
    };
  }
}
