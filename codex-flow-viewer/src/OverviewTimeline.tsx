import React, { useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, FileCode2, LocateFixed } from "lucide-react";
import type { Preferences, Session } from "./types";
import { displayStatus } from "./types";
import { overviewRows } from "./overview";

interface Props {
  session: Session;
  view: Preferences;
  matching: Set<string>;
  filtered: boolean;
  toolsHost: HTMLElement | null;
  follow: boolean;
  newCount: number;
  focusTarget: { id: string; nonce: number } | null;
  initialScrollTop: number;
  onScrollTop: (top: number) => void;
  onSelect: (id: string) => void;
  onFollow: (value: boolean) => void;
  onFocusHandled: (nonce: number) => void;
}

export default function OverviewTimeline({
  session,
  view,
  matching,
  filtered,
  toolsHost,
  follow,
  newCount,
  focusTarget,
  initialScrollTop,
  onScrollTop,
  onSelect,
  onFollow,
  onFocusHandled,
}: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  const entries = useRef(new Map<string, HTMLButtonElement>());
  const applied = useRef<number | null>(null);
  const focused = useRef<number | null>(null);
  const initialTop = useRef(initialScrollTop);
  const rows = useMemo(
    () => overviewRows(session.turns, matching, filtered, session.evidence),
    [session.turns, matching, filtered, session.evidence],
  );
  function move(top: number) {
    if (!scroll.current) return;
    scroll.current.scrollTop = top;
    applied.current = scroll.current.scrollTop;
    onScrollTop(scroll.current.scrollTop);
  }
  function jump(end: boolean) {
    onFollow(false);
    move(end ? scroll.current?.scrollHeight || 0 : 0);
  }
  useLayoutEffect(() => {
    move(initialTop.current);
  }, []);
  useLayoutEffect(() => {
    if (!focusTarget || focused.current === focusTarget.nonce) return;
    const turn = session.turns.find(
      (t) =>
        t.id === focusTarget.id ||
        t.tasks.some((task) => task.id === focusTarget.id),
    );
    const entry = turn && entries.current.get(turn.id);
    const root = scroll.current;
    if (!entry || !root) return;
    focused.current = focusTarget.nonce;
    move(
      root.scrollTop +
        entry.getBoundingClientRect().top -
        root.getBoundingClientRect().top -
        (root.clientHeight - entry.offsetHeight) / 2,
    );
    onFocusHandled(focusTarget.nonce);
  }, [focusTarget, rows]);
  useLayoutEffect(() => {
    if (follow) move(scroll.current?.scrollHeight || 0);
  }, [follow, session.revision, rows]);
  return (
    <div className="overview-frame">
      {toolsHost &&
        createPortal(
          <div className="reading-tools">
            <span>휠: 상하 이동</span>
            <button onClick={() => jump(false)} aria-label="첫 질문으로 이동">
              맨 위로 ↑
            </button>
            <button
              onClick={() => jump(true)}
              aria-label="마지막 기록으로 이동"
            >
              맨 아래로 ↓
            </button>
          </div>,
          toolsHost,
        )}
      <div
        className="overview-scroll"
        ref={scroll}
        role="region"
        aria-label="질문 진행 타임라인"
        tabIndex={0}
        onWheel={() => onFollow(false)}
        onTouchMove={() => onFollow(false)}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          onScrollTop(top);
          if (applied.current !== null && Math.abs(top - applied.current) < 1) {
            applied.current = null;
            return;
          }
          applied.current = null;
          onFollow(false);
        }}
      >
        <div className="overview-heading">
          <span>
            질문 순서 <b>{rows.length}</b>
          </span>
          <span>
            {session.sourceKind === "chatgpt-mcp"
              ? "전달 본문 발췌"
              : "원문 발췌 중심"}
          </span>
        </div>
        <ol className="overview-list">
          {rows.map(({ turn, number, excerpt, excerptLabel, fileCount }) => {
            const selected =
              view.selected === turn.id ||
              turn.tasks.some((task) => task.id === view.selected);
            const title = view.titles[turn.id] || turn.title;
            return (
              <li key={turn.id} className={selected ? "is-current" : ""}>
                <button
                  className="overview-entry"
                  data-testid={`overview-${turn.id}`}
                  aria-pressed={selected}
                  ref={(element) => {
                    if (element) entries.current.set(turn.id, element);
                    else entries.current.delete(turn.id);
                  }}
                  onClick={() => onSelect(turn.id)}
                >
                  <div className="overview-entry-heading">
                    <span className="overview-number">
                      {String(number).padStart(2, "0")}
                    </span>
                    <strong title={title}>{title}</strong>
                    <ChevronRight size={14} />
                  </div>
                  <p className="overview-excerpt" title={excerpt}>
                    {excerpt || "표시할 답변이 아직 기록되지 않았습니다."}
                  </p>
                  <div className="overview-entry-meta">
                    <span className={`status-pill ${turn.status}`}>
                      {displayStatus(turn.status, session.sourceKind)}
                    </span>
                    {session.sourceKind === "chatgpt" ||
                    session.sourceKind === "chatgpt-mcp" ? (
                      <span>
                        {session.sourceKind === "chatgpt-mcp"
                          ? "MCP 전달"
                          : turn.truncated
                            ? "답변 일부"
                            : "원문 사본"}
                      </span>
                    ) : (
                      <span className="overview-files">
                        <FileCode2 size={12} />
                        파일 {fileCount}
                      </span>
                    )}
                    <span>{excerptLabel}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ol>
        {!rows.length && (
          <div className="overview-empty">
            {session.sourceKind === "chatgpt-mcp" && !session.turns.length
              ? "아직 전달받은 질문·답변이 없습니다."
              : "조건에 맞는 질문이 없습니다."}
          </div>
        )}
      </div>
      <div className="overview-footer">
        <span>
          {session.sourceKind === "chatgpt" ||
          session.sourceKind === "chatgpt-mcp"
            ? session.sourceKind === "chatgpt-mcp"
              ? "질문 → 답변 → MCP 수신 근거"
              : "질문 → 답변 → 원문 사본 근거"
            : "질문 → 답변 → 변경 파일 → 원본 근거"}
        </span>
        <button
          className={`follow-button ${follow ? "enabled" : ""}`}
          onClick={() => onFollow(!follow)}
        >
          <LocateFixed size={14} />
          {newCount > 0 && !follow ? `새 작업 ${newCount}개 · ` : ""}현재 작업
          따라가기
        </button>
      </div>
    </div>
  );
}
