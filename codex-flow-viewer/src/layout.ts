export interface Point {
  x: number;
  y: number;
}
export interface LayoutGroup {
  id: string;
  tasks: readonly string[];
  expanded: boolean;
}

/** Shared by layout, rendered cards and camera centering. */
export const FLOW_NODE_SIZE = {
  request: { width: 1088, height: 82 },
  task: { width: 498, height: 148 },
} as const;
export const FLOW_COMPACT_NODE_SIZE = {
  request: { width: 562, height: 82 },
  task: FLOW_NODE_SIZE.task,
} as const;
export interface FlowNodeSizes {
  request: { width: number; height: number };
  task: { width: number; height: number };
}
const columnStep = FLOW_NODE_SIZE.task.width + 28;
const rowStep = FLOW_NODE_SIZE.task.height + 28;
const taskOffset = FLOW_NODE_SIZE.request.height + 36;

/** Each request owns one vertical band, including all of its expanded task rows. */
export function layoutFlowGroups(
  groups: readonly LayoutGroup[],
  previous: Record<string, Point> = {},
  columns: 1 | 2 = 2,
): Record<string, Point> {
  const result: Record<string, Point> = {};
  let nextY = 0;
  for (const group of groups) {
    const priorY = previous[group.id]?.y;
    const y = Number.isFinite(priorY) && priorY >= nextY ? priorY : nextY;
    result[group.id] = { x: 64, y };
    if (group.expanded && group.tasks.length) {
      group.tasks.forEach((id, index) => {
        result[id] = {
          x: 80 + (index % columns) * columnStep,
          y: y + taskOffset + Math.floor(index / columns) * rowStep,
        };
      });
      nextY =
        y + taskOffset + Math.ceil(group.tasks.length / columns) * rowStep + 40;
    } else nextY = y + 130;
  }
  return result;
}

export interface FlowBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}
export interface FlowScrollRange {
  origin: number;
  top: number;
  height: number;
}
export const FLOW_READING_TOP = 56;
export const FLOW_SCROLLBAR_WIDTH = 18;

export function flowContentBounds(
  nodes: readonly { type?: string; position: Point; hidden?: boolean }[],
  sizes: FlowNodeSizes = FLOW_NODE_SIZE,
): FlowBounds {
  const visible = nodes.filter((node) => !node.hidden);
  if (!visible.length)
    return { left: 0, top: 0, right: sizes.request.width, bottom: 0 };
  return {
    left: Math.min(
      ...visible.map((n) => n.position.x - (n.type === "request" ? 57 : 0)),
    ),
    top: Math.min(...visible.map((n) => n.position.y)),
    right: Math.max(
      ...visible.map(
        (n) =>
          n.position.x + sizes[n.type === "request" ? "request" : "task"].width,
      ),
    ),
    bottom: Math.max(
      ...visible.map(
        (n) =>
          n.position.y +
          sizes[n.type === "request" ? "request" : "task"].height,
      ),
    ),
  };
}

/** Fit the reading width, never the height of an entire conversation. */
export function readingViewport(
  width: number,
  bounds: FlowBounds,
  worldTop = bounds.top,
): FlowViewport {
  const span = Math.max(1, bounds.right - bounds.left);
  const zoom = Math.min(1, Math.max(0.25, (width - 48) / span));
  return {
    x: (width - span * zoom) / 2 - bounds.left * zoom,
    y: FLOW_READING_TOP - worldTop * zoom,
    zoom,
  };
}

/** Retain an overscrolled extent until content/zoom/size changes, avoiding thumb drift. */
export function flowScrollRange(
  bounds: FlowBounds,
  viewport: FlowViewport,
  height: number,
  previous?: FlowScrollRange,
): FlowScrollRange {
  const origin = Math.max(
    FLOW_READING_TOP - bounds.top * viewport.zoom,
    viewport.y,
    previous?.origin ?? -Infinity,
  );
  const top = Math.max(0, origin - viewport.y);
  return {
    origin,
    top,
    height: Math.max(
      height,
      origin + bounds.bottom * viewport.zoom + 96,
      top + height,
      previous?.height ?? 0,
    ),
  };
}

export function wheelViewport(
  viewport: FlowViewport,
  deltaY: number,
  point: Point,
  zooming: boolean,
): FlowViewport {
  if (!zooming) return { ...viewport, y: viewport.y - deltaY };
  const zoom = Math.min(
    1.6,
    Math.max(0.25, viewport.zoom * Math.exp(-deltaY * 0.0015)),
  );
  const ratio = zoom / viewport.zoom;
  return {
    x: point.x - (point.x - viewport.x) * ratio,
    y: point.y - (point.y - viewport.y) * ratio,
    zoom,
  };
}
