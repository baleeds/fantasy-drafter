/**
 * Long-press drag-to-reorder with edge autoscroll.
 *
 * This is the highest-risk piece of UI in the app and the reason the prototype
 * exists. Notes on why it is built this way:
 *
 * - **Touch events, not Pointer Events.** Under Pointer Events, scrolling is
 *   governed solely by `touch-action`; `pointermove` cannot cancel it. Raw
 *   touch events let us `preventDefault()` once a drag is actually underway,
 *   which is the only reliable way to stop the page scrolling out from under a
 *   held row. Desktop uses mouse events, where there is no scroll to fight.
 *
 * - **`touchmove` is registered non-passive.** A passive listener cannot
 *   `preventDefault()`, and browsers default `touchmove` to passive on the
 *   document. This is easy to lose in a refactor and fails silently.
 *
 * - **The long press is what makes `preventDefault()` work at all.** Once the
 *   browser commits to a scroll, `touchmove` becomes non-cancelable and the
 *   drag is doomed. Requiring the finger to sit nearly still for a few hundred
 *   milliseconds means no scroll has begun by the time we take over.
 *
 * - **Autoscroll speed is proportional to edge proximity.** A fixed speed is
 *   either unusably slow for a long move or overshoots wildly on a short one.
 */

export interface DragConfig {
  /** The list element whose children are reorderable. */
  list: HTMLElement;
  /** Selector matching a draggable row within the list. */
  rowSelector: string;
  /**
   * Selector for the mouse drag handle. Touch has no handle — a long press
   * anywhere on the row picks it up — but on a mouse there is no press to wait
   * out, so dragging from anywhere means every stray click-and-twitch reorders
   * the board.
   */
  handleSelector?: string;
  /** Pixels of fixed UI at the top of the viewport, for the autoscroll zone. */
  topInset: () => number;
  /** How long the finger must sit still before a row is picked up. */
  longPressMs: () => number;
  /** Autoscroll speed at the very edge, in px per frame. */
  autoscrollMaxSpeed: () => number;
  onReorder: (from: number, to: number) => void;
  onStateChange?: (dragging: boolean) => void;
}

/** Finger movement that cancels a pending long press, in px. */
const MOVE_SLOP = 10;

/** Distance from an edge at which autoscroll begins, in px. */
const EDGE_ZONE = 96;

export function enableDragReorder(cfg: DragConfig): void {
  const { list, rowSelector } = cfg;

  let pendingRow: HTMLElement | null = null;
  let pressTimer = 0;
  let startX = 0;
  let startY = 0;
  let touchId: number | null = null;

  let dragging = false;
  let sourceRow: HTMLElement | null = null;
  let ghost: HTMLElement | null = null;
  let order: HTMLElement[] = [];
  let startIndex = 0;
  let currentIndex = 0;
  let rowPitch = 0;
  let grabOffsetY = 0;
  let pointerY = 0;
  let rafId = 0;
  let lastFrame = 0;

  // --- Picking a row up ----------------------------------------------------

  function beginDrag(): void {
    if (!pendingRow) return;

    sourceRow = pendingRow;
    pendingRow = null;
    dragging = true;

    order = Array.from(list.querySelectorAll<HTMLElement>(rowSelector));
    startIndex = order.indexOf(sourceRow);
    currentIndex = startIndex;

    // Measure pitch between rows rather than row height, so any gap or margin
    // is accounted for. Falls back to the row's own height in a one-row list.
    const rect = sourceRow.getBoundingClientRect();
    rowPitch =
      order.length > 1
        ? order[1].getBoundingClientRect().top - order[0].getBoundingClientRect().top
        : rect.height;

    grabOffsetY = pointerY - rect.top;

    ghost = sourceRow.cloneNode(true) as HTMLElement;
    ghost.classList.add("ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.transform = `translateY(${rect.top}px)`;
    document.body.appendChild(ghost);

    sourceRow.classList.add("dragging");
    document.body.classList.add("is-dragging");

    // A short tick confirms the row was picked up, which matters when the
    // gesture is invisible until you move.
    navigator.vibrate?.(15);

    cfg.onStateChange?.(true);

    lastFrame = 0;
    rafId = requestAnimationFrame(frame);
  }

  function cancelPending(): void {
    clearTimeout(pressTimer);
    pendingRow = null;
  }

  // --- The drag loop -------------------------------------------------------

  /**
   * Runs every frame for the duration of the drag. Handles autoscroll and
   * re-derives the drop target, which has to happen even when the finger is
   * still — during autoscroll the list moves underneath it.
   */
  function frame(now: number): void {
    if (!dragging) return;
    const dt = lastFrame ? Math.min(now - lastFrame, 50) : 16.667;
    lastFrame = now;

    const velocity = autoscrollVelocity();
    if (velocity !== 0) window.scrollBy(0, (velocity * dt) / 16.667);

    updateGhost();
    updateTarget();

    rafId = requestAnimationFrame(frame);
  }

  function autoscrollVelocity(): number {
    const max = cfg.autoscrollMaxSpeed();
    const top = cfg.topInset();
    const bottom = window.innerHeight;

    const fromTop = pointerY - top;
    if (fromTop < EDGE_ZONE) return -max * intensity(fromTop);

    const fromBottom = bottom - pointerY;
    if (fromBottom < EDGE_ZONE) return max * intensity(fromBottom);

    return 0;
  }

  /** 0 at the edge of the zone, 1 at the edge of the screen (or past it). */
  function intensity(distance: number): number {
    return Math.min(1, Math.max(0, 1 - distance / EDGE_ZONE));
  }

  function updateGhost(): void {
    if (!ghost) return;
    const y = pointerY - grabOffsetY;
    ghost.style.transform = `translateY(${y}px)`;
  }

  /**
   * Work out which slot the held row should occupy and move it there.
   *
   * Rows are a uniform height, so this is arithmetic rather than a hit test
   * against 300 elements. The held row stays in the list while dragging (just
   * visually hidden), so the list's height never changes and the slot maths
   * stays honest.
   */
  function updateTarget(): void {
    if (!sourceRow) return;

    const listTop = list.getBoundingClientRect().top;
    const slot = Math.round((pointerY - listTop - rowPitch / 2) / rowPitch);
    const target = Math.min(order.length - 1, Math.max(0, slot));
    if (target === currentIndex) return;

    order.splice(currentIndex, 1);
    order.splice(target, 0, sourceRow);
    list.insertBefore(sourceRow, order[target + 1] ?? null);
    currentIndex = target;
  }

  // --- Putting it down -----------------------------------------------------

  function endDrag(): void {
    if (!dragging) return;
    cancelAnimationFrame(rafId);

    ghost?.remove();
    ghost = null;
    sourceRow?.classList.remove("dragging");
    document.body.classList.remove("is-dragging");

    dragging = false;
    sourceRow = null;
    touchId = null;
    cfg.onStateChange?.(false);

    if (currentIndex !== startIndex) cfg.onReorder(startIndex, currentIndex);
  }

  // --- Touch ---------------------------------------------------------------

  list.addEventListener(
    "touchstart",
    (e) => {
      if (dragging || e.touches.length !== 1) return;
      const row = (e.target as HTMLElement).closest<HTMLElement>(rowSelector);
      if (!row) return;

      const touch = e.touches[0];
      touchId = touch.identifier;
      startX = touch.clientX;
      startY = touch.clientY;
      pointerY = touch.clientY;
      pendingRow = row;

      clearTimeout(pressTimer);
      pressTimer = window.setTimeout(beginDrag, cfg.longPressMs());
    },
    { passive: true },
  );

  // Non-passive: this listener must be able to preventDefault(). See the note
  // at the top of the file.
  document.addEventListener(
    "touchmove",
    (e) => {
      const touch = findTouch(e.touches);
      if (!touch) return;

      if (dragging) {
        // Stop the page scrolling under the held row. The frame loop does all
        // the scrolling from here.
        e.preventDefault();
        pointerY = touch.clientY;
        return;
      }

      if (!pendingRow) return;
      const moved = Math.hypot(touch.clientX - startX, touch.clientY - startY);
      if (moved > MOVE_SLOP) cancelPending();
    },
    { passive: false },
  );

  const finish = (e: TouchEvent) => {
    // A touch sequence is followed by a synthetic click. Preventing the default
    // action of touchend suppresses it, which is what stops releasing a dragged
    // row from also counting as a tap on him — in draft mode, that would mark
    // the player you just reordered as drafted.
    if (dragging && e.cancelable) e.preventDefault();
    cancelPending();
    endDrag();
  };
  document.addEventListener("touchend", finish, { passive: false });
  document.addEventListener("touchcancel", finish, { passive: false });

  function findTouch(touches: TouchList): Touch | null {
    if (touchId === null) return touches[0] ?? null;
    for (const touch of Array.from(touches)) {
      if (touch.identifier === touchId) return touch;
    }
    return null;
  }

  // --- Mouse ---------------------------------------------------------------
  // A mouse drag starts from the handle and starts at once. There is no long
  // press to wait out and no scroll gesture to disambiguate from, so a delay
  // would only make it feel sticky — but without a handle, pressing anywhere
  // on a row would begin a drag, which reads as the board lurching under an
  // ordinary click.

  list.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || dragging) return;
    const target = e.target as HTMLElement;
    if (cfg.handleSelector && !target.closest(cfg.handleSelector)) return;

    const row = target.closest<HTMLElement>(rowSelector);
    if (!row) return;

    e.preventDefault();
    pointerY = e.clientY;
    pendingRow = row;
    beginDrag();
  });

  document.addEventListener("mousemove", (e) => {
    if (dragging) pointerY = e.clientY;
  });

  document.addEventListener("mouseup", () => {
    cancelPending();
    endDrag();
  });

  // --- Gestures the browser would otherwise claim ---------------------------

  // The handle is for dragging and nothing else. A short mouse drag starts and
  // ends inside it, and the click that follows would otherwise land on the row
  // — so clicking the handle never reaches the list. Capture phase, to get
  // ahead of any delegated handler.
  //
  // A long mouse drag needs no such guard: the click fires on the nearest
  // common ancestor of press and release, which for a drag across rows is the
  // list itself rather than any row.
  document.addEventListener(
    "click",
    (e) => {
      if (!cfg.handleSelector) return;
      if (!(e.target as HTMLElement).closest(cfg.handleSelector)) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );

  document.addEventListener("contextmenu", (e) => {
    if (dragging || pendingRow) e.preventDefault();
  });

  document.addEventListener("selectstart", (e) => {
    if (dragging || pendingRow) e.preventDefault();
  });

  // A scroll that happens while a press is pending means the browser won the
  // gesture; the row should not come alive mid-scroll.
  window.addEventListener("scroll", () => {
    if (!dragging) cancelPending();
  });
}
