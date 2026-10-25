import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { DirectStatus, DirectProject } from "./types";
export default function DirectConnection({
  selected,
  onSelect,
  disabled,
  onBusy,
}: {
  selected: string;
  onSelect: (id: string) => void;
  disabled: boolean;
  onBusy: (value: boolean) => void;
}) {
  const [projects, setProjects] = useState<DirectProject[]>([]),
    [status, setStatus] = useState<DirectStatus | null>(null),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [creating, setCreating] = useState(false),
    [copied, setCopied] = useState(false);
  const alive = useRef(true),
    ticket = useRef(0),
    retry = useRef<{ name: string; id: string } | null>(null);
  async function load() {
    const current = ++ticket.current;
    try {
      const [s, p] = await Promise.all([
        api<DirectStatus>("/api/direct/status"),
        api<{ projects: DirectProject[] }>("/api/direct/projects"),
      ]);
      if (alive.current && current === ticket.current) {
        setStatus(s);
        setProjects(p.projects);
        setError("");
      }
    } catch (e) {
      if (alive.current && current === ticket.current)
        setError((e as Error).message);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      alive.current = false;
      ++ticket.current;
      clearInterval(timer);
    };
  }, []);
  async function create() {
    if (!name.trim()) return;
    setCreating(true);
    onBusy(true);
    setError("");
    if (retry.current?.name !== name.trim())
      retry.current = { name: name.trim(), id: crypto.randomUUID() };
    try {
      const value = await api<{ projectId: string }>(
        "/api/direct/projects",
        "POST",
        { name: retry.current.name, requestId: retry.current.id },
      );
      await load();
      onSelect(value.projectId);
      retry.current = null;
      setName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
      onBusy(false);
    }
  }
  const prompt = selected
    ? `flow-viewer에서 projectId "${selected}"의 대화를 시작하고, 내가 기록을 요청하는 질문과 답변을 flow_record로 저장해줘. 질문·답변 본문과 작업 요약은 구분하고, 같은 전송을 재시도할 때 requestId를 재사용해줘.`
    : "";
  return (
    <section className="direct-connection" aria-label="ChatGPT 직접 연결">
      <h2>ChatGPT 직접 연결</h2>
      <p>
        데스크톱 앱의 <strong>flow-viewer</strong> 도구로 전달한 질문·답변이 이
        프로젝트에 쌓입니다.
      </p>
      <div className="settings-help">
        <div>
          <strong>
            {status?.activeClients.length
              ? "최근 MCP 연결 확인"
              : "MCP 연결 확인 대기"}
          </strong>
          <p>
            {status
              ? `수신 기록 ${status.recordCount}개 · 마지막 수신 ${status.lastReceivedAt ? new Date(status.lastReceivedAt).toLocaleString("ko-KR") : "아직 없음"}`
              : "연결 상태를 읽고 있습니다…"}
          </p>
          <p>
            질문·답변은 도구로 전달된 뒤 표시됩니다. 전체 계정의 과거 대화를
            가져오거나 모든 답변의 자동 전송을 보장하지 않습니다.
          </p>
        </div>
      </div>
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || creating}
        onClick={() => void load()}
      >
        상태 새로고침
      </button>
      <details>
        <summary>처음 연결하거나 도구를 갱신할 때</summary>
        <p>
          ChatGPT 데스크톱 설정 → 플러그인 → MCP에서{" "}
          <strong>flow-viewer</strong>를 켜세요. 도구가 보이지 않거나 연결
          확인만 가능한 구버전이면 서버를 껐다 켜고 새 로컬 작업 채팅에서
          flow_status를 호출하세요.
        </p>
        <p>
          서버 등록과 실제 도구 호출은 별도로 확인합니다. 이 화면의 새로고침은
          연결 상태를 다시 읽습니다.
        </p>
      </details>
      <label htmlFor="direct-project">직접 연결 프로젝트</label>
      <select
        id="direct-project"
        value={selected}
        disabled={disabled || creating}
        onChange={(e) => {
          onSelect(e.target.value);
          setCopied(false);
        }}
      >
        <option value="">프로젝트를 선택하세요</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · 대화 {p.conversationCount}개 · {p.id.slice(-8)}
          </option>
        ))}
      </select>
      {!projects.length && status && (
        <p>
          아직 직접 연결 프로젝트가 없습니다. 아래에서 새 프로젝트를 만들 수
          있습니다.
        </p>
      )}
      <label htmlFor="direct-project-name">새 프로젝트 이름</label>
      <div className="direct-project-create">
        <input
          id="direct-project-name"
          value={name}
          maxLength={200}
          disabled={disabled || creating}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: 리눅스 학습"
        />
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || creating || !name.trim()}
          onClick={() => void create()}
        >
          {creating ? "만드는 중…" : "프로젝트 만들기"}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {selected && (
        <details>
          <summary>ChatGPT에서 사용할 연결 문구</summary>
          <p className="source-path full">프로젝트 ID: {selected}</p>
          <p>{prompt}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              navigator.clipboard
                .writeText(prompt)
                .then(() => setCopied(true))
                .catch(() =>
                  setError(
                    "연결 문구를 복사하지 못했습니다. 위 내용을 직접 선택해 주세요.",
                  ),
                )
            }
          >
            {copied ? "복사했습니다" : "연결 문구 복사"}
          </button>
        </details>
      )}
      <p className="muted">
        프로젝트를 만들거나 선택하는 것만으로 현재 화면은 바뀌지 않습니다.
      </p>
      <button
        type="submit"
        className="primary-button"
        disabled={
          disabled || creating || !projects.some((p) => p.id === selected)
        }
      >
        프로젝트 열기
      </button>
    </section>
  );
}
