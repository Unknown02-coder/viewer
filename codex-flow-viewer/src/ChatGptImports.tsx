import { useEffect, useState } from "react";
import { api } from "./api";
import type { ImportedConversation } from "./types";

export default function ChatGptImports({
  selected,
  onSelect,
  disabled,
  onBusy,
}: {
  selected: string;
  onSelect: (id: string) => void;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [list, setList] = useState<ImportedConversation[]>([]),
    [loading, setLoading] = useState(true),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    let alive = true;
    api<{ conversations: ImportedConversation[] }>("/api/chatgpt/imports")
      .then((value) => {
        if (alive) setList(value.conversations);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    setMessage("");
    setUploading(true);
    onBusy(true);
    try {
      if (file.size > 50 * 1024 * 1024)
        throw new Error("가져올 사본은 50 MiB 이하여야 합니다.");
      const response = await fetch("/api/chatgpt/imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "가져오지 못했습니다.");
      setMessage(result.message);
      const catalog = await api<{ conversations: ImportedConversation[] }>(
        "/api/chatgpt/imports",
      );
      setList(catalog.conversations);
      if (catalog.conversations.some((c) => c.id === result.id && c.available))
        onSelect(result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      onBusy(false);
    }
  }
  return (
    <section className="chatgpt-imports" aria-label="ChatGPT 대화 가져오기">
      <h2>저장한 ChatGPT 대화 가져오기</h2>
      <p>
        검증된 앱 도구 사본(.cflow.json)을 선택하세요. 폴더 경로나 채팅 제목을
        입력하지 않습니다.
      </p>
      <p className="muted">
        이 사본은 읽은 메시지만 담습니다. 잘린 답변·누락 페이지를 표시하며
        첨부파일과 숨겨진 분기의 완전성은 확인하지 않습니다. 계정 로그인이나
        자동 동기화는 제공하지 않습니다.
      </p>
      <label htmlFor="chatgpt-snapshot">ChatGPT 사본 파일</label>
      <input
        id="chatgpt-snapshot"
        type="file"
        accept=".json,.cflow.json,application/json"
        disabled={disabled || uploading}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void upload(file);
        }}
      />
      <p className="muted">
        원문 사본을 그대로 보존합니다. 중복·실패 시 기존 정상 기록과 메모를
        유지합니다. 일반 ChatGPT 내보내기 ZIP/JSON은 아직 지원하지 않습니다.
      </p>
      {(loading || uploading || message) && (
        <p role="status">
          {uploading
            ? "사본을 검증하고 저장하고 있습니다…"
            : loading
              ? "저장된 대화를 읽고 있습니다…"
              : message}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <label htmlFor="imported-conversation">저장된 대화</label>
      <select
        id="imported-conversation"
        value={selected}
        disabled={disabled || uploading || loading}
        onChange={(e) => onSelect(e.target.value)}
      >
        <option value="">대화를 선택하세요</option>
        {list.map((c) => (
          <option key={c.id} value={c.id} disabled={!c.available}>
            {c.title} · 질문 {c.turnCount}개 · {c.id.slice(-12)}
            {!c.available
              ? " · 사본 읽기 실패"
              : c.coverage?.text === "partial" ||
                  c.coverage?.traversal === "partial"
                ? " · 일부 기록"
                : ""}
          </option>
        ))}
      </select>
      {!loading && !list.length && <p>아직 가져온 대화가 없습니다.</p>}
      {selected && list.find((c) => c.id === selected)?.error && (
        <p role="alert">{list.find((c) => c.id === selected)?.error}</p>
      )}
      <p className="muted">
        가져오기만으로 현재 연결을 바꾸지 않습니다. 선택한 뒤 ‘대화 열기’를
        누르세요.
      </p>
      <button
        type="submit"
        className="primary-button"
        disabled={
          disabled ||
          uploading ||
          !list.some((c) => c.id === selected && c.available)
        }
      >
        대화 열기
      </button>
    </section>
  );
}
