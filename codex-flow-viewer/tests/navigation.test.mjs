import test from "node:test";
import assert from "node:assert/strict";
import {
  flowContentBounds,
  readingViewport,
  flowScrollRange,
  wheelViewport,
} from "../src/layout.ts";

test("fresh reading layout fits the width and begins at the first question regardless of history length", () => {
  const bounds = flowContentBounds([
    { type: "request", position: { x: 64, y: 0 } },
    { type: "task", position: { x: 606, y: 118 } },
    { type: "request", position: { x: 64, y: 20000 } },
  ]);
  const v = readingViewport(700, bounds);
  assert.ok(v.x + bounds.left * v.zoom >= 23.9);
  assert.ok(v.x + bounds.right * v.zoom <= 676.1);
  assert.equal(v.y + bounds.top * v.zoom, 56);
  assert.ok(
    v.zoom > 0.5,
    "long history must not shrink the reading scale to fit its height",
  );
});

test("ordinary wheel moves vertically while Ctrl wheel scales around the pointer", () => {
  const v = { x: 20, y: -120, zoom: 0.8 };
  assert.deepEqual(wheelViewport(v, 180, { x: 300, y: 200 }, false), {
    ...v,
    y: -300,
  });
  const next = wheelViewport(v, -100, { x: 300, y: 200 }, true);
  assert.ok(next.zoom > v.zoom);
  assert.ok(
    Math.abs((300 - next.x) / next.zoom - (300 - v.x) / v.zoom) < 0.0001,
  );
  assert.ok(
    Math.abs((200 - next.y) / next.zoom - (200 - v.y) / v.zoom) < 0.0001,
  );
});

test("scroll rail maps the camera position and retains its origin during manual overscroll", () => {
  const bounds = { left: 7, top: 0, right: 1152, bottom: 2400 };
  const normal = flowScrollRange(bounds, { x: 0, y: -600, zoom: 1 }, 500);
  assert.equal(normal.origin - normal.top, -600);
  assert.ok(normal.height >= normal.top + 500);
  const above = flowScrollRange(bounds, { x: 0, y: 160, zoom: 1 }, 500);
  const moved = flowScrollRange(bounds, { x: 0, y: 100, zoom: 1 }, 500, above);
  assert.equal(moved.origin, above.origin);
  assert.equal(moved.top, 60);
});
