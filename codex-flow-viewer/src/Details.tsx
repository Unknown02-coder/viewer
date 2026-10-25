import React, { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Clock3,
  Copy,
  FileCode2,
  FilePlus2,
  Link2,
  Pin,
  PinOff,
  X,
  ChevronRight,
  StickyNote,
  PencilLine,
} from "lucide-react";
import type {
  Evidence,
  FileChange,
  Preferences,
  Session,
  Tab,
  Task,
  Turn,
} from "./types";
import {
  basename,
  displayStatus,
  originalSnapshotUrl,
  uniqueFiles,
} from "./types";

interface Props {
  session: Session;
  view: Preferences;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onView: (value: Partial<Preferences>, save?: boolean) => Promise<boolean>;
  onSelect: (id: string) => void;
}
const fileLabel: Record<string, string> = {
  add: "생성",
  update: "수정",
  delete: "삭제",
  move: "이동",
  rename: "이동",
};
function FileCard({
  file,
  onEvidence,
}: {
  file: FileChange;
  onEvidence: (id: string) => void;
}) {
  return (
    <article className={`file-card ${file.kind === "add" ? "created" : ""}`}>
      <div className="file-heading">
        {file.kind === "add" ? (
          <FilePlus2 size={16} />
        ) : (
          <FileCode2 size={16} />
        )}
        <strong>{basename(file.path)}</strong>
        <span className={`file-badge ${file.kind}`}>
          {fileLabel[file.kind] || "변경"}
        </span>
      </div>
      <div className="file-path">{file.relativePath}</div>
      <div className="file-description">
        {file.diff
          ? "기록된 수정 내용"
          : file.content
            ? "기록된 생성 내용"
            : "변경 내용이 기록되지 않았습니다."}
        <span>
          {file.added !== null && `+${file.added}`}{" "}
          {file.removed !== null && `−${file.removed}`}
        </span>
      </div>
      {(file.diff || file.content) && (
        <details className="diff-preview" open={Boolean(file.diff)}>
          <summary>
            변경 내용 일부 <ChevronRight size={12} />
          </summary>
          <pre>
            {(file.diff || file.content)
              .split("\n")
              .slice(0, 80)
              .map((line, i) => (
                <span
                  key={i}
                  className={
                    line.startsWith("+") && !line.startsWith("+++")
                      ? "added-line"
                      : line.startsWith("-") && !line.startsWith("---")
                        ? "removed-line"
                        : ""
                  }
                >
                  {line || " "}
                  <br />
                </span>
              ))}
          </pre>
          {(file.diff || file.content).split("\n").length > 80 && (
            <p className="muted">
              앞 80줄 표시 · 전체 내용은 근거 기록에서 확인
            </p>
          )}
        </details>
      )}
      <button className="text-link" onClick={() => onEvidence(file.evidenceId)}>
        이 변경의 근거 <ArrowUpRight size={12} />
      </button>
    </article>
  );
}
function EvidenceCard({ evidence }: { evidence: Evidence }) {
  const [all, setAll] = useState(false);
  const names: Record<string, string> = {
    request: "사용자 요청",
    message: evidence.phase === "final_answer" ? "최종 답변" : "진행 설명",
    command: "명령 실행",
    file: "파일 변경",
    subagent: "하위 실행",
    "mcp-summary": "전달된 작업 요약",
  };
  const full =
    evidence.kind === "file"
      ? (evidence.attemptedFiles || evidence.files || [])
          .map(
            (f) =>
              `${f.kind}: ${f.path}\n${f.diff || f.content || "변경 내용 없음"}`,
          )
          .join("\n\n")
      : evidence.text;
  return (
    <article className="evidence-card" id={`evidence-${evidence.id}`}>
      <div className="evidence-heading">
        <strong>
          {evidence.receiverReference
            ? evidence.kind === "message"
              ? "전달받은 답변"
              : evidence.kind === "request"
                ? "전달받은 질문"
                : names[evidence.kind]
            : names[evidence.kind] || evidence.kind}
        </strong>
        <span>
          {evidence.receiverReference
            ? "MCP 전달"
            : evidence.reference
              ? `페이지 ${evidence.reference.page + 1}`
              : `줄 ${evidence.line}`}
        </span>
      </div>
      <p className="source-path" title={evidence.sourcePath}>
        {evidence.receiverReference
          ? `MCP 수신 ID · ${evidence.receiverReference.receiptId} · 수신 ${new Date(evidence.receiverReference.receivedAt).toLocaleString("ko-KR")}`
          : evidence.reference
            ? `원문 사본 · 턴 ${evidence.reference.turnId} · 메시지 ${evidence.reference.itemId}`
            : `원본 JSONL · ${basename(evidence.sourcePath)}:${evidence.line}`}
      </p>
      {evidence.truncated && (
        <p className="partial-notice">
          원본을 읽을 때 잘린 메시지입니다. 보이지 않는 뒷부분은 복원하지
          않았습니다.
        </p>
      )}
      {evidence.command && (
        <pre className="command-text">{evidence.command}</pre>
      )}
      {evidence.kind === "command" && (
        <p className="command-status">
          {evidence.status || "상태 미확인"} · exit{" "}
          {evidence.exitCode ?? "미확인"} · 기능 동작 확인은 별도
        </p>
      )}
      {evidence.kind === "file" && (
        <p className="command-status">
          처리 상태: {evidence.status || "미확인"}
        </p>
      )}
      <pre className="evidence-text">
        {all ? full : full.slice(0, 12000) || "표시할 본문이 없습니다."}
      </pre>
      {full.length > 12000 && (
        <button className="text-link" onClick={() => setAll(!all)}>
          {all ? "접기" : `전체 본문 보기 (${full.length.toLocaleString()}자)`}
        </button>
      )}
      <button
        className="text-link"
        onClick={() =>
          navigator.clipboard
            .writeText(
              evidence.receiverReference
                ? `${evidence.sourcePath} · MCP receipt ${evidence.receiverReference.receiptId}`
                : evidence.reference
                  ? `${evidence.sourcePath} · page ${evidence.reference.page} · turn ${evidence.reference.turnId} · item ${evidence.reference.itemId}`
                  : `${evidence.sourcePath}:${evidence.line}`,
            )
            .catch(() => {})
        }
      >
        <Copy size={11} />
        {evidence.receiverReference ? "수신 위치 복사" : "원본 위치 복사"}
      </button>
    </article>
  );
}

export default function Details({
  session,
  view,
  tab,
  onTab,
  onView,
  onSelect,
}: Props) {
  const direct = session.sourceKind === "chatgpt-mcp";
  const chatgpt = session.sourceKind === "chatgpt" || direct;
  let task: Task | undefined;
  const turn = session.turns.find((t) => {
    if (t.id === view.selected) return true;
    const found = t.tasks.find((v) => v.id === view.selected);
    if (found) {
      task = found;
      return true;
    }
    return false;
  });
  const [note, setNote] = useState(""),
    [title, setTitle] = useState(""),
    [saved, setSaved] = useState(false),
    [relation, setRelation] = useState("");
  const [focusEvidence, setFocusEvidence] = useState<string | null>(null);
  useEffect(() => {
    setNote(view.notes[view.selected || ""] || "");
    setTitle(
      view.titles[view.selected || ""] || task?.title || turn?.title || "",
    );
    setSaved(false);
    setFocusEvidence(null);
  }, [view.selected, session.id]);
  if (!turn)
    return (
      <aside className="details-panel empty-detail">
        <FileCode2 size={28} />
        <h2>흐름에서 작업을 선택하세요</h2>
        <p>
          수행한 작업과 변경 파일,
          <br />그 내용을 뒷받침하는 기록을 확인할 수 있습니다.
        </p>
      </aside>
    );
  const chosenId = task?.id || turn.id,
    files = task ? task.files : turn.tasks.flatMap((t) => t.files),
    distinct = uniqueFiles(files);
  const ids = task ? task.evidenceIds : turn.evidenceIds;
  const evidence = session.evidence.filter(
    (e) => ids.includes(e.id) || e.id === focusEvidence,
  );
  const currentTitle = view.titles[chosenId] || task?.title || turn.title;
  const pinned = view.pinned.includes(chosenId);
  const additions = distinct.filter((f) => f.kind === "add").length,
    updates = distinct.filter((f) => f.kind === "update").length;
  function showEvidence(id: string) {
    setFocusEvidence(id);
    onTab("evidence");
  }
  async function saveNote() {
    if (
      await onView(
        {
          notes: { ...view.notes, [chosenId]: note },
          titles: {
            ...view.titles,
            [chosenId]: title.trim() || task?.title || turn!.title,
          },
        },
        true,
      )
    )
      setSaved(true);
  }
  return (
    <aside className="details-panel">
      <div className="detail-header">
        <div className="detail-eyebrow">
          <span>
            {task ? (chatgpt ? "선택한 답변" : "선택한 작업") : "선택한 요청"}
          </span>
          <button
            aria-label="선택 닫기"
            className="icon-button"
            onClick={() => onView({ selected: null })}
          >
            <X size={18} />
          </button>
        </div>
        <div className="detail-icon">
          <Clock3 size={22} />
        </div>
        <h2 data-testid="details-title">{currentTitle}</h2>
        <div className="detail-status">
          <span className={`status-pill ${task?.status || turn.status}`}>
            {chatgpt
              ? displayStatus(task?.status || turn.status, session.sourceKind)
              : task?.kind === "description"
                ? "설명 기록"
                : displayStatus(task?.status || turn.status)}
          </span>
          <span className="neutral-pill">
            {chatgpt
              ? direct
                ? "MCP 전달"
                : turn.truncated
                  ? "본문 일부"
                  : "원문 사본"
              : "동작 확인 별도"}
          </span>
          <button
            className={`icon-button ${pinned ? "purple" : ""}`}
            aria-label={pinned ? "작업 고정 해제" : "작업 고정"}
            onClick={() =>
              onView({
                pinned: pinned
                  ? view.pinned.filter((id) => id !== chosenId)
                  : [...view.pinned, chosenId],
              })
            }
          >
            {pinned ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
        </div>
      </div>
      <div className="detail-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "summary"}
          onClick={() => onTab("summary")}
        >
          요약
        </button>
        <button
          role="tab"
          aria-selected={tab === "files"}
          onClick={() => onTab("files")}
        >
          {chatgpt ? (
            "파일 기록 없음"
          ) : (
            <>
              변경 파일 <b>{distinct.length}</b>
            </>
          )}
        </button>
        <button
          role="tab"
          aria-selected={tab === "evidence"}
          onClick={() => onTab("evidence")}
        >
          근거 기록 <b>{evidence.length}</b>
        </button>
      </div>
      <div className="detail-body" role="tabpanel">
        {tab === "summary" && (
          <>
            <div className="section-title">
              <h3>
                {direct
                  ? task
                    ? "받은 답변 본문"
                    : "받은 질문 본문"
                  : task
                    ? chatgpt
                      ? "답변 원문"
                      : "기록에 남은 작업 설명"
                    : "요청 원문"}
              </h3>
              <span>원문 발췌</span>
            </div>
            <p className="original-description">
              {task?.text || turn.requests.map((q) => q.text).join("\n\n")}
            </p>
            {chatgpt ? (
              <p className="partial-notice">
                {turn.truncated
                  ? "이 질문의 메시지 중 일부가 잘려 있습니다. "
                  : ""}
                {direct
                  ? "MCP로 전달받은 본문입니다. 전체 ChatGPT 원문으로 확인된 내용은 아닙니다."
                  : "수집된 대화 사본입니다."}{" "}
                파일 변경·명령 실행·검증 결과로 해석하지 않습니다.
              </p>
            ) : (
              <>
                <div className="verification-note">
                  <Check size={14} />
                  <div>
                    <strong>기능 동작 확인 근거 없음</strong>
                    <p>
                      명령 성공이나 턴 종료만으로 기능 검증을 확정하지 않습니다.
                    </p>
                  </div>
                </div>
                <p className="grouping-note">
                  작업 가지는 설명과 인접 실행의 시간순 묶음입니다. 작업
                  의존성을 의미하지 않습니다.
                </p>
              </>
            )}
            {turn.plans.length > 0 && (
              <details className="plans-record">
                <summary>계획 {turn.plans.length}개 · 수행 기록과 별도</summary>
                {turn.plans.map((plan) => (
                  <div key={plan.id}>
                    <p className="original-description">{plan.text}</p>
                    <button
                      className="text-link"
                      onClick={() => showEvidence(plan.evidenceId)}
                    >
                      계획의 원본 근거
                    </button>
                  </div>
                ))}
              </details>
            )}
            {!task && turn.result && (
              <details>
                <summary className="text-link">
                  {direct ? "받은 답변 펼치기" : "최종 답변 원문 펼치기"}
                </summary>
                <p className="original-description">{turn.result}</p>
              </details>
            )}
            {direct && turn.receivedSummary && (
              <section>
                <h3>전달된 작업 요약</h3>
                <p className="grouping-note">
                  질문·답변 본문과 별도로 전달된 요약입니다.
                </p>
                <p className="original-description">{turn.receivedSummary}</p>
              </section>
            )}
            <div className="section-title note-heading">
              <h3>
                <StickyNote size={14} /> 내 메모
              </h3>
              <span>앱에만 저장</span>
            </div>
            <label className="field-label" htmlFor="edited-title">
              표시할 제목 <PencilLine size={11} />
            </label>
            <input
              id="edited-title"
              aria-label="작업 제목 편집"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setSaved(false);
              }}
            />
            <textarea
              aria-label="작업 메모"
              placeholder="기억할 내용이나 확인할 사항을 남기세요."
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setSaved(false);
              }}
            />
            <div className="save-row">
              <button className="small-primary" onClick={saveNote}>
                메모 저장
              </button>
              {saved && <span className="saved-label">저장했습니다.</span>}
              {view.titles[chosenId] && (
                <span className="muted">사용자 편집</span>
              )}
            </div>
            {task && !chatgpt && (
              <div className="relation-editor">
                <h3>이전 작업 수정 관계</h3>
                <p className="muted">
                  기록에 없는 관계는 직접 연결할 수 있습니다.
                </p>
                <select
                  aria-label="수정할 이전 작업"
                  value={relation}
                  onChange={(e) => setRelation(e.target.value)}
                >
                  <option value="">이전 작업 선택</option>
                  {session.turns
                    .flatMap((t) => t.tasks)
                    .filter((t) => t.id !== chosenId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {view.titles[t.id] || t.title}
                      </option>
                    ))}
                </select>
                <button
                  className="secondary-button"
                  disabled={!relation}
                  onClick={() => {
                    if (
                      relation &&
                      !view.relations.some(
                        (r) => r.source === relation && r.target === chosenId,
                      )
                    )
                      onView({
                        relations: [
                          ...view.relations,
                          { source: relation, target: chosenId },
                        ],
                      });
                  }}
                >
                  수정 관계 연결
                </button>
                {view.relations
                  .filter((r) => r.target === chosenId)
                  .map((r) => (
                    <div className="manual-relation" key={r.source}>
                      수동 연결 ·{" "}
                      {
                        session.turns
                          .flatMap((t) => t.tasks)
                          .find((t) => t.id === r.source)?.title
                      }
                      <button
                        aria-label="수정 관계 삭제"
                        onClick={() =>
                          onView({
                            relations: view.relations.filter((v) => v !== r),
                          })
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
        {tab === "files" &&
          (chatgpt ? (
            <div className="empty-files">
              <p>이 입력에는 파일 변경 기록이 제공되지 않습니다.</p>
              <span>
                답변 속 코드와 경로를 실제 파일 변경으로 집계하지 않습니다.
              </span>
            </div>
          ) : (
            <>
              <div className="section-title">
                <h3>이 작업에서 바뀐 파일</h3>
                <span>{distinct.length}개 파일</span>
              </div>
              <div className="file-totals">
                <span className="file-badge add">생성 {additions}</span>
                <span className="file-badge update">수정 {updates}</span>
                {distinct.length > additions + updates && (
                  <span className="neutral-pill">
                    기타 {distinct.length - additions - updates}
                  </span>
                )}
              </div>
              {!files.length && (
                <div className="empty-files">
                  <FileCode2 size={23} />
                  <p>기록으로 확인된 파일 변경이 없습니다.</p>
                  <span>
                    파일 읽기와 결과물 링크는 변경 개수에 포함하지 않습니다.
                  </span>
                </div>
              )}
              {files.map((file) => (
                <FileCard key={file.id} file={file} onEvidence={showEvidence} />
              ))}
              {files.length > distinct.length && (
                <p className="muted">
                  {distinct.length}개 파일의 변경 이벤트 {files.length}건을
                  시간순으로 표시합니다.
                </p>
              )}
              {turn.artifacts.length > 0 && (
                <div className="linked-artifacts">
                  <div className="section-title">
                    <h3>연결된 결과물</h3>
                    <Link2 size={14} />
                  </div>
                  <p>
                    이 요청의 대화에 포함된 링크입니다. 생성·수정 여부와 현재
                    파일 존재는 확인하지 않았습니다.
                  </p>
                  {turn.artifacts.map((a) => (
                    <button
                      className="artifact-row"
                      key={a.id}
                      onClick={() => showEvidence(a.evidenceId)}
                    >
                      <FileCode2 size={15} />
                      <span>
                        <strong>{basename(a.path)}</strong>
                        <small>{a.path}</small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              )}
            </>
          ))}
        {tab === "evidence" && (
          <>
            <div className="section-title">
              <h3>이 작업의 원본 근거</h3>
              <span>읽기 전용</span>
            </div>
            <p className="source-path full">{session.sourcePath}</p>
            <p className="grouping-note">
              {chatgpt
                ? direct
                  ? "수신 ID와 수신 시각으로 MCP 전달 기록을 확인합니다."
                  : "수집한 페이지·턴·메시지 ID로 원문 사본과 연결합니다."
                : "기능 동작 확인 근거 없음"}
            </p>
            {[...evidence]
              .sort(
                (a, b) =>
                  Number(b.id === focusEvidence) -
                    Number(a.id === focusEvidence) || a.line - b.line,
              )
              .map((e) => (
                <EvidenceCard key={e.id} evidence={e} />
              ))}
            {!evidence.length && (
              <p className="muted">연결할 근거가 없습니다.</p>
            )}
          </>
        )}
      </div>
      <div className="detail-bottom">
        <span>이 작업이 속한 요청</span>
        <button onClick={() => onSelect(turn.id)}>
          {String(session.turns.indexOf(turn) + 1).padStart(2, "0")}
          <span>{turn.title}</span>
        </button>
        {direct ? (
          <span className="muted">
            MCP 수신 기록 · 원본 ChatGPT 링크는 제공되지 않았습니다.
          </span>
        ) : chatgpt && session.snapshotId ? (
          <a
            href={originalSnapshotUrl(session.id, session.snapshotId)}
            download
          >
            보존한 원문 사본 내려받기 <ArrowUpRight size={12} />
          </a>
        ) : (
          <a href={`codex://threads/${encodeURIComponent(session.id)}`}>
            원본 대화 열기 <ArrowUpRight size={12} />
          </a>
        )}
      </div>
    </aside>
  );
}
