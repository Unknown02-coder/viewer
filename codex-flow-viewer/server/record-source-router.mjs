import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// Keep the last Codex connection separate from the selected display source.
export class RecordSourceRouter extends EventEmitter {
  #tail = Promise.resolve();
  constructor({ codex, imports, direct, store }) {
    super();
    Object.assign(this, { codex, imports, direct, store });
    const saved = store.get("record-source");
    this.sourceKind =
      saved.kind === "chatgpt-mcp" && direct
        ? "chatgpt-mcp"
        : saved.kind === "chatgpt" && imports
          ? "chatgpt"
          : "codex";
    this.mcpProjectId =
      this.sourceKind === "chatgpt-mcp" ? saved.projectId : null;
    this.notice =
      saved.kind === "chatgpt" && !imports
        ? "파일 가져오기 기능을 종료해 마지막 Codex 연결을 표시합니다. 이전 사본과 메모는 보관돼 있습니다."
        : null;
    this.selectedImportId =
      this.sourceKind === "chatgpt" ? saved.conversationId : null;
    this.connectionId = randomUUID();
    codex.on("change", (value) => {
      if (this.sourceKind === "codex") this.emit("change", value);
    });
    imports?.on("change", (value) => this.emit("change", value));
    direct?.on("change", (value) => this.emit("change", value));
  }
  get project() {
    return this.codex.project;
  }
  get sessionsRoot() {
    return this.codex.sessionsRoot;
  }
  get error() {
    if (this.sourceKind === "chatgpt-mcp")
      return (
        this.direct.error ||
        (!this.direct.projects().some((p) => p.id === this.mcpProjectId)
          ? "선택한 직접 연결 프로젝트를 찾을 수 없습니다."
          : null)
      );
    return this.sourceKind === "codex"
      ? this.codex.error
      : !this.imports.get(this.selectedImportId)
        ? "선택한 대화의 원문 사본을 읽지 못했습니다."
        : this.imports.error;
  }
  list() {
    if (this.sourceKind === "chatgpt-mcp")
      return this.direct.list(this.mcpProjectId);
    if (this.sourceKind === "codex") return this.codex.list();
    if (!this.imports.get(this.selectedImportId)) return [];
    return this.imports
      .list()
      .sort(
        (a, b) =>
          Number(b.id === this.selectedImportId) -
          Number(a.id === this.selectedImportId),
      );
  }
  get(id) {
    if (this.sourceKind === "chatgpt-mcp") {
      const s = this.direct.get(id);
      return s?.mcpProjectId === this.mcpProjectId ? s : undefined;
    }
    return this.sourceKind === "codex"
      ? this.codex.get(id)
      : this.imports.get(this.selectedImportId)
        ? this.imports.get(id)
        : undefined;
  }
  snapshot() {
    return {
      project: this.project,
      sessionsRoot: this.sessionsRoot,
      connectionId: this.connectionId,
      sourceKind: this.sourceKind,
      selectedImportId: this.selectedImportId,
      mcpProjectId: this.mcpProjectId,
      mcpProjectName:
        this.sourceKind === "chatgpt-mcp"
          ? this.direct.projects().find((p) => p.id === this.mcpProjectId)?.name
          : null,
      notice: this.notice,
      error: this.error,
      diagnostics:
        this.sourceKind === "codex"
          ? this.codex.diagnostics
          : {
              status: this.error ? "unreadable" : "connected",
              message:
                this.error ||
                (this.sourceKind === "chatgpt-mcp"
                  ? "MCP로 전달받은 기록을 표시합니다."
                  : "저장된 ChatGPT 대화 사본을 표시합니다."),
              scannedFiles: 0,
              conversationCount: this.list().length,
              availableProjects: [],
              issues: [],
            },
      sessions: this.list(),
    };
  }
  async refresh() {
    await Promise.all([
      this.codex.refresh(),
      this.imports?.refresh(),
      this.direct?.refresh(),
    ]);
    return this.snapshot();
  }
  configure(input, persist) {
    const result = this.#tail.then(() => this.#configure(input, persist));
    this.#tail = result.catch(() => {});
    return result;
  }
  async #configure(input, persist) {
    const kind = input?.sourceKind ?? "codex";
    if (!(
      kind === "codex" ||
      (kind === "chatgpt" && this.imports) ||
      (kind === "chatgpt-mcp" && this.direct)
    ))
      throw new Error("기록 출처를 확인해 주세요.");
    if (kind === "codex") {
      await this.codex.configure(input, (settings) =>
        this.store.transaction(() => {
          if (persist) persist(settings);
          else this.store.set("settings", settings);
          this.store.set("record-source", { kind: "codex" });
        }),
      );
    } else if (kind === "chatgpt-mcp") {
      await this.direct.refresh();
      if (
        typeof input.projectId !== "string" ||
        !this.direct.projects().some((p) => p.id === input.projectId)
      )
        throw new Error("등록된 직접 연결 프로젝트를 선택해 주세요.");
      this.store.set("record-source", { kind, projectId: input.projectId });
    } else {
      await this.imports.refresh();
      if (
        typeof input.conversationId !== "string" ||
        !this.imports.get(input.conversationId)
      )
        throw new Error("읽을 수 있는 저장된 ChatGPT 대화를 선택해 주세요.");
      this.store.set("record-source", {
        kind,
        conversationId: input.conversationId,
      });
    }
    this.sourceKind = kind;
    this.mcpProjectId = kind === "chatgpt-mcp" ? input.projectId : null;
    this.notice = null;
    this.selectedImportId = kind === "chatgpt" ? input.conversationId : null;
    this.connectionId = randomUUID();
    const snapshot = this.snapshot();
    this.emit("change", { sourceKind: kind, connectionId: this.connectionId });
    return snapshot;
  }
}
