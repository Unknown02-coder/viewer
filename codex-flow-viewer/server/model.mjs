import path from "node:path";
import { createHash } from "node:crypto";

const withoutNamespace = (value) =>
  value
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//, "");

export function canonicalProject(value) {
  if (!value) return "";
  value = withoutNamespace(value);
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("//");
  const normalized = (
    windows ? path.win32.normalize(value) : path.resolve(value)
  )
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  return windows || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

export function flattenText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) =>
        block &&
        ["text", "input_text", "output_text"].includes(
          String(block.type).toLowerCase(),
        ),
    )
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

const short = (text, limit = 56) =>
  text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
const relative = (file, project) => {
  const normalized = withoutNamespace(file);
  const base = withoutNamespace(project).replace(/\/+$/, "");
  return canonicalProject(normalized).startsWith(canonicalProject(base) + "/")
    ? normalized.slice(base.length + 1)
    : normalized;
};

function linkedArtifacts(text, evidenceId) {
  const artifacts = [];
  for (const match of text.matchAll(/\[([^\]]+)\]\(<?([^\n)]+?)>?\)/g)) {
    let target = match[2].trim();
    try {
      target = decodeURIComponent(target);
    } catch {
      /* Keep literal malformed URI. */
    }
    if (
      /^[a-z][a-z\d+.-]*:\/\//i.test(target) ||
      !/[.][a-z\d]{1,10}(?::\d+)?$/i.test(target)
    )
      continue;
    artifacts.push({
      id: `${evidenceId}:link:${artifacts.length}`,
      label: match[1],
      path: target,
      kind: "linked",
      evidenceId,
    });
  }
  return artifacts;
}

function fileChanges(item, evidence, project) {
  const changes = Array.isArray(item.changes)
    ? item.changes.map((c) => [c.path, c])
    : Object.entries(item.changes || {});
  return changes
    .filter(([name, c]) => name && c && typeof c === "object")
    .map(([name, c]) => {
      const diff =
        typeof c.unified_diff === "string"
          ? c.unified_diff
          : typeof c.diff === "string"
            ? c.diff
            : "";
      const content = typeof c.content === "string" ? c.content : "";
      const kind =
        typeof c.type === "string"
          ? c.type
          : typeof c.kind === "string"
            ? c.kind
            : c.kind?.type || "unknown";
      const lines = diff.split(/\r?\n/);
      const added = diff
        ? lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
        : kind === "add" && content
          ? content.replace(/\r?\n$/, "").split(/\r?\n/).length
          : null;
      const removed = diff
        ? lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length
        : null;
      return {
        id: `${evidence.id}:${canonicalProject(name)}`,
        path: name,
        relativePath: relative(name, project),
        kind,
        diff,
        content,
        added,
        removed,
        evidenceId: evidence.id,
        status: item.status,
      };
    });
}

/** Derived display groups are chronological buckets, never inferred dependencies. */
export function normalizeRecords(records, sourcePath) {
  const meta =
    records.find((r) => r.row.type === "session_meta")?.row.payload || {};
  const project =
    records.findLast(
      ({ row }) =>
        row.type === "turn_context" &&
        typeof row.payload?.cwd === "string" &&
        row.payload.cwd.trim(),
    )?.row.payload.cwd ||
    meta.cwd ||
    "";
  const sessionId =
    meta.id ||
    meta.session_id ||
    createHash("sha256").update(sourcePath).digest("hex").slice(0, 24);
  const turns = new Map();
  const evidenceMap = new Map();
  let activeTurn = null;
  let latestTimestamp = null;
  let unsupported = 0;
  const getTurn = (id) => {
    if (!turns.has(id))
      turns.set(id, {
        id,
        requests: [],
        tasks: [],
        plans: [],
        artifacts: [],
        result: "",
        status: "unknown",
        startedAt: null,
        completedAt: null,
        evidenceIds: [],
      });
    return turns.get(id);
  };
  for (const { row, line } of records) {
    const p = row.payload;
    if (!p || typeof p !== "object") continue;
    if (row.timestamp) latestTimestamp = row.timestamp;
    if (row.type === "turn_context") {
      activeTurn = p.turn_id || activeTurn;
      continue;
    }
    if (row.type !== "event_msg") continue;
    const turnId = p.turn_id || activeTurn;
    if (!turnId) {
      unsupported++;
      continue;
    }
    activeTurn = turnId;
    const turn = getTurn(turnId);
    const type = String(p.type || "");
    if (type === "task_started") {
      if (turn.status === "unknown") turn.status = "running";
      turn.startedAt = p.started_at || row.timestamp;
      continue;
    }
    if (["task_complete", "turn_completed"].includes(type)) {
      turn.status = "completed";
      turn.completedAt = p.completed_at || row.timestamp;
      continue;
    }
    if (
      [
        "turn_aborted",
        "task_aborted",
        "turn_cancelled",
        "task_cancelled",
      ].includes(type)
    ) {
      turn.status = "interrupted";
      continue;
    }
    if (["turn_failed", "task_failed"].includes(type)) {
      turn.status = "failed";
      continue;
    }
    let item = p.item;
    if (type === "user_message")
      item = {
        type: "UserMessage",
        id: p.id || `line-${line}`,
        content: p.message,
      };
    if (type === "agent_message")
      item = {
        type: "AgentMessage",
        id: p.id || `line-${line}`,
        content: p.message,
        phase: p.phase || "commentary",
      };
    if (
      !item ||
      ![
        "item_completed",
        "item_started",
        "user_message",
        "agent_message",
      ].includes(type)
    )
      continue;
    const itemType = String(item.type || "")
      .replaceAll("_", "")
      .toLowerCase();
    if (
      ![
        "usermessage",
        "agentmessage",
        "filechange",
        "commandexecution",
        "subagentactivity",
      ].includes(itemType)
    )
      continue;
    const id = `${turnId}:${item.id || `line-${line}`}`;
    const existing = evidenceMap.get(id);
    // A later completed event may replace a started event, but repeated completed records do not duplicate it.
    if (
      existing &&
      (existing.lifecycle === "item_completed" || type !== "item_completed")
    )
      continue;
    const evidence = {
      id,
      turnId,
      sourcePath,
      line,
      timestamp: row.timestamp || null,
      kind: "",
      text: "",
      phase: item.phase || null,
      lifecycle: type,
      status: item.status || (type === "item_started" ? "running" : null),
    };
    if (itemType === "usermessage") {
      evidence.kind = "request";
      evidence.text = flattenText(item.content);
    }
    if (itemType === "agentmessage") {
      evidence.kind = "message";
      evidence.text =
        flattenText(item.content) ||
        (typeof item.text === "string" ? item.text : "");
    }
    if (itemType === "commandexecution") {
      evidence.kind = "command";
      evidence.command =
        typeof item.command === "string"
          ? item.command
          : Array.isArray(item.command)
            ? item.command.join(" ")
            : "";
      evidence.text =
        typeof item.aggregated_output === "string"
          ? item.aggregated_output
          : "";
      evidence.exitCode = item.exit_code ?? null;
    }
    if (itemType === "filechange") {
      evidence.kind = "file";
      evidence.attemptedFiles = fileChanges(item, evidence, project);
      evidence.files = ["completed", "succeeded"].includes(item.status)
        ? evidence.attemptedFiles
        : [];
      evidence.text = evidence.attemptedFiles.length
        ? evidence.attemptedFiles
            .map((f) => `${f.kind}: ${f.relativePath}`)
            .join("\n")
        : "기록된 파일 변경 내용 없음";
    }
    if (itemType === "subagentactivity") {
      evidence.kind = "subagent";
      evidence.text = `하위 실행 ${item.kind || "상태 미확인"}`;
      evidence.childId = item.agent_thread_id || null;
    }
    evidenceMap.set(id, evidence);
  }
  const evidence = [...evidenceMap.values()].sort((a, b) => a.line - b.line);
  for (const turn of turns.values()) {
    const events = evidence.filter((e) => e.turnId === turn.id);
    let task = null;
    for (const e of events) {
      turn.evidenceIds.push(e.id);
      if (e.kind === "request") {
        turn.requests.push({ id: e.id, text: e.text, line: e.line });
        continue;
      }
      if (e.kind === "message") {
        turn.artifacts.push(...linkedArtifacts(e.text, e.id));
        const proposed = [
          ...e.text.matchAll(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/g),
        ];
        const explicitPlan =
          /^\s*(?:#{1,6}\s*)?(?:계획|예정 작업)\s*[:：\n]/.test(e.text);
        if (proposed.length || explicitPlan) {
          turn.plans.push({
            id: e.id,
            text: proposed.length
              ? proposed.map((p) => p[1].trim()).join("\n\n")
              : e.text,
            evidenceId: e.id,
          });
          continue;
        }
        if (["final_answer", "final"].includes(e.phase)) {
          turn.result = e.text;
          continue;
        }
        if (!e.text.trim()) continue;
        task = {
          id: e.id,
          turnId: turn.id,
          title: short(e.text),
          text: e.text,
          files: [],
          evidenceIds: [e.id],
          status: turn.status,
          verification: "none",
          grouping: "chronological",
        };
        turn.tasks.push(task);
      } else {
        if (!task) {
          task = {
            id: `${turn.id}:execution`,
            turnId: turn.id,
            title: "실행 기록",
            text: "연결할 진행 설명이 없어 실행 기록을 시간순으로 묶었습니다.",
            files: [],
            evidenceIds: [],
            status: turn.status,
            verification: "none",
            grouping: "chronological",
          };
          turn.tasks.push(task);
        }
        task.evidenceIds.push(e.id);
        if (e.kind === "file") task.files.push(...e.files);
      }
    }
    if (!turn.tasks.length && turn.result) {
      const final = events.findLast(
        (e) =>
          e.kind === "message" && ["final_answer", "final"].includes(e.phase),
      );
      turn.tasks.push({
        id: final.id,
        turnId: turn.id,
        title: short(turn.result),
        text: turn.result,
        files: [],
        evidenceIds: [final.id],
        status: turn.status,
        verification: "none",
        grouping: "chronological",
      });
    }
    for (const task of turn.tasks) {
      const hasExecution = task.evidenceIds.some((id) =>
        events.some(
          (e) =>
            e.id === id && ["command", "file", "subagent"].includes(e.kind),
        ),
      );
      task.kind = hasExecution ? "execution" : "description";
      if (!hasExecution) task.status = "unknown";
    }
    turn.title = short(turn.requests[0]?.text || "요청 원문 없음", 80);
    turn.artifacts = turn.artifacts.filter(
      (a, i, all) => all.findIndex((b) => b.path === a.path) === i,
    );
  }
  return {
    id: sessionId,
    parentThreadId: meta.parent_thread_id || null,
    threadSource: meta.thread_source || "unknown",
    sharedSessionId: meta.session_id || null,
    project,
    creationProject: meta.cwd || "",
    sourcePath,
    version: meta.cli_version || "미확인",
    originator: meta.originator || "미확인",
    turns: [...turns.values()],
    evidence,
    latestTimestamp,
    unsupported,
  };
}
