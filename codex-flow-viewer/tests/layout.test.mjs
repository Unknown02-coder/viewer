import test from "node:test";
import assert from "node:assert/strict";
import { layoutFlowGroups } from "../src/layout.ts";

const groups = [
  { id: "q1", tasks: ["a", "b"], expanded: true },
  { id: "q2", tasks: ["c"], expanded: true },
];

test("each question reserves space for every row of its own tasks before the next question", () => {
  const result = layoutFlowGroups(groups);
  assert.deepEqual(result.q1, { x: 64, y: 0 });
  assert.deepEqual(result.a, { x: 80, y: 118 });
  assert.deepEqual(result.b, { x: 606, y: 118 });
  assert.deepEqual(result.q2, { x: 64, y: 334 });
  assert.deepEqual(result.c, { x: 80, y: 452 });
});

test("appending tasks to the latest group keeps all existing blocks in place", () => {
  const old = layoutFlowGroups(groups);
  const next = layoutFlowGroups(
    [groups[0], { ...groups[1], tasks: ["c", "d", "e", "f"] }],
    old,
  );
  for (const id of ["q1", "a", "b", "q2", "c"])
    assert.deepEqual(next[id], old[id]);
  assert.deepEqual(next.e, { x: 80, y: 628 });
  assert.deepEqual(next.f, { x: 606, y: 628 });
});

test("a late new row in an earlier group pushes only later groups below its whole task area", () => {
  const old = layoutFlowGroups(groups);
  const next = layoutFlowGroups(
    [{ ...groups[0], tasks: ["a", "b", "d", "e"] }, groups[1]],
    old,
  );
  assert.deepEqual(next.a, old.a);
  assert.deepEqual(next.b, old.b);
  assert.deepEqual(next.e, { x: 606, y: 294 });
  assert.deepEqual(next.q2, { x: 64, y: 510 });
  assert.deepEqual(next.c, { x: 80, y: 628 });
});

test("overlapping old anchors and free-drag task positions cannot place a question across tasks", () => {
  const next = layoutFlowGroups(groups, {
    q1: { x: 122, y: 0 },
    q2: { x: 77, y: 145 },
    a: { x: 100, y: 140 },
  });
  assert.deepEqual(next.q1, { x: 64, y: 0 });
  assert.deepEqual(next.a, { x: 80, y: 118 });
  assert.deepEqual(next.q2, { x: 64, y: 334 });
});

test("an explicit collapsed layout has no task nodes and compacts the next section", () => {
  const result = layoutFlowGroups([
    { ...groups[0], expanded: false },
    groups[1],
  ]);
  assert.equal(result.a, undefined);
  assert.deepEqual(result.q2, { x: 64, y: 130 });
});

test("a narrow reading column stacks tasks and reserves every row", () => {
  const result = layoutFlowGroups(groups, {}, 1);
  assert.deepEqual(result.a, { x: 80, y: 118 });
  assert.deepEqual(result.b, { x: 80, y: 294 });
  assert.deepEqual(result.q2, { x: 64, y: 510 });
});
