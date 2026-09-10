import {useCallback, useEffect, useRef, useState} from 'react';
import {flushSync} from 'react-dom';

/** The slice of rows to render, plus the spacer heights that stand in for the rest. */
export interface VirtualWindow {
  /** First rendered row index. */
  start: number;
  /** One past the last rendered row index. */
  end: number;
  /** Spacer height above the rendered rows, in px. */
  topPad: number;
  /** Spacer height below the rendered rows, in px. */
  bottomPad: number;
  /**
   * The scroller is moving faster than a screenful per frame. Nothing in that stream is readable,
   * so the body draws placeholder rows instead of fetching and rendering cells it will replace
   * before anyone sees them — which also makes each frame cheap enough to keep up.
   */
  fast?: boolean;
}

/**
 * Largest spacer height a virtual scroller may ask for.
 *
 * Browsers clamp how tall an element can be, and a spacer past that limit silently stops growing —
 * the scrollbar then covers only part of the data and the rows beyond it cannot be reached at all.
 * Chrome cuts off at 16,777,214px (2^24 - 2), measured; Firefox and Safari sit near the same mark.
 */
export const MAX_SEGMENT_PX = 16_777_000;

/** Row height a virtualised target falls back to when its config does not set one. */
export const DEFAULT_ROW_HEIGHT = 36;

/**
 * Rows per segment, before the height limit is taken into account.
 *
 * Comfortably under what the limit alone would allow. A shorter segment keeps the scroller itself
 * short — 6.8M px rather than 16.7M at a 34px row — and the scrollbar thumb correspondingly less
 * twitchy: a pixel of thumb travel covers about a third as many rows, which is what makes dragging
 * through a very large result feel controllable rather than like a slot machine.
 */
export const SEGMENT_ROWS = 200_000;

/**
 * How many rows one scrollable segment holds, for a given row height.
 *
 * A result larger than this is scrolled a segment at a time (the pager moves between them) rather
 * than being squeezed into one over-long scroller. Keeping every segment laid out 1:1 is what makes
 * scrolling smooth: a row is exactly `rowHeight` tall and travelling `rowHeight` advances exactly
 * one row. Compressing the whole result into one scroller instead would break that correspondence —
 * the rows would step rather than slide.
 *
 * The height limit is the backstop, not the target: an unusually tall row yields a shorter segment
 * rather than one that overflows what the browser will lay out.
 */
export function segmentRows(rowHeight: number): number {
  if (rowHeight <= 0) return 0;
  return Math.max(1, Math.min(SEGMENT_ROWS, Math.floor(MAX_SEGMENT_PX / rowHeight)));
}

/**
 * Ceiling on how far ahead of the viewport the window may reach while scrolling.
 *
 * Deliberately short. Its original job — covering the frame the window used to lag behind by — is
 * gone now that the window is committed before the frame paints, so what is left is a head start
 * on the engine's block fetches. Every row it adds is a row rendered on each scroll event, and
 * during a fast fling that render is what the scroll outruns, so a big lead makes the thing it was
 * meant to help worse.
 */
export const MAX_LEAD_ROWS = 16;

/**
 * Rows to render past the window, in the direction of travel.
 *
 * A scroll event's state update paints one frame later, so by the time the rows appear the
 * scroller has already moved on — at speed, further than the overscan covers, and the viewport
 * ends up over bare spacer. Extending the window along the direction of travel by the distance
 * just covered closes that gap.
 *
 * It is measured as a row delta, not pixels: under the compressed mapping a pixel spans many rows,
 * so `Δpx / rowHeight` would badly under-reach. Deriving it from two window computations makes it
 * correct in both modes without either knowing about the other.
 */
export function leadRows(
  scrollTop: number,
  prevScrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
  totalRows: number,
): number {
  if (scrollTop === prevScrollTop) return 0;
  const now = computeWindow(scrollTop, viewportHeight, rowHeight, overscan, totalRows);
  const before = computeWindow(prevScrollTop, viewportHeight, rowHeight, overscan, totalRows);
  const moved = now.start - before.start;
  return Math.max(-MAX_LEAD_ROWS, Math.min(MAX_LEAD_ROWS, moved));
}

/**
 * Pure window maths — no DOM, no React. Everything the virtual body needs is derived here so it
 * can be reasoned about (and tested) on its own.
 */
export function computeWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number,
  totalRows: number,
  lead: number = 0,
): VirtualWindow {
  if (totalRows <= 0 || rowHeight <= 0) {
    return {start: 0, end: 0, topPad: 0, bottomPad: 0};
  }
  // A viewport of 0 (first paint, before the scroller has been measured) would render nothing and
  // leave the grid blank until a scroll event arrived, so it falls back to one screenful.
  const visibleRows = viewportHeight > 0 ? Math.ceil(viewportHeight / rowHeight) : 20;
  const back = Math.max(0, -lead);
  const ahead = Math.max(0, lead);

  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const start = Math.max(0, Math.min(firstVisible - overscan - back, Math.max(0, totalRows - 1)));
  const end = Math.min(totalRows, firstVisible + visibleRows + overscan + ahead);
  return {
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: Math.max(0, (totalRows - end) * rowHeight),
  };
}

/** Quiet time that counts as the scroll having stopped, in ms. */
const SETTLE_MS = 90;

/**
 * How close to a segment edge the reader gets before the segment slides, in rows.
 *
 * A couple of screenfuls: enough that the slide happens before anyone can scroll off the end, and
 * narrow enough that the reader spends almost no time inside the band where it can trigger.
 */
const REANCHOR_MARGIN_ROWS = 40;

/**
 * Slides the segment under the reader when they approach its edge, keeping the rows they are
 * looking at exactly where they are.
 *
 * A browser will not lay out a scroller tall enough for a very large result, so the scroller only
 * ever covers one segment. Rather than making that visible — a pager, or a scrollbar that stops
 * partway through the data — the segment moves: the anchor shifts by half a segment and `scrollTop`
 * shifts by the same distance in the opposite direction, so the net position on screen is
 * unchanged. Both happen in the scroll handler, before the frame paints, so there is nothing to
 * see. The cost is that the scrollbar describes the segment rather than the whole result, and its
 * thumb jumps back to the middle each time the segment moves.
 */
function reanchor(
  el: HTMLDivElement,
  anchorRef: {current: number},
  totalRows: number,
  windowRows: number,
  rowHeight: number,
): void {
  if (windowRows >= totalRows) {
    anchorRef.current = 0;
    return;
  }
  const margin = REANCHOR_MARGIN_ROWS * rowHeight;
  const shiftRows = Math.max(1, Math.floor(windowRows / 2));
  const maxScroll = Math.max(0, windowRows * rowHeight - el.clientHeight);

  if (el.scrollTop < margin && anchorRef.current > 0) {
    const shift = Math.min(shiftRows, anchorRef.current);
    anchorRef.current -= shift;
    el.scrollTop += shift * rowHeight;
    return;
  }
  const tail = totalRows - (anchorRef.current + windowRows);
  if (el.scrollTop > maxScroll - margin && tail > 0) {
    const shift = Math.min(shiftRows, tail);
    anchorRef.current += shift;
    el.scrollTop -= shift * rowHeight;
  }
}

/**
 * Tracks a scroll container and reports the row window to render.
 *
 * Scroll events are coalesced to one measurement per frame: a fast wheel or drag fires dozens of
 * events between paints, and re-rendering the body on each one is what makes naive virtual lists
 * stutter.
 */
export function useVirtualWindow(totalRows: number, rowHeight: number, overscan: number) {
  const scrollerEl = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  // First absolute row the scroller currently stands for. The scroller itself is only ever one
  // segment tall; this is which slice of the result that segment is showing.
  const anchorRef = useRef(0);
  const [anchor, setAnchor] = useState(0);
  // Scroll speed, and the timer that declares the scroll over. Held apart from `metrics` because
  // settling is a change in what to draw, not a change in where the window is.
  const lastTopRef = useRef(0);
  const settleRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [fast, setFast] = useState(false);
  const windowRows = Math.min(totalRows, segmentRows(rowHeight));
  // prevScrollTop is kept alongside so the render can tell how far the last frame travelled, which
  // is what sizes the lead overscan.
  const [metrics, setMetrics] = useState({scrollTop: 0, prevScrollTop: 0, viewportHeight: 0});

  const measure = useCallback(() => {
    const el = scrollerEl.current;
    if (!el) return;
    setMetrics(prev => (
      prev.scrollTop === el.scrollTop && prev.viewportHeight === el.clientHeight
        ? prev
        : {scrollTop: el.scrollTop, prevScrollTop: prev.scrollTop, viewportHeight: el.clientHeight}
    ));
  }, []);

  /**
   * A callback ref, not a plain one, because the scroller is unmounted and remounted whenever the
   * grid swaps to Excel view and back. A fresh element starts at scrollTop 0 while `metrics` still
   * held the old offset, so the window was computed for a position hundreds of rows below where
   * the scroller actually sat — and the viewport came back blank. Re-measuring on attach ties the
   * two together again.
   */
  const scrollerRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    scrollerEl.current = el;
    if (!el) return;
    setMetrics({scrollTop: el.scrollTop, prevScrollTop: el.scrollTop, viewportHeight: el.clientHeight});
    // The grid lives in a flex layout, so the viewport height changes without a window resize
    // (toolbar wrapping, container animation, pane drag).
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    observerRef.current = ro;
  }, [measure]);

  /**
   * The new window is committed before the browser paints this frame.
   *
   * Scroll is a continuous event, so a plain setState from here is scheduled at default priority
   * and React commits it a frame or more later. Until then the rows sit where the scroller was,
   * and at any speed the viewport ends up over bare spacer — the blank band under the rows.
   * Measuring inside requestAnimationFrame had the same problem one frame worse. flushSync is what
   * ties the rows to the offset that produced them; the tree is only the visible rows, so the
   * synchronous render is cheap, and `measure` bails when nothing moved, making this a no-op for
   * the events that do not change the window.
   */
  const onScroll = useCallback(() => {
    const el = scrollerEl.current;
    let moving = false;
    if (el) {
      const rowsMoved = Math.abs(el.scrollTop - lastTopRef.current) / rowHeight;
      const screenful = Math.max(1, Math.ceil(el.clientHeight / rowHeight));
      moving = rowsMoved > screenful;
      reanchor(el, anchorRef, totalRows, windowRows, rowHeight);
      // Recorded after the slide, not before. A re-anchor moves scrollTop by half a segment on
      // purpose and the rows do not move with it; counting that as travel read as a fast scroll and
      // flashed placeholders over a scroll that had barely moved.
      lastTopRef.current = el.scrollTop;
    }
    // The scroll is over once nothing has moved for a beat; that is when the real rows go back in.
    if (settleRef.current !== undefined) clearTimeout(settleRef.current);
    settleRef.current = setTimeout(() => {
      settleRef.current = undefined;
      setFast(false);
    }, SETTLE_MS);
    flushSync(() => {
      setAnchor(anchorRef.current);
      if (moving) setFast(true);
      measure();
    });
  }, [measure, totalRows, windowRows, rowHeight]);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (settleRef.current !== undefined) clearTimeout(settleRef.current);
  }, []);

  /**
   * Returns the scroller to the top. A filter or sort restarts the result at row 0, and leaving
   * the scroller where it was would land the user in the middle of a set whose top they have not
   * seen. Lives here rather than at the call site so the element stays owned by the hook.
   */
  const scrollToTop = useCallback(() => {
    const el = scrollerEl.current;
    anchorRef.current = 0;
    setAnchor(0);
    setFast(false);
    lastTopRef.current = 0;
    if (el) el.scrollTop = 0;
    measure();
  }, [measure]);

  // A shrinking result (a filter that matched less) can leave scrollTop past the new end, which
  // browsers clamp silently — without re-measuring, the window would stay pinned to a row range
  // that no longer exists.
  useEffect(() => {
    // A shrunken result can leave the anchor past the end of the data.
    if (anchorRef.current > Math.max(0, totalRows - windowRows)) {
      anchorRef.current = Math.max(0, totalRows - windowRows);
      setAnchor(anchorRef.current);
    }
    const el = scrollerEl.current;
    if (el) {
      // Measured on the element, not on totalRows x rowHeight: the scroller also contains the
      // header, so a computed height runs a few px short and any offset inside that margin looked
      // out of range. Clamping to the end rather than snapping to 0 keeps the reader where they
      // were — this used to throw them back to the top whenever the row count changed.
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      if (el.scrollTop > maxScroll) el.scrollTop = maxScroll;
    }
    measure();
  }, [totalRows, windowRows, rowHeight, measure]);

  // The window is computed against the segment the scroller stands for, then lifted back onto the
  // full result so callers only ever see absolute row indices.
  const local = computeWindow(
    metrics.scrollTop, metrics.viewportHeight, rowHeight, overscan, windowRows,
    leadRows(metrics.scrollTop, metrics.prevScrollTop, metrics.viewportHeight, rowHeight, overscan, windowRows),
  );

  return {
    scrollerRef,
    onScroll,
    scrollToTop,
    window: {
      start: anchor + local.start,
      end: anchor + local.end,
      topPad: local.topPad,
      bottomPad: local.bottomPad,
      fast,
    },
  };
}
