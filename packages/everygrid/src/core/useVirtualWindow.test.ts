import {describe, expect, it} from 'vitest';
import {computeWindow} from './useVirtualWindow';

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
    const total = 1_000_000;
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
