import { createHash } from "node:crypto";

export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const fail = (message) => {
  throw Object.assign(new Error(message), { code: "INVALID_SNAPSHOT" });
};
const id = (value) => {
  try {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      encodeURIComponent(value).length <= 300 &&
      !/[\u0000-\u001f]/.test(value)
    );
  } catch {
    return false;
  }
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const short = (text) =>
  text.replace(/[#*`]/g, "").replace(/\s+/g, " ").trim().slice(0, 90);
const iso = (seconds) =>
  typeof seconds === "number" &&
  Number.isFinite(seconds) &&
  Math.abs(seconds) < 8.64e12
    ? new Date(seconds * 1000).toISOString()
    : null;

export function decodeSnapshot(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.length || bytes.length > MAX_SNAPSHOT_BYTES)
    fail("사본 파일은 50MiB 이하의 JSON이어야 합니다.");
  let bundle;
  try {
    bundle = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    fail("JSON 사본 파일을 읽을 수 없습니다.");
  }
  if (
    !object(bundle) ||
    bundle.format !== "codex-flow.chatgpt-snapshot" ||
    bundle.schemaVersion !== 1
  )
    fail("지원하는 ChatGPT 사본 형식(v1)이 아닙니다.");
  if (
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      bundle.sourceInstanceId || "",
    )
  )
    fail("사본의 수집 출처 ID가 올바르지 않습니다.");
  if (
    typeof bundle.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(bundle.capturedAt))
  )
    fail("사본의 수집 시각이 올바르지 않습니다.");
  if (
    !Array.isArray(bundle.pages) ||
    !bundle.pages.length ||
    bundle.pages.length > 500
  )
    fail("사본에는 1~500개의 기록 페이지가 필요합니다.");
  let thread, previous, nextCursor;
  const issues = [],
    turns = [],
    turnMap = new Map(),
    seenCursors = new Set();
  let traversal = "complete",
    textCoverage = "complete",
    truncatedMessages = 0,
    totalItems = 0;
  for (let pageIndex = 0; pageIndex < bundle.pages.length; pageIndex++) {
    const envelope = bundle.pages[pageIndex];
    if (
      !object(envelope) ||
      !object(envelope.request) ||
      !object(envelope.result) ||
      envelope.result.isError === true
    )
      fail("대화 페이지에 읽기 오류가 있습니다.");
    if (
      !Number.isInteger(envelope.request.maxOutputCharsPerItem) ||
      envelope.request.maxOutputCharsPerItem < 1 ||
      envelope.request.maxOutputCharsPerItem > 20000
    )
      fail("관측한 메시지 출력 한도가 필요합니다(1~20,000).");
    if (
      typeof envelope.receivedAt !== "string" ||
      !Number.isFinite(Date.parse(envelope.receivedAt))
    )
      fail("페이지의 수집 시각이 올바르지 않습니다.");
    const blocks = envelope.result.content;
    if (
      !Array.isArray(blocks) ||
      blocks.length !== 1 ||
      blocks[0]?.type !== "text" ||
      typeof blocks[0].text !== "string"
    )
      fail("대화 페이지 응답 형식이 올바르지 않습니다.");
    let doc;
    try {
      doc = JSON.parse(blocks[0].text);
    } catch {
      fail("대화 페이지의 원본 JSON을 읽지 못했습니다.");
    }
    if (
      !object(doc) ||
      doc.schemaVersion !== 1 ||
      !object(doc.thread) ||
      doc.thread.kind !== "chatgpt" ||
      !id(doc.thread.id) ||
      typeof doc.thread.title !== "string" ||
      doc.thread.title.length > 5000
    )
      fail("ChatGPT 대화 정보가 올바르지 않습니다.");
    if (doc.thread.id !== envelope.request.threadId)
      fail("요청과 원본 대화 ID가 일치하지 않습니다.");
    if (thread && doc.thread.id !== thread.id)
      fail("서로 다른 대화의 페이지를 합칠 수 없습니다.");
    if (thread && doc.thread.updatedAt !== thread.updatedAt) {
      traversal = "partial";
      issues.push("수집 중 대화 정보가 변경됐습니다.");
    }
    thread ??= doc.thread;
    if (
      !object(doc.page) ||
      doc.page.order !== "newest_first" ||
      typeof doc.page.hasMore !== "boolean" ||
      !Array.isArray(doc.turns)
    )
      fail("대화 페이지 순서 정보가 올바르지 않습니다.");
    if (pageIndex === 0 && envelope.request.cursor) {
      traversal = "partial";
      issues.push("최신 페이지부터 읽은 사본이 아닙니다.");
    }
    if (
      pageIndex > 0 &&
      (!previous.hasMore || envelope.request.cursor !== nextCursor)
    )
      fail("대화 페이지 연결이 끊겼습니다.");
    if (envelope.request.cursor) {
      if (seenCursors.has(envelope.request.cursor))
        fail("같은 페이지 커서가 반복됩니다.");
      seenCursors.add(envelope.request.cursor);
    }
    if (doc.page.hasMore && (!id(doc.page.nextCursor) || !doc.turns.length))
      fail("이전 대화 페이지의 커서가 없습니다.");
    if (!doc.page.hasMore && doc.page.nextCursor != null)
      fail("마지막 페이지의 커서 정보가 올바르지 않습니다.");
    previous = doc.page;
    nextCursor = doc.page.nextCursor;
    for (let turnIndex = 0; turnIndex < doc.turns.length; turnIndex++) {
      const raw = doc.turns[turnIndex];
      if (!object(raw) || !id(raw.id) || !Array.isArray(raw.items))
        fail("질문·답변 묶음의 ID나 항목이 올바르지 않습니다.");
      if (turnMap.has(raw.id)) {
        if (JSON.stringify(turnMap.get(raw.id)) !== JSON.stringify(raw))
          fail("같은 묶음 ID의 내용이 충돌합니다.");
        continue;
      }
      turnMap.set(raw.id, raw);
      if (raw.completedAt < raw.startedAt)
        issues.push(
          "원본 시각이 일치하지 않는 묶음이 있어 소요 시간을 추정하지 않습니다.",
        );
      const items = [],
        itemMap = new Map();
      for (let itemIndex = 0; itemIndex < raw.items.length; itemIndex++) {
        if (++totalItems > 50000) fail("한 사본의 메시지 수가 너무 많습니다.");
        const item = raw.items[itemIndex];
        if (!object(item) || !id(item.id))
          fail("메시지 ID가 올바르지 않습니다.");
        if (itemMap.has(item.id)) {
          if (JSON.stringify(itemMap.get(item.id)) !== JSON.stringify(item))
            fail("중복 메시지 ID의 내용이 충돌합니다.");
          continue;
        }
        itemMap.set(item.id, item);
        if (!["userMessage", "agentMessage"].includes(item.type)) {
          textCoverage = "partial";
          issues.push("표시하지 못한 메시지 유형이 있습니다.");
          continue;
        }
        let text = "";
        if (item.type === "agentMessage") {
          if (typeof item.text !== "string")
            fail("답변 본문 형식이 올바르지 않습니다.");
          text = item.text;
        } else {
          if (!Array.isArray(item.content))
            fail("질문 본문 형식이 올바르지 않습니다.");
          const texts = [];
          for (const block of item.content) {
            if (block?.type === "text" && typeof block.text === "string")
              texts.push(block.text);
            else {
              textCoverage = "partial";
              issues.push(
                "일부 질문의 첨부 또는 본문 블록을 표시하지 못했습니다.",
              );
            }
          }
          text = texts.join("\n");
        }
        const limit = envelope.request.maxOutputCharsPerItem;
        const truncated =
          item.truncated === true ||
          (Number.isFinite(limit) && limit > 0 && text.length >= limit);
        if (truncated) {
          truncatedMessages++;
          textCoverage = "partial";
        }
        items.push({
          id: item.id,
          role: item.type === "userMessage" ? "user" : "assistant",
          text,
          truncated,
          reference: {
            page: pageIndex,
            turnIndex,
            itemIndex,
            turnId: raw.id,
            itemId: item.id,
          },
        });
      }
      turns.push({
        id: raw.id,
        status: raw.status,
        startedAt: raw.startedAt ?? null,
        completedAt: raw.completedAt ?? null,
        items,
      });
    }
  }
  if (previous.hasMore) {
    traversal = "partial";
    issues.push("이전 기록을 끝까지 읽지 못한 사본입니다.");
  }
  if (
    !turns.length ||
    !turns.some((turn) => turn.items.some((item) => item.role === "user"))
  )
    fail("표시할 사용자 질문이 없는 사본입니다.");
  if (truncatedMessages)
    issues.push(`답변·질문 ${truncatedMessages}개가 일부만 가져와졌습니다.`);
  issues.push(
    "이미지·첨부 원본과 숨은 분기는 수집 범위에 포함됐다고 보장하지 않습니다.",
  );
  const coverage = { traversal, text: textCoverage, truncatedMessages };
  turns.reverse();
  const result = {
    bundle,
    id: `chatgpt:${bundle.sourceInstanceId.toLowerCase()}:${encodeURIComponent(thread.id)}`,
    threadId: thread.id,
    title: thread.title,
    sourceInstanceId: bundle.sourceInstanceId.toLowerCase(),
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : null,
    capturedAt: bundle.capturedAt,
    coverage,
    turns,
    issues: [...new Set(issues)],
  };
  result.digest = hash(
    JSON.stringify({
      title: result.title,
      turns: turns.map((turn) => ({
        ...turn,
        items: turn.items.map(({ reference, ...item }) => item),
      })),
      coverage,
    }),
  );
  return result;
}

export function toSession(snapshot, { sourcePath, snapshotId, importedAt }) {
  const evidence = [];
  const turns = snapshot.turns.map((raw) => {
    const turnId = `${snapshot.id}:turn:${encodeURIComponent(raw.id)}`,
      requests = [],
      tasks = [],
      evidenceIds = [];
    const status = ["running", "completed", "failed", "interrupted"].includes(
      raw.status,
    )
      ? raw.status
      : "unknown";
    for (const item of raw.items) {
      const evidenceId = `${turnId}:message:${encodeURIComponent(item.id)}`;
      const entry = {
        id: evidenceId,
        turnId,
        sourcePath,
        line: 0,
        timestamp: iso(raw.startedAt),
        kind: item.role === "user" ? "request" : "message",
        text: item.text,
        phase: item.role === "assistant" ? "final_answer" : null,
        status,
        sourceKind: "chatgpt",
        reference: {
          ...item.reference,
          snapshotId,
          conversationId: snapshot.id,
        },
        truncated: item.truncated,
      };
      evidence.push(entry);
      evidenceIds.push(evidenceId);
      if (item.role === "user")
        requests.push({ id: evidenceId, text: item.text, line: 0 });
      else
        tasks.push({
          id: evidenceId,
          turnId,
          title: short(item.text) || "답변 본문 없음",
          text: item.text,
          files: [],
          evidenceIds: [evidenceId],
          status,
          verification: "none",
          grouping: "source-answer",
          kind: "description",
          sourceKind: "chatgpt",
          truncated: item.truncated,
        });
    }
    return {
      id: turnId,
      title: short(requests[0]?.text || "질문 기록 없음"),
      requests,
      tasks,
      plans: [],
      artifacts: [],
      result: tasks.at(-1)?.text || "",
      status,
      evidenceIds,
      sourceKind: "chatgpt",
      truncated: raw.items.some((item) => item.truncated),
    };
  });
  return {
    id: snapshot.id,
    title: snapshot.title,
    project: "",
    sourceKind: "chatgpt",
    sourcePath,
    version: "chatgpt-snapshot-v1",
    originator: "ChatGPT app-tool snapshot",
    turns,
    evidence,
    revision: snapshotId,
    latestTimestamp: iso(snapshot.updatedAt),
    pendingBytes: 0,
    invalidLines: [],
    limitations: [...snapshot.issues],
    loadedAt: importedAt,
    importedAt,
    capturedAt: snapshot.capturedAt,
    coverage: snapshot.coverage,
    snapshotId,
    originalThreadId: snapshot.threadId,
  };
}
