// Drag-to-reorder for a container of items, built on pointer events so it works with a mouse and with touch.
//
// Mouse/pen: a drag starts once the pointer has moved a few pixels with the button held, so plain clicks still work. Touch: it starts after a short press-and-hold, so swipes still scroll. While dragging, the original item stays in the layout as a dimmed placeholder that moves to where the item would land, and a translucent copy follows the pointer. Dropping reports ids (`onMove(draggedId, beforeId | null)`), never positions, so it can be applied to whatever the state is by then.
//
// Callers re-render from their own state; while `dragActive()` they should defer re-rendering (it would destroy the placeholder) and do it in `onEnd`.

const MOUSE_THRESHOLD_PX = 6;
const TOUCH_HOLD_MS = 350;
const TOUCH_JITTER_PX = 8;
const EDGE_PX = 60;
const EDGE_SPEED_PX = 18; // per frame at the very edge

let active = null; // the press or drag in progress

export function dragActive() {
  return active?.started === true;
}

export function dragCancel() {
  if (active) {
    finish(false);
  }
}

// options: {scroller: Element | null (null = the window), topInset: () => number (px at the top of the scroller hidden under a sticky header), canStart: (item) => bool, onEnd: () => void}
export function dragSortable(container, itemSelector, idOf, onMove, options) {
  // The browser's own image/text drag would otherwise take over (and cancel ours) a few pixels in.
  container.addEventListener("dragstart", (ev) => ev.preventDefault());
  container.addEventListener("pointerdown", (ev) => {
    if (active || ev.button !== 0) {
      return;
    }
    const item = ev.target.closest(itemSelector);
    if (!item || !container.contains(item) || ev.target.closest("button, input, a, select, textarea") || !options.canStart(item)) {
      return;
    }
    active = {
      container,
      itemSelector,
      idOf,
      onMove,
      options,
      item,
      id: idOf(item),
      pointerId: ev.pointerId,
      touch: ev.pointerType === "touch",
      x0: ev.clientX,
      y0: ev.clientY,
      x: ev.clientX,
      y: ev.clientY,
      started: false,
      timer: null,
      raf: null,
      over: null,
    };
    if (active.touch) {
      active.timer = setTimeout(start, TOUCH_HOLD_MS);
    }
    document.body.classList.add("drag-pressing");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("blur", onAbandon);
    document.addEventListener("visibilitychange", onAbandon);
  });
}

function items(a) {
  return [...a.container.querySelectorAll(a.itemSelector)];
}

function onPointerMove(ev) {
  const a = active;
  if (ev.pointerId !== a.pointerId) {
    return;
  }
  a.x = ev.clientX;
  a.y = ev.clientY;
  if (!a.touch && ev.buttons === 0) {
    finish(false); // the release was lost (e.g. the window lost focus mid-drag)
    return;
  }
  if (!a.started) {
    const moved = Math.hypot(a.x - a.x0, a.y - a.y0);
    if (a.touch && moved > TOUCH_JITTER_PX) {
      finish(false); // it's a swipe, not a press-and-hold
    } else if (!a.touch && moved >= MOUSE_THRESHOLD_PX) {
      start();
    }
    return;
  }
  floatMove(a);
  retarget(a);
}

function onPointerUp(ev) {
  if (ev.pointerId === active.pointerId) {
    finish(active.started);
  }
}

function onPointerCancel(ev) {
  if (ev.pointerId === active.pointerId) {
    finish(false);
  }
}

function onKeyDown(ev) {
  if (ev.key === "Escape" && active.started) {
    // Cancels the drag only; whatever else Escape does (leaving Present) waits for a second press.
    ev.preventDefault();
    ev.stopImmediatePropagation();
    finish(false);
  }
}

function onTouchMove(ev) {
  if (active.started) {
    ev.preventDefault(); // dragging, not scrolling
  }
}

function onAbandon() {
  finish(false);
}

function onContextMenu(ev) {
  ev.preventDefault(); // a long press would otherwise open the image menu
}

function start() {
  const a = active;
  clearTimeout(a.timer);
  // The container may have been re-rendered since the press (renders aren't deferred until the drag starts): use the current element for the pressed id.
  a.item = items(a).find((x) => a.idOf(x) === a.id);
  if (!a.item) {
    finish(false);
    return;
  }
  a.started = true;
  const rect = a.item.getBoundingClientRect();
  a.dx = a.x0 - rect.left;
  a.dy = a.y0 - rect.top;
  a.startIndex = items(a).indexOf(a.item);
  const float = a.item.cloneNode(true);
  float.classList.add("drag-float");
  // Inline, so the items' own (possibly more specific) positioning rules can't override it.
  Object.assign(float.style, { position: "fixed", top: "0", left: "0", margin: "0" });
  float.style.width = `${rect.width}px`;
  float.style.height = `${rect.height}px`;
  // Beside the container rather than in <body>: it stays under the same styles as the items (and inside a fullscreen element), without counting as an item.
  a.container.parentElement.append(float);
  a.float = float;
  floatMove(a);
  a.item.classList.add("drag-placeholder");
  document.body.classList.add("drag-active");
  a.raf = requestAnimationFrame(() => tick(a));
}

function floatMove(a) {
  a.float.style.transform = `translate(${a.x - a.dx}px, ${a.y - a.dy}px)`;
}

// Moves the placeholder to where the dragged item would land. Acts only when the pointer reaches a different item than last time: moving the placeholder reflows the layout, and reacting to the same item again (even after passing over a gap or the placeholder) would bounce it back and forth.
function retarget(a) {
  const over = document.elementFromPoint(a.x, a.y)?.closest(a.itemSelector);
  if (!over || over === a.item || over === a.over || !a.container.contains(over)) {
    return;
  }
  a.over = over;
  const list = items(a);
  if (list.indexOf(over) > list.indexOf(a.item)) {
    over.after(a.item);
  } else {
    over.before(a.item);
  }
}

// Auto-scroll near the scroller's visible edges, every frame while dragging.
function tick(a) {
  if (active !== a) {
    return;
  }
  const scroller = a.options.scroller;
  const top = scroller ? scroller.getBoundingClientRect().top : a.options.topInset();
  const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
  let step = 0;
  if (a.y < top + EDGE_PX) {
    step = -EDGE_SPEED_PX * Math.min(1, (top + EDGE_PX - a.y) / EDGE_PX);
  } else if (a.y > bottom - EDGE_PX) {
    step = EDGE_SPEED_PX * Math.min(1, (a.y - (bottom - EDGE_PX)) / EDGE_PX);
  }
  if (step) {
    (scroller ?? window).scrollBy(0, step);
    retarget(a); // the content moved under a still pointer
  }
  a.raf = requestAnimationFrame(() => tick(a));
}

function finish(drop) {
  const a = active;
  active = null;
  clearTimeout(a.timer);
  cancelAnimationFrame(a.raf);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerCancel);
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("touchmove", onTouchMove, { passive: false });
  window.removeEventListener("contextmenu", onContextMenu, true);
  window.removeEventListener("blur", onAbandon);
  document.removeEventListener("visibilitychange", onAbandon);
  document.body.classList.remove("drag-pressing", "drag-active");
  if (!a.started) {
    return;
  }
  a.float.remove();
  a.item.classList.remove("drag-placeholder");
  if (!drop) {
    // Put the item back where it started; callers may skip re-rendering when their state didn't change.
    const ref = items(a).filter((x) => x !== a.item)[a.startIndex];
    if (ref) {
      ref.before(a.item);
    } else {
      a.container.append(a.item);
    }
  }
  const list = items(a);
  const index = list.indexOf(a.item);
  if (drop && index !== a.startIndex) {
    const before = list[index + 1];
    a.onMove(a.idOf(a.item), before ? a.idOf(before) : null);
  }
  // The click that ends a drag (or follows the release after an Escape-cancel) isn't a click on whatever is under the pointer. Swallowed until the next press or key, since a cancelled drag's release can come much later (and a keyboard-activated button clicks without a press).
  const swallow = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    stopSwallowing();
  };
  const stopSwallowing = () => {
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("pointerdown", stopSwallowing, true);
    window.removeEventListener("keydown", stopSwallowing, true);
  };
  window.addEventListener("click", swallow, true);
  window.addEventListener("pointerdown", stopSwallowing, true);
  window.addEventListener("keydown", stopSwallowing, true);
  a.options.onEnd();
}
