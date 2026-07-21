import {useCallback, useEffect, useRef, useState} from 'react';

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
): VirtualWindow {
  if (totalRows <= 0 || rowHeight <= 0) {
    return {start: 0, end: 0, topPad: 0, bottomPad: 0};
  }
  // A viewport of 0 (first paint, before the scroller has been measured) would render nothing and
  // leave the grid blank until a scroll event arrived, so it falls back to one screenful.
  const visibleRows = viewportHeight > 0 ? Math.ceil(viewportHeight / rowHeight) : 20;
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const start = Math.max(0, Math.min(firstVisible - overscan, Math.max(0, totalRows - 1)));
  const end = Math.min(totalRows, firstVisible + visibleRows + overscan);
  return {
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: Math.max(0, (totalRows - end) * rowHeight),
  };
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
  const frameRef = useRef<number | undefined>(undefined);
  const [metrics, setMetrics] = useState({scrollTop: 0, viewportHeight: 0});

  const measure = useCallback(() => {
    const el = scrollerEl.current;
    if (!el) return;
    setMetrics(prev => (
      prev.scrollTop === el.scrollTop && prev.viewportHeight === el.clientHeight
        ? prev
        : {scrollTop: el.scrollTop, viewportHeight: el.clientHeight}
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
    setMetrics({scrollTop: el.scrollTop, viewportHeight: el.clientHeight});
    // The grid lives in a flex layout, so the viewport height changes without a window resize
    // (toolbar wrapping, container animation, pane drag).
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    observerRef.current = ro;
  }, [measure]);

  const onScroll = useCallback(() => {
    if (frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      measure();
    });
  }, [measure]);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;
  }, []);

  /**
   * Returns the scroller to the top. A filter or sort restarts the result at row 0, and leaving
   * the scroller where it was would land the user in the middle of a set whose top they have not
   * seen. Lives here rather than at the call site so the element stays owned by the hook.
   */
  const scrollToTop = useCallback(() => {
    const el = scrollerEl.current;
    if (el) el.scrollTop = 0;
    measure();
  }, [measure]);

  // A shrinking result (a filter that matched less) can leave scrollTop past the new end, which
  // browsers clamp silently — without re-measuring, the window would stay pinned to a row range
  // that no longer exists.
  useEffect(() => {
    const el = scrollerEl.current;
    if (el && el.scrollTop > Math.max(0, totalRows * rowHeight - el.clientHeight)) {
      el.scrollTop = 0;
    }
    measure();
  }, [totalRows, rowHeight, measure]);

  return {
    scrollerRef,
    onScroll,
    scrollToTop,
    window: computeWindow(metrics.scrollTop, metrics.viewportHeight, rowHeight, overscan, totalRows),
  };
}
