import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  Controls,
  Panel,
  useReactFlow,
  useStore,
  type Node,
  type Edge,
  type NodeProps,
  type NodeChange,
  applyNodeChanges,
} from "@xyflow/react";
import {
  Check,
  Clock3,
  CircleHelp,
  ChevronDown,
  ChevronRight,
  GitBranch,
  LocateFixed,
  Pin,
  AlertCircle,
} from "lucide-react";
import type { Preferences, Session, Status, Task, Turn } from "./types";
import { displayStatus, uniqueFiles } from "./types";
import {
  FLOW_NODE_SIZE,
  FLOW_COMPACT_NODE_SIZE,
  FLOW_READING_TOP,
  FLOW_SCROLLBAR_WIDTH,
  flowContentBounds,
  layoutFlowGroups,
  readingViewport,
  wheelViewport,
} from "./layout";
import FlowScrollBar from "./FlowScrollBar";

interface CardData extends Record<string, unknown> {
  turn?: Turn;
  task?: Task;
  number?: number;
  selected: boolean;
  expanded?: boolean;
  title?: string;
  pinned?: boolean;
  onToggle?: () => void;
  failed?: boolean;
}
function StatusIcon({ status }: { status: Status }) {
  const Icon =
    status === "running"
      ? Clock3
      : status === "completed"
        ? Check
        : status === "unknown"
          ? CircleHelp
          : AlertCircle;
  return (
    <span className={`status-icon ${status}`}>
      <Icon size={13} strokeWidth={1.8} />
    </span>
  );
}
function RequestCard({ data: input }: NodeProps) {
  const data = input as CardData,
    turn = data.turn!;
  return (
    <div
      className={`request-card nodrag nopan ${data.selected ? "chosen" : ""}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="time-in"
        style={{ left: -40, top: FLOW_NODE_SIZE.request.height / 2 }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="time-out"
        style={{ left: -40, bottom: FLOW_NODE_SIZE.request.height / 2 }}
      />
      <Handle type="source" position={Position.Bottom} id="tasks" />
      <span
        className={`request-number ${turn.status === "running" ? "current" : ""}`}
      >
        {String(data.number).padStart(2, "0")}
      </span>
      <div className="request-copy">
        <strong>{turn.title}</strong>
        <p>
          {turn.result
            .replace(/[#*`]/g, "")
            .replace(/\s+/g, " ")
            .slice(0, 92) ||
            `${turn.requests.length}개 요청 · ${turn.tasks.length}개 작업 기록`}
        </p>
      </div>
      <span className={`status-pill ${turn.status}`}>
        {displayStatus(turn.status, turn.sourceKind)}
      </span>
      <button
        className="expand-button nodrag"
        aria-label={`${turn.title} 작업 ${data.expanded ? "접기" : "펼치기"}`}
        onClick={(event) => {
          event.stopPropagation();
          data.onToggle?.();
        }}
      >
        {data.expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
    </div>
  );
}
function TaskCard({ data: input }: NodeProps) {
  const data = input as CardData,
    task = data.task!,
    files = uniqueFiles(task.files);
  return (
    <div
      className={`task-card nodrag nopan ${data.selected ? "chosen" : ""}`}
      data-testid={`task-${task.id}`}
    >
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Right} id="correction" />
      <div className="task-heading">
        <StatusIcon status={task.status} />
        <strong>{data.title || task.title}</strong>
        {data.pinned && <Pin size={12} className="pin-small" />}
      </div>
      <p>
        {task.text.replace(/[#*`]/g, "").replace(/\s+/g, " ").slice(0, 105)}
      </p>
      <div className="task-footer">
        <span className={data.failed ? "attempt-failed" : ""}>
          {data.failed
            ? "실패한 시도 기록 있음"
            : task.kind === "description"
              ? task.sourceKind === "chatgpt-mcp"
                ? "MCP 전달 기록"
                : task.sourceKind === "chatgpt"
                  ? task.truncated
                    ? "답변 일부 · 원문 사본"
                    : "답변 원문 사본"
                  : "설명 기록 · 실행 근거 없음"
              : task.status === "running"
                ? "기록 수집 중"
                : "기능 확인 근거 없음"}
        </span>
        {files.length > 0 && (
          <span className="file-count">파일 {files.length} →</span>
        )}
      </div>
    </div>
  );
}
const nodeTypes = { request: RequestCard, task: TaskCard };

interface Props {
  toolsHost: HTMLElement | null;
  session: Session;
  view: Preferences;
  matching: Set<string>;
  filtered: boolean;
  follow: boolean;
  newCount: number;
  focusTarget: { id: string; nonce: number } | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onView: (value: Partial<Preferences>) => void;
  onFollow: (value: boolean) => void;
  onFocusHandled: (nonce: number) => void;
}
function Canvas(props: Props) {
  const {
    session,
    view,
    matching,
    filtered,
    follow,
    newCount,
    focusTarget,
    onSelect,
    onToggle,
    onView,
    onFollow,
    toolsHost,
    onFocusHandled,
  } = props;
  const flow = useReactFlow();
  const canvasWidth = useStore((state) => state.width);
  const columns = canvasWidth > 0 && canvasWidth < 900 ? 1 : 2;
  const nodeSizes = columns === 1 ? FLOW_COMPACT_NODE_SIZE : FLOW_NODE_SIZE;
  const container = useRef<HTMLDivElement>(null);
  const initial = useRef(false);
  const previousColumns = useRef(columns);
  const autoPositions = useRef<Record<string, { x: number; y: number }>>({});
  const arrangement = useRef("");
  const focused = useRef<number | null>(null);
  const lastFollowed = useRef("");
  const [nodes, setNodes] = useState<Node[]>([]);
  const graph = useMemo(() => {
    const result: Node[] = [],
      edges: Edge[] = [];
    const signature = `${columns}:${view.expanded.join(",")}:${filtered}`;
    const stable = layoutFlowGroups(
      session.turns.map((turn) => ({
        id: turn.id,
        tasks: turn.tasks.map((task) => task.id),
        expanded: view.expanded.includes(turn.id) || filtered,
      })),
      arrangement.current === signature ? autoPositions.current : {},
      columns,
    );
    // Old free-drag positions can cut across another request's task band.
    // Blocks are fixed now, so restore the structured layout rather than those offsets.
    autoPositions.current = stable;
    arrangement.current = signature;
    let previous: string | null = null;
    session.turns.forEach((turn, index) => {
      const tasks = turn.tasks;
      const turnVisible =
        !filtered ||
        matching.has(turn.id) ||
        tasks.some((task) => matching.has(task.id));
      const expanded = view.expanded.includes(turn.id) || filtered;
      const request: Node = {
        id: turn.id,
        type: "request",
        position: stable[turn.id],
        style: nodeSizes.request,
        hidden: !turnVisible,
        data: {
          turn,
          number: index + 1,
          selected: view.selected === turn.id,
          expanded,
          onToggle: () => onToggle(turn.id),
        },
        ariaLabel: turn.title,
      };
      result.push(request);
      if (previous)
        edges.push({
          id: `time:${previous}:${turn.id}`,
          source: previous,
          target: turn.id,
          sourceHandle: "time-out",
          targetHandle: "time-in",
          type: "smoothstep",
          style: { stroke: "#c7b797", strokeWidth: 1.5 },
        });
      if (expanded)
        tasks.forEach((task) => {
          result.push({
            id: task.id,
            type: "task",
            position: stable[task.id],
            style: nodeSizes.task,
            hidden:
              filtered && !matching.has(task.id) && !matching.has(turn.id),
            data: {
              task,
              selected: view.selected === task.id,
              title: view.titles[task.id],
              pinned: view.pinned.includes(task.id),
              failed: session.evidence.some(
                (e) =>
                  task.evidenceIds.includes(e.id) &&
                  (e.status === "failed" ||
                    (e.exitCode != null && e.exitCode !== 0)),
              ),
            },
            ariaLabel: view.titles[task.id] || task.title,
          });
          edges.push({
            id: `branch:${task.id}`,
            source: turn.id,
            target: task.id,
            sourceHandle: "tasks",
            type: "smoothstep",
            style: { stroke: "#acb6b0", strokeWidth: 1.4 },
          });
        });
      previous = turn.id;
    });
    for (const relation of view.relations)
      if (
        result.some((n) => n.id === relation.source) &&
        result.some((n) => n.id === relation.target)
      )
        edges.push({
          id: `correction:${relation.source}:${relation.target}`,
          source: relation.source,
          target: relation.target,
          sourceHandle: "correction",
          label: "수정 · 수동 연결",
          type: "smoothstep",
          style: { stroke: "#bb7563", strokeDasharray: "5 5" },
          labelStyle: { fill: "#995b4b", fontSize: 10 },
          labelBgStyle: { fill: "#fff5ea" },
        });
    for (const edge of edges)
      edge.hidden = result.some(
        (node) =>
          (node.id === edge.source || node.id === edge.target) && node.hidden,
      );
    return { nodes: result, edges };
  }, [
    session,
    view.selected,
    view.expanded,
    view.titles,
    view.pinned,
    view.relations,
    filtered,
    matching,
    columns,
    nodeSizes,
    onToggle,
  ]);
  useEffect(() => {
    setNodes(graph.nodes);
  }, [graph]);
  const contentBounds = useMemo(
    () => flowContentBounds(nodes, nodeSizes),
    [nodes, nodeSizes],
  );
  function userMovement() {
    initial.current = true;
    onFollow(false);
  }
  function fitReading(fromStart: boolean) {
    userMovement();
    const bounds = container.current?.getBoundingClientRect();
    if (!bounds) return;
    const current = flow.getViewport();
    void flow.setViewport(
      readingViewport(
        bounds.width - FLOW_SCROLLBAR_WIDTH,
        contentBounds,
        fromStart
          ? contentBounds.top
          : (FLOW_READING_TOP - current.y) / current.zoom,
      ),
    );
  }
  function jumpToBottom() {
    userMovement();
    const height = container.current?.clientHeight;
    if (!height) return;
    const current = flow.getViewport();
    void flow.setViewport({
      ...current,
      y: Math.min(
        FLOW_READING_TOP - contentBounds.top * current.zoom,
        height - contentBounds.bottom * current.zoom - 96,
      ),
    });
  }
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      if (
        !event.ctrlKey &&
        event.target instanceof Element &&
        event.target.closest(".flow-scrollbar")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      initial.current = true;
      onFollow(false);
      const rect = element!.getBoundingClientRect();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      const current = flow.getViewport();
      const next = wheelViewport(
        current,
        delta,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        event.ctrlKey,
      );
      if (!event.ctrlKey) {
        const top = FLOW_READING_TOP - contentBounds.top * current.zoom;
        const bottom = Math.min(
          top,
          rect.height - contentBounds.bottom * current.zoom - 96,
        );
        // A dragged/zoomed overscroll may return naturally, but wheel cannot enlarge it.
        next.y = Math.min(
          Math.max(top, current.y),
          Math.max(Math.min(bottom, current.y), next.y),
        );
      }
      void flow.setViewport(next);
    }
    element.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => element.removeEventListener("wheel", wheel, { capture: true });
  }, [flow, onFollow, contentBounds]);
  useEffect(() => {
    if (initial.current || !nodes.length) return;
    if (follow || focusTarget) {
      initial.current = true;
      return;
    }
    const timer = setTimeout(() => {
      if (initial.current) return;
      initial.current = true;
      const saved = view.viewport;
      const bounds = container.current?.getBoundingClientRect();
      const hasVisibleNode =
        saved &&
        bounds &&
        graph.nodes.some((node) => {
          if (node.hidden) return false;
          const x = node.position.x * saved.zoom + saved.x;
          const y = node.position.y * saved.zoom + saved.y;
          const size = nodeSizes[node.type === "request" ? "request" : "task"];
          const width = size.width * saved.zoom;
          const height = size.height * saved.zoom;
          return (
            x < bounds.width &&
            x + width > 0 &&
            y < bounds.height &&
            y + height > 0
          );
        });
      if (saved && hasVisibleNode) flow.setViewport(saved);
      else if (bounds)
        flow.setViewport(
          readingViewport(
            bounds.width - FLOW_SCROLLBAR_WIDTH,
            flowContentBounds(graph.nodes, nodeSizes),
          ),
        );
    }, 100);
    return () => clearTimeout(timer);
  }, [graph, nodes.length, flow, session.id, follow, focusTarget, nodeSizes]);
  useEffect(() => {
    if (previousColumns.current === columns) return;
    previousColumns.current = columns;
    if (!initial.current || follow) return;
    const bounds = container.current?.getBoundingClientRect();
    if (!bounds) return;
    const current = flow.getViewport();
    const worldTop = (FLOW_READING_TOP - current.y) / current.zoom;
    // Before the new nodes commit, retain the record nearest the reading line.
    const anchor = nodes
      .filter((node) => !node.hidden)
      .reduce<Node | undefined>(
        (best, node) =>
          !best ||
          Math.abs(node.position.y - worldTop) <
            Math.abs(best.position.y - worldTop)
            ? node
            : best,
        undefined,
      );
    const next = graph.nodes.find((node) => node.id === anchor?.id);
    void flow.setViewport(
      readingViewport(
        bounds.width - FLOW_SCROLLBAR_WIDTH,
        flowContentBounds(graph.nodes, nodeSizes),
        anchor && next
          ? next.position.y + worldTop - anchor.position.y
          : worldTop,
      ),
    );
  }, [columns, nodes, graph, nodeSizes, flow, follow]);
  useEffect(() => {
    if (!focusTarget || focused.current === focusTarget.nonce) return;
    const target = nodes.find(
      (node) => node.id === focusTarget.id && !node.hidden,
    );
    if (!target) return;
    const timer = setTimeout(() => {
      focused.current = focusTarget.nonce;
      flow.setCenter(
        target.position.x +
          nodeSizes[target.type === "request" ? "request" : "task"].width / 2,
        target.position.y +
          nodeSizes[target.type === "request" ? "request" : "task"].height / 2,
        { zoom: Math.min(1, Math.max(0.7, flow.getZoom())), duration: 200 },
      );
      onFocusHandled(focusTarget.nonce);
    }, 100);
    return () => clearTimeout(timer);
  }, [focusTarget, nodes, flow]);
  useEffect(() => {
    if (!follow) {
      lastFollowed.current = "";
      return;
    }
    const latestTurn = session.turns.at(-1);
    const targetId = latestTurn?.tasks.at(-1)?.id || latestTurn?.id;
    const target = nodes.find((node) => node.id === targetId && !node.hidden);
    // Expanding a collapsed branch commits its new nodes on the next render.
    if (!target) return;
    const key = `${session.revision}:${target.id}:${target.position.x}:${target.position.y}`;
    if (lastFollowed.current === key) return;
    lastFollowed.current = key;
    flow.setCenter(
      target.position.x +
        nodeSizes[target.type === "request" ? "request" : "task"].width / 2,
      target.position.y +
        nodeSizes[target.type === "request" ? "request" : "task"].height / 2,
      { zoom: Math.min(flow.getZoom(), 1), duration: 250 },
    );
  }, [follow, session.revision, nodes, flow]);
  function onNodesChange(changes: NodeChange[]) {
    setNodes((old) => applyNodeChanges(changes, old));
  }
  return (
    <div
      className="canvas-frame"
      ref={container}
      style={
        {
          "--flow-request-width": `${nodeSizes.request.width}px`,
          "--flow-request-height": `${nodeSizes.request.height}px`,
          "--flow-task-width": `${nodeSizes.task.width}px`,
          "--flow-task-height": `${nodeSizes.task.height}px`,
        } as React.CSSProperties
      }
    >
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => onSelect(node.id)}
        onMoveStart={(event) => {
          if (event) userMovement();
        }}
        onMoveEnd={(_, viewport) => onView({ viewport })}
        nodesConnectable={false}
        nodesDraggable={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        zoomActivationKeyCode={null}
        autoPanOnNodeFocus={false}
        deleteKeyCode={null}
        minZoom={0.25}
        maxZoom={1.6}
        defaultViewport={view.viewport || { x: 10, y: 15, zoom: 0.85 }}
      >
        {toolsHost &&
          createPortal(
            <div className="reading-tools">
              <span>휠: 상하 이동 · Ctrl+휠: 확대</span>
              <button
                onClick={() => fitReading(false)}
                aria-label="작업 흐름 가로 맞춤"
              >
                가로 맞춤
              </button>
              <button
                onClick={() => fitReading(true)}
                aria-label="첫 질문으로 이동"
              >
                맨 위로 ↑
              </button>
              <button onClick={jumpToBottom} aria-label="마지막 기록으로 이동">
                맨 아래로 ↓
              </button>
            </div>,
            toolsHost,
          )}
        <Controls
          showInteractive={false}
          position="bottom-right"
          aria-label="화면 확대와 전체 맞춤"
        />
        <Panel position="bottom-left">
          <div className="graph-legend">
            <GitBranch size={13} />
            <span>질문 순서</span>
            <span className="legend-dash" />
            <span>이전 작업 수정</span>
          </div>
        </Panel>
        <Panel position="bottom-center">
          <button
            className={`follow-button ${follow ? "enabled" : ""}`}
            onClick={() => onFollow(!follow)}
          >
            <LocateFixed size={14} />
            {newCount > 0 && !follow ? `새 작업 ${newCount}개 · ` : ""}현재 작업
            따라가기
          </button>
        </Panel>
        {!graph.nodes.some((node) => !node.hidden) && (
          <div className="canvas-empty">조건에 맞는 기록이 없습니다.</div>
        )}
      </ReactFlow>
      <FlowScrollBar bounds={contentBounds} onScrollStart={userMovement} />
    </div>
  );
}
export default function FlowCanvas(props: Props) {
  return (
    <ReactFlowProvider key={props.session.id}>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
