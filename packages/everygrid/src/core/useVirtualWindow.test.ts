import {describe, expect, it} from 'vitest';
import {computeWindow, leadRows, MAX_LEAD_ROWS, MAX_SEGMENT_PX, SEGMENT_ROWS, segmentRows} from './useVirtualWindow';

const ROW = 36;

describe('computeWindow', () => {
  it('renders nothing when there are no rows', () => {
    expect(computeWindow(0, 400, ROW, 6, 0)).toEqual({start: 0, end: 0, topPad: 0, bottomPad: 0});
  });

  it('starts at row 0 at the top of the scroller, with no top spacer', () => {
    const w = computeWindow(0, 360, ROW, 0, 1000);
    expect(w.start).toBe(0);
    expect(w.end).toBe(10);
    expect(w.topPad).toBe(0);
    expect(w.bottomPad).toBe(990 * ROW);
  });

  it('keeps total height constant: topPad + rendered rows + bottomPad === all rows', () => {
    const total = 100_000;
    for (const scrollTop of [0, 360, 12_345, 500_000, total * ROW]) {
      const w = computeWindow(scrollTop, 720, ROW, 6, total);
      expect(w.topPad + (w.end - w.start) * ROW + w.bottomPad).toBe(total * ROW);
    }
  });

  it('applies overscan on both sides', () => {
    const w = computeWindow(100 * ROW, 360, ROW, 5, 1000);
    expect(w.start).toBe(95);
    expect(w.end).toBe(115);
  });

  it('clamps the overscan at the top instead of going negative', () => {
    const w = computeWindow(ROW, 360, ROW, 10, 1000);
    expect(w.start).toBe(0);
    expect(w.topPad).toBe(0);
  });

  it('clamps the window to the last row and leaves no bottom spacer at the end', () => {
    const total = 500;
    const w = computeWindow(total * ROW, 360, ROW, 6, total);
    expect(w.end).toBe(total);
    expect(w.bottomPad).toBe(0);
    expect(w.start).toBeLessThan(total);
  });

  it('falls back to a screenful before the scroller has been measured', () => {
    // viewportHeight 0 is the first paint. Rendering nothing there would leave the grid blank
    // until the first scroll event.
    expect(computeWindow(0, 0, ROW, 0, 1000).end).toBeGreaterThan(0);
  });

  it('treats a negative scrollTop (overscroll bounce) as the top', () => {
    expect(computeWindow(-120, 360, ROW, 0, 1000).start).toBe(0);
  });
});

describe('lead overscan', () => {
  const VIEWPORT = 720;
  const TOTAL = 100_000;

  it('is zero when the scroller has not moved, leaving the window untouched', () => {
    expect(leadRows(5_000, 5_000, VIEWPORT, ROW, 6, TOTAL)).toBe(0);
    expect(computeWindow(5_000, VIEWPORT, ROW, 6, TOTAL, 0))
      .toEqual(computeWindow(5_000, VIEWPORT, ROW, 6, TOTAL));
  });

  it('reaches ahead of the viewport when scrolling down', () => {
    const plain = computeWindow(5_000, VIEWPORT, ROW, 6, TOTAL);
    const led = computeWindow(5_000, VIEWPORT, ROW, 6, TOTAL, 20);
    expect(led.end).toBe(plain.end + 20);
    expect(led.start).toBe(plain.start);
  });

  it('reaches back above the viewport when scrolling up', () => {
    const plain = computeWindow(5_000, VIEWPORT, ROW, 6, TOTAL);
    const led = computeWindow(5_000, VIEWPORT, ROW, 6, TOTAL, -20);
    expect(led.start).toBe(plain.start - 20);
    expect(led.end).toBe(plain.end);
    // The spacer must follow the window, or the rows would be drawn in the wrong place.
    expect(led.topPad).toBe(led.start * ROW);
  });

  it('caps the reach so a fling cannot ask for an unbounded window', () => {
    expect(leadRows(0, 400_000 * ROW, VIEWPORT, ROW, 6, 400_000)).toBe(-MAX_LEAD_ROWS);
    expect(leadRows(400_000 * ROW, 0, VIEWPORT, ROW, 6, 400_000)).toBe(MAX_LEAD_ROWS);
  });

  it('keeps the total height invariant while leading', () => {
    const w = computeWindow(5_000, VIEWPORT, ROW, 6, TOTAL, 40);
    expect(w.topPad + (w.end - w.start) * ROW + w.bottomPad).toBe(TOTAL * ROW);
  });

  it('still clamps at both ends of the data', () => {
    expect(computeWindow(0, VIEWPORT, ROW, 6, TOTAL, -50).start).toBe(0);
    expect(computeWindow(TOTAL * ROW, VIEWPORT, ROW, 6, TOTAL, 50).end).toBe(TOTAL);
  });
});

describe('segmentRows', () => {
  it('holds the configured segment size at ordinary row heights', () => {
    for (const h of [24, 34, 36, 48]) {
      expect(segmentRows(h)).toBe(SEGMENT_ROWS);
    }
  });

  it('never asks for more height than the browser will lay out', () => {
    for (const h of [24, 34, 36, 48, 120, 400]) {
      expect(segmentRows(h) * h).toBeLessThanOrEqual(MAX_SEGMENT_PX);
    }
  });

  it('shortens the segment for a row too tall to fit the configured count', () => {
    const tall = Math.ceil(MAX_SEGMENT_PX / SEGMENT_ROWS) + 20;
    expect(segmentRows(tall)).toBeLessThan(SEGMENT_ROWS);
    // Still uses what it can: one more row would overflow.
    expect((segmentRows(tall) + 1) * tall).toBeGreaterThan(MAX_SEGMENT_PX);
  });

  it('is harmless for a row height of zero', () => {
    expect(segmentRows(0)).toBe(0);
  });
});
