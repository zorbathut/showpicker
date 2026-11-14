// Pure list operations behind drag-to-reorder. Ids are title keys (the lineup) or picture ids (a title's `full` URLs).

// `list` with `id` moved to just before `beforeId` (or to the end when `beforeId` is null). Unchanged if either id isn't in the list.
export function orderMoveBefore(list, id, beforeId) {
  if (!list.includes(id) || (beforeId != null && !list.includes(beforeId))) {
    return [...list];
  }
  const rest = list.filter((x) => x !== id);
  const at = beforeId == null ? rest.length : rest.indexOf(beforeId);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

// A title's picture ids in display order: the stored custom order's ids that still exist (pictures can disappear when artwork changes upstream), then any others in their default order. Duplicates are dropped.
export function orderMerge(ids, stored) {
  const present = new Set(ids);
  const out = [];
  const seen = new Set();
  for (const id of [...(stored ?? []).filter((x) => present.has(x)), ...ids]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// The full order (hidden pictures included) after dragging the visible picture `id` to just before the visible picture `beforeId`, or after the last visible picture when `beforeId` is null. Hidden pictures keep their places relative to the visible ones around them, so they come back where they were if unhidden.
export function orderMoveVisible(full, visible, id, beforeId) {
  if (beforeId != null) {
    return orderMoveBefore(full, id, beforeId);
  }
  const last = visible.filter((x) => x !== id).at(-1);
  if (last === undefined || !full.includes(id)) {
    return [...full];
  }
  const rest = full.filter((x) => x !== id);
  const at = rest.indexOf(last) + 1;
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}
