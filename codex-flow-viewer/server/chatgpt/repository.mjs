import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { decodeSnapshot, toSession } from "./snapshot.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const complete = (value) =>
  value.coverage.traversal === "complete" && value.coverage.text === "complete";
const items = (value) =>
  new Map(
    value.turns.flatMap((turn) =>
      turn.items.map((item) => [JSON.stringify([turn.id, item.id]), item]),
    ),
  );
export class ChatGptRepository extends EventEmitter {
  #tail = Promise.resolve();
  #entries = {};
  #sessions = new Map();
  #decoded = new Map();
  #cache = new Map();
  constructor({ root, store }) {
    super();
    this.root = path.resolve(root);
    this.store = store;
    this.error = null;
  }
  #queue(work) {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => {});
    return result;
  }
  refresh() {
    return this.#queue(() => this.#refresh());
  }
  import(bytes) {
    return this.#queue(() => this.#import(Buffer.from(bytes)));
  }
  #path(id) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error("올바르지 않은 원문 사본 ID입니다.");
    return path.join(this.root, "snapshots", id + ".json");
  }
  async #read(id) {
    const filename = this.#path(id),
      stat = await fs.stat(filename),
      key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    if (this.#cache.get(id)?.key === key) return this.#cache.get(id).decoded;
    const bytes = await fs.readFile(filename);
    if (hash(bytes) !== id)
      throw new Error("원문 사본의 해시가 일치하지 않습니다.");
    const decoded = decodeSnapshot(bytes);
    this.#cache.set(id, { key, decoded });
    return decoded;
  }
  async #refresh() {
    const catalog = this.store.get("chatgpt:catalog");
    const entries =
      catalog.entries &&
      typeof catalog.entries === "object" &&
      !Array.isArray(catalog.entries)
        ? catalog.entries
        : {};
    const sessions = new Map(),
      decoded = new Map(),
      problems = [];
    for (const [id, entry] of Object.entries(entries)) {
      if (!entry || !Array.isArray(entry.versions)) continue;
      const versions = [
        entry.current,
        ...entry.versions
          .filter((v) => v.applied)
          .map((v) => v.snapshotId)
          .reverse(),
      ].filter((v, i, a) => typeof v === "string" && a.indexOf(v) === i);
      for (const version of versions) {
        try {
          const value = await this.#read(version);
          if (value.id !== id)
            throw new Error("원문 사본의 대화 ID가 일치하지 않습니다.");
          const meta = entry.versions.find((v) => v.snapshotId === version);
          const session = toSession(value, {
            sourcePath: this.#path(version),
            snapshotId: version,
            importedAt: meta?.importedAt || value.capturedAt,
          });
          if (version !== entry.current) {
            problems.push("일부 사본을 읽지 못해 이전 정상 기록을 표시합니다.");
            session.limitations.push(
              "최신 사본을 읽지 못해 이전 정상 기록을 표시합니다.",
            );
          }
          sessions.set(id, session);
          decoded.set(id, value);
          break;
        } catch {
          problems.push("일부 원문 사본을 읽지 못했습니다.");
        }
      }
    }
    const before = JSON.stringify(
      [...this.#sessions].map(([id, s]) => [id, s.revision]),
    );
    const oldError = this.error;
    this.#entries = entries;
    this.#sessions = sessions;
    this.#decoded = decoded;
    this.error = [...new Set(problems)].join(" ") || null;
    if (
      oldError !== this.error ||
      before !==
        JSON.stringify([...sessions].map(([id, s]) => [id, s.revision]))
    )
      this.emit("change", { sourceKind: "chatgpt", ids: [...sessions.keys()] });
    return this.catalog();
  }
  list() {
    return [...this.#sessions.values()]
      .map((session) => ({
        id: session.id,
        title: session.title,
        project: "",
        sourceKind: "chatgpt",
        turnCount: session.turns.filter((t) => t.requests.length).length,
        taskCount: session.turns.reduce((n, t) => n + t.tasks.length, 0),
        status: session.turns.at(-1)?.status || "unknown",
        latestTimestamp: session.latestTimestamp,
        revision: session.revision,
        coverage: session.coverage,
        importedAt: session.importedAt,
      }))
      .sort((a, b) => (b.importedAt || "").localeCompare(a.importedAt || ""));
  }
  catalog() {
    return Object.entries(this.#entries).map(([id, entry]) => {
      const session = this.#sessions.get(id);
      return {
        id,
        title: session?.title || entry.title || "읽지 못한 대화",
        available: !!session,
        coverage: session?.coverage || null,
        importedAt: session?.importedAt || null,
        versionCount: entry.versions?.length || 0,
        snapshotId: session?.snapshotId || null,
        turnCount: session?.turns.filter((t) => t.requests.length).length || 0,
        error: session ? null : "원문 사본을 읽지 못했습니다.",
      };
    });
  }
  get(id) {
    return this.#sessions.get(id);
  }
  async source(id, snapshotId) {
    const entry = this.#entries[id];
    if (!entry?.versions?.some((v) => v.snapshotId === snapshotId))
      throw new Error("등록된 원문 사본을 찾을 수 없습니다.");
    const bytes = await fs.readFile(this.#path(snapshotId));
    if (hash(bytes) !== snapshotId)
      throw new Error("원문 사본의 해시가 일치하지 않습니다.");
    return bytes;
  }
  async #import(bytes) {
    const incoming = decodeSnapshot(bytes);
    await this.#refresh();
    const previous = this.#decoded.get(incoming.id),
      oldEntry = this.#entries[incoming.id];
    const snapshotId = hash(bytes),
      duplicate = previous?.digest === incoming.digest;
    let reason = "";
    if (duplicate) reason = "질문·답변 내용이 같아 기존 기록을 유지합니다.";
    else if (previous) {
      const oldItems = items(previous),
        newItems = items(incoming);
      if ([...oldItems.keys()].some((key) => !newItems.has(key)))
        reason = "이전 메시지가 빠진 사본이어서 기존 정상 기록을 유지합니다.";
      else if (
        ["traversal", "text"].some(
          (key) =>
            previous.coverage[key] === "complete" &&
            incoming.coverage[key] !== "complete",
        )
      )
        reason =
          "이전보다 수집 범위가 줄어든 부분 사본이어서 기존 정상 기록을 유지합니다.";
      else if (
        [...oldItems].some(
          ([key, item]) => !item.truncated && newItems.get(key)?.truncated,
        )
      )
        reason = "이전보다 잘린 본문이 있어 기존 정상 기록을 유지합니다.";
      else if (
        [...oldItems].some(
          ([key, item]) =>
            newItems.get(key)?.truncated &&
            newItems.get(key).text.length < item.text.length,
        )
      )
        reason = "부분 본문이 이전보다 짧아 기존 정상 기록을 유지합니다.";
      else if (
        previous.updatedAt != null &&
        incoming.updatedAt != null &&
        incoming.updatedAt < previous.updatedAt
      )
        reason = "과거 시점의 사본이어서 기존 정상 기록을 유지합니다.";
    }
    const applied = !reason;
    await fs.mkdir(path.join(this.root, "snapshots"), { recursive: true });
    const target = this.#path(snapshotId);
    try {
      const existing = await fs.readFile(target);
      if (hash(existing) !== snapshotId)
        throw new Error(
          "같은 위치의 원문 사본이 손상되어 가져오기를 중단했습니다.",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const temporary = path.join(
        this.root,
        "snapshots",
        "staging-" + randomUUID() + ".tmp",
      );
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx" });
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
    const importedAt = new Date().toISOString(),
      versions = [...(oldEntry?.versions || [])];
    if (!versions.some((v) => v.snapshotId === snapshotId))
      versions.push({
        snapshotId,
        digest: incoming.digest,
        importedAt,
        capturedAt: incoming.capturedAt,
        coverage: incoming.coverage,
        applied,
      });
    const entry = {
      title: applied ? incoming.title : oldEntry?.title || incoming.title,
      current: applied ? snapshotId : oldEntry.current,
      versions,
    };
    this.store.set("chatgpt:catalog", {
      schemaVersion: 1,
      entries: { ...this.#entries, [incoming.id]: entry },
    });
    await this.#refresh();
    return {
      id: incoming.id,
      snapshotId,
      applied,
      duplicate: !!duplicate,
      coverage: incoming.coverage,
      message:
        reason ||
        (complete(incoming)
          ? "대화 사본을 가져왔습니다."
          : "대화 사본을 일부 가져왔습니다. 누락·잘림 표시를 확인하세요."),
      conversation: this.catalog().find((c) => c.id === incoming.id),
    };
  }
}
