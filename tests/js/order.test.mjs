import assert from "node:assert/strict";
import { test } from "node:test";

import { orderMerge, orderMoveBefore, orderMoveVisible } from "../../app/static/order.js";

test("orderMoveBefore moves to the front, the middle, and the end", () => {
  assert.deepEqual(orderMoveBefore(["a", "b", "c", "d"], "c", "a"), ["c", "a", "b", "d"]);
  assert.deepEqual(orderMoveBefore(["a", "b", "c", "d"], "a", "d"), ["b", "c", "a", "d"]);
  assert.deepEqual(orderMoveBefore(["a", "b", "c", "d"], "b", null), ["a", "c", "d", "b"]);
});

test("orderMoveBefore leaves the list alone for a no-op or unknown ids", () => {
  assert.deepEqual(orderMoveBefore(["a", "b", "c"], "a", "b"), ["a", "b", "c"]);
  assert.deepEqual(orderMoveBefore(["a", "b"], "zz", "a"), ["a", "b"]);
  assert.deepEqual(orderMoveBefore(["a", "b"], "a", "zz"), ["a", "b"]);
});

test("orderMerge puts stored ids first, then the rest in default order", () => {
  assert.deepEqual(orderMerge(["a", "b", "c", "d"], ["c", "a"]), ["c", "a", "b", "d"]);
  assert.deepEqual(orderMerge(["a", "b"], undefined), ["a", "b"]);
});

test("orderMerge drops stored ids that no longer exist, and duplicates", () => {
  assert.deepEqual(orderMerge(["a", "b", "c"], ["gone", "b", "b", "a"]), ["b", "a", "c"]);
  assert.deepEqual(orderMerge(["a", "a", "b"], null), ["a", "b"]);
});

test("orderMoveVisible keeps hidden pictures in place around a move", () => {
  // Full order a H1 b c H2 d; H1 and H2 hidden, so visible is a b c d.
  const full = ["a", "H1", "b", "c", "H2", "d"];
  const visible = ["a", "b", "c", "d"];
  assert.deepEqual(orderMoveVisible(full, visible, "d", "b"), ["a", "H1", "d", "b", "c", "H2"]);
  assert.deepEqual(orderMoveVisible(full, visible, "a", "c"), ["H1", "b", "a", "c", "H2", "d"]);
});

test("orderMoveVisible drops at the end after the last visible picture, before trailing hidden ones", () => {
  const full = ["a", "b", "c", "H"];
  assert.deepEqual(orderMoveVisible(full, ["a", "b", "c"], "a", null), ["b", "c", "a", "H"]);
  assert.deepEqual(orderMoveVisible(full, ["a", "b", "c"], "c", null), ["a", "b", "c", "H"]);
});
