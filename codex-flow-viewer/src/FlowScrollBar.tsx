import React, { useLayoutEffect, useRef } from "react";
import { useReactFlow, useStore, useViewport } from "@xyflow/react";
import {
  flowScrollRange,
  type FlowBounds,
  type FlowScrollRange,
} from "./layout";

export default function FlowScrollBar({
  bounds,
  onScrollStart,
}: {
  bounds: FlowBounds;
  onScrollStart: () => void;
}) {
  const viewport = useViewport();
  const flow = useReactFlow();
  const height = useStore((state) => state.height);
  const rail = useRef<HTMLDivElement>(null);
  const applied = useRef(0);
  const extent = useRef<{ key: string; range: FlowScrollRange } | null>(null);
  const key = `${bounds.top}:${bounds.bottom}:${viewport.zoom}:${height}`;
  const range = flowScrollRange(
    bounds,
    viewport,
    height,
    extent.current?.key === key ? extent.current.range : undefined,
  );
  extent.current = { key, range };
  useLayoutEffect(() => {
    if (!rail.current) return;
    rail.current.scrollTop = range.top;
    applied.current = rail.current.scrollTop;
  }, [range.top, range.height]);
  return (
    <div
      ref={rail}
      className="flow-scrollbar nowheel nopan nodrag"
      role="region"
      aria-label="작업 흐름 세로 스크롤"
      tabIndex={0}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        if (Math.abs(top - applied.current) < 0.75) return;
        applied.current = top;
        onScrollStart();
        void flow.setViewport({ ...flow.getViewport(), y: range.origin - top });
      }}
    >
      <div aria-hidden="true" style={{ height: range.height, width: 1 }} />
    </div>
  );
}
