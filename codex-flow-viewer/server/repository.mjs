import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { JsonlDecoder, isRecordFile } from "./records.mjs";
import { canonicalProject, normalizeRecords } from "./model.mjs";
import {
  normalizeInputPath,
  pathIdentity,
  projectDirectory,
  recordLocations,
  recordFiles,
  containsPath,
  connectionError,
} from "./connection-paths.mjs";

const decompress = promisify(zstdDecompress);

// Compare retained source records before normalization: normalization replaces
// command-started with command-completed and folds turn completion into status.
// Session metadata can be reissued; source authority already checked its project.
function incompleteRestoration(active, archive) {
  const history = (state) =>
    state.records.filter(({ row }) => row.type !== "session_meta");
  const prefix = history(active),
    full = history(archive);
  return (
    prefix.length < full.length &&
    prefix.every(
      ({ row }, index) =>
        JSON.stringify(row) === JSON.stringify(full[index].row),
    )
  );
}

async function readMetadata(file, limitBytes, snapshot) {
  if (snapshot) {
    const meta = snapshot.find(({ row }) => row.type === "session_meta")?.row
      .payload;
    const latestCwd = snapshot.findLast(
      ({ row }) =>
        row.type === "turn_context" &&
        typeof row.payload?.cwd === "string" &&
        row.payload.cwd.trim(),
    )?.row.payload.cwd;
    return meta ? { ...meta, cwd: latestCwd || meta.cwd } : null;
  }
  const handle = await fs.open(file, "r");
  try {
    const decoder = new JsonlDecoder();
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    let meta = null;
    let latestCwd = null;
    // A thread can be attached to another project after creation. Its first
    // session_meta stays unchanged; later turn_context records carry the new cwd.
    while (position < limitBytes) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, limitBytes - position),
        position,
      );
      if (!bytesRead) break;
      position += bytesRead;
      const rows = decoder.push(buffer.subarray(0, bytesRead));
      for (const { row } of rows) {
        if (row.type === "session_meta" && !meta) meta = row.payload;
        if (
          row.type === "turn_context" &&
          typeof row.payload?.cwd === "string" &&
          row.payload.cwd.trim()
        )
          latestCwd = row.payload.cwd;
      }
    }
    return meta ? { ...meta, cwd: latestCwd || meta.cwd } : null;
  } finally {
    await handle.close();
  }
}

const keep = ({ row }) =>
  row.type === "session_meta" ||
  row.type === "turn_context" ||
  (row.type === "event_msg" &&
    !["token_count", "thread_settings_applied"].includes(row.payload?.type) &&
    row.payload?.item?.type !== "Reasoning");

export class SessionRepository extends EventEmitter {
  #files = new Map();
  #sessions = new Map();
  #refreshing;
  #configuration = Promise.resolve();
  #rootReadable = true;
  #projectKey = "";
  #sourceRoots = [];
  constructor({ sessionsRoot, project }) {
    super();
    this.sessionsRoot = normalizeInputPath(sessionsRoot, "sessionsRoot");
    this.project = normalizeInputPath(project, "project");
    this.connectionId = randomUUID();
    this.diagnostics = {
      status: "loading",
      message: "기록을 확인하고 있습니다.",
      scannedFiles: 0,
      conversationCount: 0,
      availableProjects: [],
      issues: [],
    };
    this.error = null;
  }

  list() {
    return [...this.#sessions.values()]
      .filter(
        (s) =>
          !s.parentThreadId &&
          !["guardian_review", "subagent"].includes(s.threadSource),
      )
      .map((s) => ({
        id: s.id,
        project: s.project,
        title:
          s.turns.find((t) => t.requests.length)?.title || "요청이 없는 대화",
        turnCount: s.turns.filter((t) => t.requests.length).length,
        taskCount: s.turns.reduce((n, t) => n + t.tasks.length, 0),
        latestTimestamp: s.latestTimestamp,
        status: s.turns.at(-1)?.status || "unknown",
        revision: s.revision,
        sourcePath: s.sourcePath,
      }))
      .sort((a, b) =>
        (b.latestTimestamp || "").localeCompare(a.latestTimestamp || ""),
      );
  }
  get(id) {
    return this.#sessions.get(id);
  }

  configure(input, persist) {
    const result = this.#configuration.then(() =>
      this.#configure(input, persist),
    );
    this.#configuration = result.catch(() => {});
    return result;
  }

  snapshot() {
    return {
      project: this.project,
      sessionsRoot: this.sessionsRoot,
      connectionId: this.connectionId,
      error: this.error,
      diagnostics: this.diagnostics,
      sessions: this.list(),
    };
  }

  async #configure({ sessionsRoot, project }, persist) {
    const selected = await projectDirectory(project);
    const source = await recordLocations(sessionsRoot);
    const candidate = new SessionRepository({
      project: selected,
      sessionsRoot: source.root,
    });
    await candidate.refresh();
    if (
      !candidate.#rootReadable ||
      (candidate.error && !candidate.list().length)
    )
      throw connectionError(
        candidate.error ||
          "새 기록 경로를 읽지 못했습니다. 기존 연결을 유지합니다.",
        "SOURCE_READ_FAILED",
        "sessionsRoot",
      );
    if (this.#refreshing) await this.#refreshing;
    // Persistence is synchronous and must succeed before replacing the live view.
    persist?.({
      project: candidate.project,
      sessionsRoot: candidate.sessionsRoot,
    });
    const previous = [...this.#sessions.keys()];
    this.project = candidate.project;
    this.sessionsRoot = candidate.sessionsRoot;
    this.#projectKey = candidate.#projectKey;
    this.#files = candidate.#files;
    this.#sessions = candidate.#sessions;
    this.#sourceRoots = candidate.#sourceRoots;
    this.error = candidate.error;
    this.diagnostics = candidate.diagnostics;
    this.connectionId = candidate.connectionId;
    this.emit("change", {
      ids: [...new Set([...previous, ...this.#sessions.keys()])],
      connectionId: this.connectionId,
      error: this.error,
      diagnostics: this.diagnostics,
    });
    return this.snapshot();
  }

  refresh() {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#read().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #read() {
    const seen = new Set();
    const previousSessions = this.#sessions;
    const previousError = this.error;
    const previousDiagnostics = JSON.stringify(this.diagnostics);
    const issues = [],
      unavailable = [];
    this.#rootReadable = true;
    let roots = this.#sourceRoots.length
      ? [...this.#sourceRoots]
      : [this.sessionsRoot];
    const identities = new Map();
    const keyOf = async (value) => {
      const key = canonicalProject(typeof value === "string" ? value : "");
      if (!identities.has(key)) identities.set(key, await pathIdentity(value));
      return identities.get(key);
    };
    this.#projectKey = (await keyOf(this.project)).key;
    this.error = null;
    try {
      const locations = await recordLocations(this.sessionsRoot);
      this.sessionsRoot = locations.root;
      roots = locations.roots;
      this.#sourceRoots = roots;
      const scanError = (file, error) => {
        issues.push({ path: file, code: error.code || "READ_ERROR" });
        unavailable.push(file);
        if (canonicalProject(file) === canonicalProject(this.sessionsRoot))
          this.#rootReadable = false;
      };
      const visited = new Set();
      for (const root of roots)
        for await (const file of recordFiles(root, scanError, visited)) {
          seen.add(file);
          try {
            const stat = await fs.stat(file);
            let state = this.#files.get(file);
            if (
              state &&
              stat.size === state.offset &&
              stat.mtimeMs === state.mtime &&
              stat.ctimeMs === state.ctime &&
              stat.ino === state.ino
            )
              continue;
            // Revalidate metadata whenever a source changes, even if a formerly partial
            // first line or a previously excluded project has now become readable.
            const compressed = /\.zst$/i.test(file);
            const snapshotDecoder = compressed ? new JsonlDecoder() : null;
            const snapshot = compressed
              ? snapshotDecoder.push(
                  await decompress(await fs.readFile(file), {
                    maxOutputLength: 256 * 1024 * 1024,
                  }),
                )
              : null;
            const meta = await readMetadata(file, stat.size, snapshot);
            const identity = await keyOf(meta?.cwd);
            if (!meta || identity.key !== this.#projectKey) {
              this.#files.set(file, {
                id: meta?.id || meta?.session_id,
                project: meta?.cwd,
                projectKey: identity.key,
                resolvedProject: identity.path,
                threadSource: meta?.thread_source,
                parentThreadId: meta?.parent_thread_id,
                offset: stat.size,
                mtime: stat.mtimeMs,
                ctime: stat.ctimeMs,
                ino: stat.ino,
                excluded: true,
              });
              continue;
            }
            const handle = compressed ? null : await fs.open(file, "r");
            try {
              let reset =
                compressed ||
                !state ||
                state.excluded ||
                stat.size < state.offset ||
                stat.ino !== state.ino ||
                (stat.size === state.offset &&
                  (stat.mtimeMs !== state.mtime ||
                    stat.ctimeMs !== state.ctime)) ||
                state.id !== (meta.id || meta.session_id);
              // Append requires the retained beginning and the old boundary to match.
              // This catches in-place rewrites whose size increased without inode change.
              if (!reset) {
                for (const probe of state.probes || []) {
                  const buffer = Buffer.alloc(probe.bytes.length);
                  const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    buffer.length,
                    probe.position,
                  );
                  if (
                    bytesRead !== buffer.length ||
                    !buffer.equals(probe.bytes)
                  ) {
                    reset = true;
                    break;
                  }
                }
              }
              if (reset) {
                state = {
                  decoder: new JsonlDecoder(),
                  records: [],
                  offset: 0,
                  ino: stat.ino,
                };
              }
              if (compressed) {
                state.decoder = snapshotDecoder;
                state.records = snapshot.filter(keep);
                state.offset = stat.size;
              }
              const buffer = Buffer.alloc(128 * 1024);
              while (!compressed && state.offset < stat.size) {
                const { bytesRead } = await handle.read(
                  buffer,
                  0,
                  Math.min(buffer.length, stat.size - state.offset),
                  state.offset,
                );
                if (!bytesRead) break;
                state.records.push(
                  ...state.decoder
                    .push(buffer.subarray(0, bytesRead))
                    .filter(keep),
                );
                state.offset += bytesRead;
              }
              state.probes = [];
              for (const position of compressed
                ? []
                : [0, Math.max(0, state.offset - 4096)]) {
                const probe = Buffer.alloc(
                  Math.min(4096, state.offset - position),
                );
                await handle.read(probe, 0, probe.length, position);
                state.probes.push({ position, bytes: probe });
              }
            } finally {
              await handle?.close();
            }
            const session = normalizeRecords(state.records, file);
            if ((await keyOf(session.project)).key !== this.#projectKey) {
              this.#files.set(file, {
                id: session.id,
                project: session.project,
                projectKey: (await keyOf(session.project)).key,
                resolvedProject: (await keyOf(session.project)).path,
                threadSource: session.threadSource,
                parentThreadId: session.parentThreadId,
                offset: stat.size,
                mtime: stat.mtimeMs,
                ctime: stat.ctimeMs,
                ino: stat.ino,
                excluded: true,
              });
              continue;
            }
            session.pendingBytes = state.decoder.pendingBytes;
            session.invalidLines = [...state.decoder.invalidLines];
            session.revision = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
            session.loadedAt = new Date().toISOString();
            session.limitations = [
              "작업 가지는 기록의 설명과 인접 실행을 시간순으로 묶은 것입니다.",
              "명령 종료와 기능 동작 확인은 별개입니다.",
              "구조화된 파일 변경이 없는 스크립트 결과물은 변경 파일로 집계하지 않습니다.",
            ];
            state.id = session.id;
            state.project = session.project;
            state.projectKey = (await keyOf(session.project)).key;
            state.resolvedProject = (await keyOf(session.project)).path;
            state.threadSource = session.threadSource;
            state.parentThreadId = session.parentThreadId;
            state.session = session;
            state.mtime = stat.mtimeMs;
            state.ctime = stat.ctimeMs;
            this.#files.set(file, state);
          } catch (error) {
            issues.push({ path: file, code: error.code || "READ_ERROR" });
          }
        }
    } catch (error) {
      this.#rootReadable = false;
      issues.push({
        path: this.sessionsRoot,
        code: error.code || "READ_ERROR",
      });
      unavailable.push(...roots);
    }
    for (const [file] of this.#files)
      if (!seen.has(file)) {
        if (unavailable.some((directory) => containsPath(directory, file)))
          seen.add(file);
        else this.#files.delete(file);
      }
    if (issues.length)
      this.error = `일부 기록을 읽지 못했습니다: ${issues[0].code} · ${issues.length}개 경로`;
    // Compression/resume can leave both files for one thread temporarily. Rebuild
    // from cached sources atomically and prefer its active, uncompressed log.
    const authorities = new Map();
    for (const [file, state] of this.#files) {
      if (!seen.has(file) || !state.id) continue;
      const current = authorities.get(state.id);
      if (
        !current ||
        (/\.zst$/i.test(current.file) && !/\.zst$/i.test(file)) ||
        (/\.zst$/i.test(current.file) === /\.zst$/i.test(file) &&
          state.mtime > current.state.mtime)
      )
        authorities.set(state.id, { file, state });
    }
    const sessions = new Map();
    for (const { file, state } of authorities.values()) {
      // Resolve the active source's project even if it is excluded from this
      // view, otherwise an obsolete archive can leak into its former project.
      if (state.projectKey !== this.#projectKey || !state.session) continue;
      let session = state.session;
      if (!/\.zst$/i.test(file)) {
        // Keep a complete same-project archive while the plain file is still
        // restoring its public history; never merge or invent missing records.
        const archive = [...this.#files].find(
          ([name, other]) =>
            seen.has(name) &&
            /\.zst$/i.test(name) &&
            other.id === state.id &&
            other.projectKey === state.projectKey &&
            other.session &&
            incompleteRestoration(state, other),
        );
        if (archive) session = archive[1].session;
      }
      sessions.set(session.id, session);
    }
    this.#sessions = sessions;
    const projects = new Map();
    for (const { state } of authorities.values()) {
      if (
        !state.projectKey ||
        state.parentThreadId ||
        ["guardian_review", "subagent"].includes(state.threadSource)
      )
        continue;
      const current = projects.get(state.projectKey) || {
        path: state.resolvedProject || state.project,
        conversationCount: 0,
      };
      current.conversationCount++;
      projects.set(state.projectKey, current);
    }
    const availableProjects = await Promise.all(
      [...projects.values()]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(async (project) => {
          try {
            return {
              ...project,
              exists: (await fs.stat(project.path)).isDirectory(),
            };
          } catch {
            return { ...project, exists: false };
          }
        }),
    );
    const conversationCount = this.list().length;
    const parsedFiles = [...this.#files.values()].filter(
      (state) => state.projectKey,
    ).length;
    const status = conversationCount
      ? "connected"
      : issues.length
        ? "read_error"
        : !seen.size
          ? "no_records"
          : !parsedFiles
            ? "unrecognized_records"
            : "no_matching_project";
    const message = conversationCount
      ? `대화 ${conversationCount}개를 연결했습니다.`
      : issues.length
        ? "기록을 모두 읽지 못했습니다. 읽기 오류를 확인해 주세요."
        : !seen.size
          ? "선택한 기록 위치에 JSONL 또는 JSONL.ZST 기록이 없습니다."
          : !parsedFiles
            ? "프로젝트 정보가 확인되는 Codex 기록을 찾지 못했습니다."
            : "폴더는 연결됐지만 이 경로에 해당하는 Codex 대화 기록이 없습니다.";
    this.diagnostics = {
      status,
      message,
      scannedFiles: seen.size,
      parsedFiles,
      archivedFiles: [...seen].filter((file) =>
        file.split(/[\\/]/).some((part) => part === "archived_sessions"),
      ).length,
      conversationCount,
      availableProjects,
      issues,
    };
    const changed = [
      ...new Set([...previousSessions.keys(), ...sessions.keys()]),
    ].filter(
      (id) =>
        previousSessions.get(id)?.revision !== sessions.get(id)?.revision ||
        previousSessions.get(id)?.sourcePath !== sessions.get(id)?.sourcePath,
    );
    if (
      changed.length ||
      previousError !== this.error ||
      previousDiagnostics !== JSON.stringify(this.diagnostics)
    )
      this.emit("change", {
        ids: changed,
        error: this.error,
        connectionId: this.connectionId,
        diagnostics: this.diagnostics,
      });
    return changed;
  }
}
