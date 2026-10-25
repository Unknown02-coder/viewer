import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  FolderOpen,
  GitBranch,
  Layers3,
  Pin,
  Search,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { api } from "./api";
import FlowCanvas from "./FlowCanvas";
import OverviewTimeline from "./OverviewTimeline";
import Details from "./Details";
import ConnectionReport, { RecordedProjectPicker } from "./ConnectionReport";
import ConnectionFormError from "./ConnectionFormError";
import DirectConnection from "./DirectConnection";
import { PreferenceSaveQueue } from "./preferences-queue";
import type {
  Config,
  ConnectionSnapshot,
  Preferences,
  Session,
  SessionSummary,
  Tab,
} from "./types";
import { basename, emptyPreferences } from "./types";

export default function App() {
  const [readingToolsHost, setReadingToolsHost] =
    useState<HTMLDivElement | null>(null);
  const [config, setConfig] = useState<Config | null>(null),
    [sessions, setSessions] = useState<SessionSummary[]>([]),
    [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<Preferences>(emptyPreferences),
    [tab, setTab] = useState<Tab>("files");
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [mode, setMode] = useState<"tasks" | "overview">("tasks");
  const overviewScroll = useRef<Record<string, number>>({});
  const [follow, setFollow] = useState(false),
    [newCount, setNewCount] = useState(0),
    [online, setOnline] = useState(false),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const [settings, setSettings] = useState(false),
    [projectInput, setProjectInput] = useState(""),
    [sourceInput, setSourceInput] = useState("");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [selectedProject, setSelectedProject] = useState(""),
    [importBusy, setImportBusy] = useState(false);
  const isChatGpt = config?.sourceKind === "chatgpt-mcp";
  const [settingsKind, setSettingsKind] = useState<"codex" | "chatgpt-mcp">(
    "codex",
  );
  const [formError, setFormError] = useState<{
    message: string;
    code?: string;
  } | null>(null);
  const settingsForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!settings) return;
    const opener = document.activeElement;
    settingsForm.current
      ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [settings]);
  useEffect(() => {
    if (settings && busy) settingsForm.current?.focus();
  }, [settings, busy]);
  const settingsDirtyRef = useRef(false),
    connectingRef = useRef(false),
    connectionIdRef = useRef<string | undefined>(undefined);
  const synchronizeRef = useRef<() => Promise<void>>(async () => {});
  const [preferenceSaves] = useState(
    () =>
      new PreferenceSaveQueue((save) =>
        api(
          `/api/state/${encodeURIComponent(save.id)}`,
          "PUT",
          save.value,
          save.connectionId,
        ),
      ),
  );
  const [switching, setSwitching] = useState(false),
    [focusTarget, setFocusTarget] = useState<{
      id: string;
      nonce: number;
    } | null>(null);
  const switchingRef = useRef(false),
    loadVersion = useRef(0);
  const viewRef = useRef(view),
    sessionRef = useRef(session),
    idRef = useRef<string | null>(null),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current);
    await preferenceSaves.flush();
  }, [preferenceSaves]);
  const onView = useCallback(
    async (patch: Partial<Preferences>, immediately = false) => {
      if (!idRef.current || switchingRef.current || connectingRef.current)
        return false;
      const next = { ...viewRef.current, ...patch };
      viewRef.current = next;
      setView(next);
      preferenceSaves.stage(idRef.current, next, connectionIdRef.current);
      clearTimeout(saveTimer.current);
      if (immediately) {
        try {
          await flush();
          return true;
        } catch (e) {
          setError((e as Error).message);
          return false;
        }
      }
      saveTimer.current = setTimeout(
        () => flush().catch((e) => setError(e.message)),
        300,
      );
      return true;
    },
    [flush],
  );

  const loadSession = useCallback(
    async (id: string, initialize = false, flushPrevious = true) => {
      if (!initialize && (switchingRef.current || connectingRef.current))
        return;
      const scope = connectionIdRef.current;
      const version = initialize ? ++loadVersion.current : loadVersion.current;
      if (initialize) {
        switchingRef.current = true;
        setSwitching(true);
      }
      try {
        if (initialize && flushPrevious) await flush();
        const [data, persisted] = await Promise.all([
          api<Session>(
            `/api/sessions/${encodeURIComponent(id)}`,
            "GET",
            undefined,
            scope,
          ),
          initialize
            ? api<Partial<Preferences>>(
                `/api/state/${encodeURIComponent(id)}`,
                "GET",
                undefined,
                scope,
              )
            : Promise.resolve(null),
        ]);
        if (
          version !== loadVersion.current ||
          scope !== connectionIdRef.current ||
          (!initialize && (idRef.current !== id || switchingRef.current))
        )
          return;
        if (initialize) {
          const recovered = preferenceSaves.recover(id);
          const saved = recovered || persisted;
          const selection =
            data.turns.at(-1)?.tasks[0]?.id || data.turns.at(-1)?.id || null;
          const validSelection =
            saved?.selected &&
            data.turns.some(
              (t) =>
                t.id === saved.selected ||
                t.tasks.some((task) => task.id === saved.selected),
            );
          const currentExpanded = saved?.expanded?.filter((id) =>
            data.turns.some((turn) => turn.id === id),
          );
          const defaultExpanded = data.turns.slice(-2).map((turn) => turn.id);
          const next = {
            ...emptyPreferences(),
            ...saved,
            selected:
              saved?.selected === null
                ? null
                : validSelection
                  ? saved!.selected!
                  : selection,
            expanded:
              saved?.expanded?.length && !currentExpanded?.length
                ? defaultExpanded
                : currentExpanded || defaultExpanded,
          };
          idRef.current = id;
          viewRef.current = next;
          setView(next);
          setSearch("");
          setFilter("all");
          setFollow(false);
          setNewCount(0);
          setFocusTarget(null);
          if (recovered) {
            preferenceSaves.stage(id, next, scope);
            saveTimer.current = setTimeout(
              () => flush().catch((error) => setError(error.message)),
              300,
            );
          }
        } else if (sessionRef.current?.revision !== data.revision) {
          const previous = sessionRef.current;
          const oldCount = previous
            ? previous.turns.length +
              previous.turns.reduce((n, t) => n + t.tasks.length, 0)
            : 0;
          const nextCount =
            data.turns.length +
            data.turns.reduce((n, t) => n + t.tasks.length, 0);
          setNewCount((n) => n + Math.max(0, nextCount - oldCount));
        }
        sessionRef.current = data;
        setSession(data);
      } finally {
        if (initialize && version === loadVersion.current) {
          switchingRef.current = false;
          setSwitching(false);
        }
      }
    },
    [flush],
  );

  useEffect(() => {
    let cancelled = false;
    let request = 0;
    async function synchronize(retry = 0): Promise<void> {
      if (cancelled || connectingRef.current) return;
      const ticket = ++request,
        version = loadVersion.current;
      try {
        const { config: c, sessions: list } =
          await api<ConnectionSnapshot>("/api/connection");
        if (
          cancelled ||
          connectingRef.current ||
          ticket !== request ||
          version !== loadVersion.current
        )
          return;
        const changed = connectionIdRef.current !== c.connectionId;
        if (changed) {
          ++loadVersion.current;
          if (preferenceSaves.preserve()) {
            clearTimeout(saveTimer.current);
            setError(
              "연결 변경 전에 저장되지 않은 내용이 있습니다. 해당 프로젝트를 다시 연결하면 저장을 재시도합니다.",
            );
          }
          connectionIdRef.current = c.connectionId;
          setMode(c.sourceKind === "chatgpt-mcp" ? "overview" : "tasks");
          if (c.sourceKind === "chatgpt-mcp") setTab("summary");
          setFormError(null);
          idRef.current = null;
          sessionRef.current = null;
          setSession(null);
          setFollow(false);
          setFocusTarget(null);
          setNewCount(0);
          if (!settingsDirtyRef.current) {
            setProjectInput(c.project);
            setSourceInput(c.sessionsRoot);
          }
        }
        setConfig(c);
        setSessions(list);
        if (
          !changed &&
          idRef.current &&
          list.some((item) => item.id === idRef.current)
        )
          await loadSession(idRef.current);
        else if (list.length) {
          if (!changed && idRef.current && preferenceSaves.preserve()) {
            clearTimeout(saveTimer.current);
            setError(
              "이전 대화에 저장되지 않은 내용이 있습니다. 해당 대화가 다시 연결되면 저장을 재시도합니다.",
            );
          }
          await loadSession(list[0].id, true, false);
        } else {
          if (preferenceSaves.preserve()) clearTimeout(saveTimer.current);
          ++loadVersion.current;
          idRef.current = null;
          sessionRef.current = null;
          setSession(null);
          viewRef.current = emptyPreferences();
          setView(viewRef.current);
          switchingRef.current = false;
          setSwitching(false);
        }
      } catch (error) {
        if (cancelled || connectingRef.current || ticket !== request) return;
        if (
          (error as { code?: string }).code === "CONNECTION_CHANGED" &&
          retry < 1
        )
          return synchronize(retry + 1);
        setError((error as Error).message);
      } finally {
        if (!cancelled && !connectingRef.current) setBusy(false);
      }
    }
    synchronizeRef.current = synchronize;
    void synchronize();
    const stream = new EventSource("/api/events");
    stream.addEventListener("ready", () => {
      setOnline(true);
      void synchronize();
    });
    stream.onerror = () => setOnline(false);
    stream.addEventListener("change", () => {
      void synchronize();
    });
    return () => {
      cancelled = true;
      ++request;
      synchronizeRef.current = async () => {};
      stream.close();
    };
  }, [loadSession]);

  const onSelect = useCallback(
    (id: string) => {
      const parent = sessionRef.current?.turns.find((t) =>
        t.tasks.some((task) => task.id === id),
      );
      const expanded =
        parent && !viewRef.current.expanded.includes(parent.id)
          ? [...viewRef.current.expanded, parent.id]
          : viewRef.current.expanded;
      onView({ selected: id, expanded });
    },
    [onView],
  );
  const onToggle = useCallback(
    (id: string) => {
      const old = viewRef.current.expanded;
      onView({
        expanded: old.includes(id) ? old.filter((v) => v !== id) : [...old, id],
      });
    },
    [onView],
  );
  const onFocusHandled = useCallback((nonce: number) => {
    setFocusTarget((current) => (current?.nonce === nonce ? null : current));
  }, []);
  const navigateTo = useCallback(
    (id: string) => {
      setSearch("");
      setFilter("all");
      setFollow(false);
      onSelect(id);
      setFocusTarget({ id, nonce: Date.now() });
    },
    [onSelect],
  );
  const onFollow = useCallback(
    (enabled: boolean) => {
      setFollow(enabled);
      if (enabled) {
        setSearch("");
        setFilter("all");
        setNewCount(0);
        const turn = sessionRef.current?.turns.at(-1);
        if (turn) onSelect(turn.tasks.at(-1)?.id || turn.id);
      }
    },
    [onSelect],
  );
  useEffect(() => {
    if (follow) {
      setNewCount(0);
      const turn = session?.turns.at(-1);
      if (turn) onSelect(turn.tasks.at(-1)?.id || turn.id);
    }
  }, [session?.revision, follow, onSelect]);

  const matching = useMemo(() => {
    const ids = new Set<string>(),
      query = search.trim().toLocaleLowerCase();
    const condition = (status: string, evidenceIds: string[]) =>
      filter === "all" ||
      filter === "unverified" ||
      (filter === "running" && status === "running") ||
      (filter === "failed" &&
        (["failed", "interrupted"].includes(status) ||
          session?.evidence.some(
            (e) =>
              evidenceIds.includes(e.id) &&
              (e.status === "failed" ||
                (e.exitCode != null && e.exitCode !== 0)),
          )));
    for (const turn of session?.turns || []) {
      const turnMatch =
        !query ||
        [
          turn.requests.map((q) => q.text).join(" "),
          view.notes[turn.id],
          view.titles[turn.id],
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query);
      if (turnMatch && condition(turn.status, turn.evidenceIds))
        ids.add(turn.id);
      for (const task of turn.tasks)
        if (
          condition(task.status, task.evidenceIds) &&
          (turnMatch ||
            [
              task.text,
              task.title,
              view.notes[task.id],
              view.titles[task.id],
              task.files.map((f) => f.relativePath).join(" "),
            ]
              .join(" ")
              .toLocaleLowerCase()
              .includes(query))
        )
          ids.add(task.id);
    }
    return ids;
  }, [session, search, filter, view.notes, view.titles]);

  async function saveConfig(event: React.FormEvent) {
    event.preventDefault();
    if (
      connectingRef.current ||
      importBusy ||
      (settingsKind === "chatgpt-mcp" && !selectedProject)
    )
      return;
    connectingRef.current = true;
    ++loadVersion.current;
    switchingRef.current = true;
    setSwitching(true);
    setBusy(true);
    setFormError(null);
    let phase: "save" | "connect" | "load" = "save";
    try {
      await flush();
      phase = "connect";
      const { config: c, sessions: list } = await api<ConnectionSnapshot>(
        "/api/connection",
        "PUT",
        settingsKind === "chatgpt-mcp"
          ? { sourceKind: "chatgpt-mcp", projectId: selectedProject }
          : {
              sourceKind: "codex",
              project: projectInput,
              sessionsRoot: sourceInput,
            },
      );
      phase = "load";
      connectionIdRef.current = c.connectionId;
      setConfig(c);
      setMode(c.sourceKind === "chatgpt-mcp" ? "overview" : "tasks");
      if (c.sourceKind === "chatgpt-mcp") setTab("summary");
      setProjectInput(c.project);
      setSourceInput(c.sessionsRoot);
      settingsDirtyRef.current = false;
      setSettingsDirty(false);
      setSessions(list);
      idRef.current = null;
      sessionRef.current = null;
      setSession(null);
      if (list.length) await loadSession(list[0].id, true, false);
      else {
        viewRef.current = emptyPreferences();
        setView(viewRef.current);
      }
      setSettings(false);
      setError("");
    } catch (e) {
      const failure = e as Error & { code?: string };
      if (phase === "connect") {
        setFormError({ message: failure.message, code: failure.code });
      } else {
        setSettings(false);
        setError(
          phase === "save"
            ? `메모를 저장하지 못해 연결을 변경하지 않았습니다. ${failure.message}`
            : `연결은 적용됐지만 대화를 불러오지 못했습니다. ${failure.message}`,
        );
      }
    } finally {
      connectingRef.current = false;
      switchingRef.current = false;
      setSwitching(false);
      setBusy(false);
      void synchronizeRef.current();
    }
  }
  const tasks = session?.turns.flatMap((t) => t.tasks) || [];
  function resetSettingsDraft() {
    setSettingsKind(
      config?.sourceKind === "chatgpt-mcp" ? "chatgpt-mcp" : "codex",
    );
    setSelectedProject(config?.mcpProjectId || "");
    setProjectInput(config?.project || "");
    setSourceInput(config?.sessionsRoot || "");
    settingsDirtyRef.current = false;
    setSettingsDirty(false);
    setFormError(null);
  }
  function openSettings() {
    resetSettingsDraft();
    setSettings(true);
  }
  function closeSettings() {
    if (busy || importBusy) return;
    resetSettingsDraft();
    setSettings(false);
  }
  function onSettingsKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSettings();
    }
    if (event.key !== "Tab") return;
    const root = event.currentTarget;
    const controls = [
      ...root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [href], [tabindex="0"]',
      ),
    ].filter((el) => el.getClientRects().length > 0);
    const first = controls[0],
      last = controls.at(-1),
      active = document.activeElement;
    if (!first) {
      event.preventDefault();
      root.focus();
    } else if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (active === last || active === root)) {
      event.preventDefault();
      first.focus();
    }
  }
  function chooseRecordedProject(project: string) {
    setSettingsKind("codex");
    setProjectInput(project);
    if (config) setSourceInput(config.sessionsRoot);
    settingsDirtyRef.current = true;
    setSettingsDirty(true);
    setFormError(null);
    setSettings(true);
  }
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <GitBranch size={20} />
          </span>
          <strong>Codex Flow</strong>
        </div>
        <div className="header-actions">
          <button
            className="settings-button"
            disabled={busy || settings}
            onClick={openSettings}
          >
            <Settings2 size={13} />
            설정
          </button>
        </div>
      </header>
      <div className="workspace" inert={settings || switching || busy}>
        <aside className="sidebar">
          <span className="eyebrow">
            {isChatGpt ? "현재 기록 출처" : "현재 프로젝트"}
          </span>
          <button className="project-card" onClick={openSettings}>
            <span className="project-symbol">
              <Layers3 size={23} />
            </span>
            <span>
              <strong>
                {isChatGpt
                  ? config?.mcpProjectName || "ChatGPT 대화"
                  : config
                    ? basename(config.project)
                    : "프로젝트"}
              </strong>
              <small>{isChatGpt ? "직접 연결 기록" : "Codex 작업 기록"}</small>
            </span>
            <ChevronDown size={13} />
          </button>
          <div className="sidebar-heading">
            <span>대화</span>
            <small>{sessions.length}</small>
          </div>
          <nav aria-label="프로젝트 대화">
            {sessions.map((s) => (
              <button
                key={s.id}
                className={`conversation ${session?.id === s.id ? "active" : ""}`}
                onClick={() =>
                  loadSession(s.id, true).catch((e) => setError(e.message))
                }
              >
                <strong>{s.title}</strong>
                <small>
                  질문 {s.turnCount}개 · {isChatGpt ? "답변" : "작업"}{" "}
                  {s.taskCount}개
                </small>
                <span>
                  <i />{" "}
                  {isChatGpt
                    ? "MCP 전달 기록"
                    : s.status === "running"
                      ? "작업 진행 중"
                      : "저장된 실행 기록"}
                </span>
              </button>
            ))}
            {!sessions.length && (
              <p className="sidebar-empty">연결된 대화가 없습니다.</p>
            )}
          </nav>
          <div className="sidebar-heading pins-heading">
            <span>고정한 작업</span>
            <Pin size={12} />
          </div>
          <nav className="pinned-list" aria-label="고정한 작업">
            {view.pinned.map((id) => {
              const task = tasks.find((t) => t.id === id),
                turn = session?.turns.find((t) => t.id === id);
              return task || turn ? (
                <button key={id} onClick={() => navigateTo(id)}>
                  <i />
                  {view.titles[id] || task?.title || turn?.title}
                </button>
              ) : null;
            })}
            {!view.pinned.length && (
              <p className="sidebar-empty">다시 볼 작업을 고정해 두세요.</p>
            )}
          </nav>
          <figure className="cinema-vignette">
            <figcaption>
              A LITTLE MISCHIEF <span aria-hidden="true">✦</span>
            </figcaption>
            <img
              src="/artwork/tom-jerry-mischief.png"
              alt="치즈를 사이에 두고 장난치는 톰과 제리"
              width="1536"
              height="1024"
              draggable={false}
            />
            <strong>조용할 틈 없는 작업실</strong>
            <p>오늘도 이야기는 계속됩니다.</p>
          </figure>
          <div className="connection-card">
            <strong>
              <i className={online ? "" : "offline"} />
              {online ? "로컬 기록 연결" : "연결 확인 중"}
            </strong>
            <p>
              {isChatGpt ? "도구로 전달된 기록 표시" : "선택한 프로젝트만 표시"}
            </p>
            <small>
              {session
                ? `갱신 ${new Date(session.loadedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                : "설정에서 기록 경로를 확인하세요."}
            </small>
          </div>
        </aside>
        <main className="main-panel">
          <div className="scene-backdrop" aria-hidden="true">
            <img
              src="/artwork/tom-jerry-background.png"
              alt=""
              draggable={false}
            />
          </div>
          <div className="main-heading">
            <span className="eyebrow edition-label">
              TOM &amp; JERRY EDITION
            </span>
            <div className="title-row">
              <h1 title={sessions.find((s) => s.id === session?.id)?.title}>
                {mode === "overview"
                  ? "한눈에 보기"
                  : "질문은 이어지고, 작업은 쌓이고."}
              </h1>
            </div>
            <div className="search-navigation">
              <div className="search-field">
                <Search size={14} />
                <input
                  aria-label="기록 검색"
                  placeholder={
                    isChatGpt
                      ? "질문, 답변, 메모 검색"
                      : "질문, 작업, 파일 검색"
                  }
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    aria-label="검색 지우기"
                    onClick={() => setSearch("")}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              <div className="reading-tools-host" ref={setReadingToolsHost} />
            </div>
            <p
              className="conversation-context"
              title={sessions.find((s) => s.id === session?.id)?.title}
            >
              {sessions.find((s) => s.id === session?.id)?.title ||
                "프로젝트의 질문에서 바뀐 파일과 원본 근거까지"}
            </p>
            <div className="toolbar">
              <div className="segmented">
                <button
                  className={mode === "tasks" ? "selected" : ""}
                  onClick={() => setMode("tasks")}
                >
                  작업 보기
                </button>
                <button
                  className={mode === "overview" ? "selected" : ""}
                  onClick={() => setMode("overview")}
                >
                  한눈에 보기
                </button>
              </div>
              {!isChatGpt && (
                <label className="filter-control">
                  <SlidersHorizontal size={12} />
                  <select
                    aria-label="기록 필터"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">필터</option>
                    <option value="running">진행 중</option>
                    <option value="failed">실패 / 중단</option>
                    <option value="unverified">확인 근거 없음</option>
                  </select>
                </label>
              )}
              <div className="flow-count">
                <i />
                질문{" "}
                {session?.turns.filter((t) => t.requests.length).length || 0}
                <span>
                  {isChatGpt ? "답변" : "작업"} {tasks.length}
                </span>
              </div>
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button aria-label="오류 닫기" onClick={() => setError("")}>
                <X size={14} />
              </button>
            </div>
          )}
          {config?.notice && (
            <div className="warning-banner">{config.notice}</div>
          )}
          {session?.sourceKind === "chatgpt-mcp" && (
            <details className="chatgpt-coverage">
              <summary>
                MCP 전달 기록 · 질문·답변 {session.turns.length}쌍 · 마지막 수신{" "}
                {session.latestTimestamp
                  ? new Date(session.latestTimestamp).toLocaleString("ko-KR")
                  : "아직 없음"}
              </summary>
              {session.limitations.map((v, i) => (
                <p key={i}>{v}</p>
              ))}
            </details>
          )}
          {session && (session.invalidLines.length > 0 || config?.error) && (
            <div className="warning-banner">
              불러오기 제한 ·{" "}
              {session.invalidLines.length > 0
                ? `읽지 못한 줄 ${session.invalidLines.length}개`
                : `${config?.error} · 화면은 마지막으로 읽은 기록을 유지합니다.`}
            </div>
          )}
          {isChatGpt && session?.coverage && (
            <details
              className="chatgpt-coverage"
              data-testid="chatgpt-coverage"
            >
              <summary>
                ChatGPT 원문 사본 ·{" "}
                {session.coverage.traversal === "complete"
                  ? "페이지 순회 끝까지 확인"
                  : "페이지 일부"}{" "}
                ·{" "}
                {session.coverage.text === "partial"
                  ? "본문 일부"
                  : "읽은 텍스트 보존"}{" "}
                · 잘린 메시지 {session.coverage.truncatedMessages}개
              </summary>
              <p>
                수집{" "}
                {session.capturedAt &&
                  new Date(session.capturedAt).toLocaleString("ko-KR")}{" "}
                · 가져옴{" "}
                {session.importedAt &&
                  new Date(session.importedAt).toLocaleString("ko-KR")}
              </p>
              {session.limitations.map((text, i) => (
                <p key={i}>{text}</p>
              ))}
            </details>
          )}
          {session?.pendingBytes ? (
            <div className="tail-notice">
              작성 중인 마지막 줄은 다음 갱신까지 보류합니다.
            </div>
          ) : null}
          <div className="flow-container">
            {session ? (
              mode === "overview" ? (
                <OverviewTimeline
                  key={session.id}
                  session={session}
                  view={view}
                  matching={matching}
                  filtered={Boolean(search.trim()) || filter !== "all"}
                  toolsHost={readingToolsHost}
                  follow={follow}
                  newCount={newCount}
                  focusTarget={focusTarget}
                  onFocusHandled={onFocusHandled}
                  initialScrollTop={overviewScroll.current[session.id] || 0}
                  onScrollTop={(top) => {
                    overviewScroll.current[session.id] = top;
                  }}
                  onSelect={onSelect}
                  onFollow={onFollow}
                />
              ) : (
                <FlowCanvas
                  toolsHost={readingToolsHost}
                  session={session}
                  view={view}
                  matching={matching}
                  filtered={Boolean(search.trim()) || filter !== "all"}
                  follow={follow}
                  newCount={newCount}
                  focusTarget={focusTarget}
                  onFocusHandled={onFocusHandled}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  onView={onView}
                  onFollow={onFollow}
                />
              )
            ) : (
              <div className="welcome">
                <div className="welcome-icon">
                  <GitBranch size={35} />
                </div>
                <h2>
                  {busy
                    ? "프로젝트 기록을 읽고 있습니다"
                    : "프로젝트의 흐름을 연결하세요"}
                </h2>
                {config?.diagnostics ? (
                  <ConnectionReport
                    diagnostics={config.diagnostics}
                    onChoose={chooseRecordedProject}
                  />
                ) : (
                  <p>
                    {config?.error ||
                      "프로젝트 폴더와 Codex 기록 경로를 지정하면 실제 질문과 작업이 표시됩니다."}
                  </p>
                )}
                <button className="primary-button" onClick={openSettings}>
                  <FolderOpen size={16} />
                  기록 연결 설정
                  <ArrowRight size={15} />
                </button>
                <span>기록에 남은 내용을 읽기만 합니다.</span>
              </div>
            )}
          </div>
        </main>
        {session ? (
          <Details
            session={session}
            view={view}
            tab={tab}
            onTab={setTab}
            onView={onView}
            onSelect={onSelect}
          />
        ) : (
          <aside className="details-panel empty-detail">
            <Activity size={29} />
            <h2>작업의 맥락을 한눈에</h2>
            <p>
              질문과 실행 기록을 연결하면
              <br />
              파일 변경과 근거가 이곳에 표시됩니다.
            </p>
          </aside>
        )}
      </div>
      {settings && (
        <div className="modal-backdrop" onClick={closeSettings}>
          <form
            className="settings-modal"
            ref={settingsForm}
            tabIndex={-1}
            onKeyDown={onSettingsKeyDown}
            role="dialog"
            aria-modal="true"
            aria-label="기록 연결 설정"
            onSubmit={saveConfig}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title">
              <span>
                <FolderOpen size={18} />
                기록 연결 설정
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="설정 닫기"
                disabled={busy || importBusy}
                onClick={closeSettings}
              >
                <X size={19} />
              </button>
            </div>
            <div
              className="record-source-choice"
              role="group"
              aria-label="기록 종류"
            >
              <button
                type="button"
                aria-pressed={settingsKind === "codex"}
                disabled={busy || importBusy}
                onClick={() => {
                  setSettingsKind("codex");
                  settingsDirtyRef.current = true;
                  setFormError(null);
                }}
              >
                Codex 프로젝트
              </button>
              <button
                type="button"
                aria-pressed={settingsKind === "chatgpt-mcp"}
                disabled={busy || importBusy}
                onClick={() => {
                  setSettingsKind("chatgpt-mcp");
                  settingsDirtyRef.current = true;
                  setFormError(null);
                }}
              >
                ChatGPT 대화
              </button>
            </div>
            {settingsKind === "chatgpt-mcp" ? (
              <>
                <DirectConnection
                  selected={selectedProject}
                  onSelect={(id) => {
                    setSelectedProject(id);
                    settingsDirtyRef.current = true;
                    setFormError(null);
                  }}
                  disabled={busy}
                  onBusy={setImportBusy}
                />
                {formError && <ConnectionFormError error={formError} />}
              </>
            ) : (
              <>
                <p className="settings-description">
                  실제 프로젝트 폴더와 정확히 일치하는 Codex 대화만 표시합니다.
                  ChatGPT 채팅 제목은 폴더 경로로 입력하지 마세요.
                </p>
                {config?.diagnostics && (
                  <RecordedProjectPicker
                    projects={config.diagnostics.availableProjects}
                    onChoose={chooseRecordedProject}
                    disabled={busy}
                  />
                )}
                <label htmlFor="project-path">프로젝트 폴더</label>
                <input
                  id="project-path"
                  value={projectInput}
                  disabled={busy}
                  onChange={(e) => {
                    setProjectInput(e.target.value);
                    settingsDirtyRef.current = true;
                    setSettingsDirty(true);
                    setFormError(null);
                  }}
                  required
                  placeholder="C:\\Projects\\my-project"
                />
                <label htmlFor="source-path">
                  Codex 기록 폴더 또는 JSONL·ZST 파일
                </label>
                <input
                  id="source-path"
                  value={sourceInput}
                  disabled={busy}
                  onChange={(e) => {
                    setSourceInput(e.target.value);
                    settingsDirtyRef.current = true;
                    setSettingsDirty(true);
                    setFormError(null);
                  }}
                  required
                />
                <div className="settings-help">
                  <CircleHelp size={16} />
                  <p>
                    기록 폴더에는 .codex 또는 sessions를 입력할 수 있습니다.
                    보관된 대화와 압축 기록도 함께 확인하며 2초 간격으로
                    갱신합니다. 원본 기록과 그 안의 명령은 실행하거나 수정하지
                    않습니다.
                  </p>
                </div>
                {!settingsDirty && config?.diagnostics && (
                  <ConnectionReport
                    diagnostics={config.diagnostics}
                    onChoose={chooseRecordedProject}
                    showProjects={false}
                  />
                )}
                {busy && (
                  <p role="status">폴더와 대화 기록을 확인하고 있습니다…</p>
                )}
                {formError && <ConnectionFormError error={formError} />}
                <button
                  className="primary-button"
                  disabled={busy}
                  type="submit"
                >
                  {busy ? "연결하는 중…" : "프로젝트 연결"}
                  <ArrowUpRight size={15} />
                </button>
              </>
            )}
          </form>
        </div>
      )}
    </div>
  );
}
