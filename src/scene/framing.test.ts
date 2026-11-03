import { describe, expect, it } from 'vitest';
import { ISO, TOP, frame, projectPoint, sceneCorners, stageInsets, type Viewport } from './framing';
import { createLayout } from './layout';

const viewports: Viewport[] = [
  { width: 1100, height: 780, insets: stageInsets(1100) },
  { width: 1440, height: 760, insets: stageInsets(1440) },
  { width: 760, height: 900, insets: stageInsets(760) },
  { width: 390, height: 520, insets: stageInsets(390) },
];

describe('framing', () => {
  for (const bars of [2, 4, 8]) {
    const corners = sceneCorners(createLayout(bars));
    for (const [name, orientation] of [['isometric', ISO], ['top', TOP]] as const) {
      it(`keeps a ${bars}-bar roll inside the free area in the ${name} view, centred and filling it`, () => {
        for (const viewport of viewports) {
          const fill = 0.9;
          const f = frame(corners, orientation, viewport, fill);
          const pts = corners.map((c) => projectPoint(c, orientation, f, viewport));
          const xs = pts.map((p) => p.x);
          const ys = pts.map((p) => p.y);
          const { insets, width, height } = viewport;
          // Inside the free rectangle.
          expect(Math.min(...xs)).toBeGreaterThanOrEqual(insets.left - 0.5);
          expect(Math.max(...xs)).toBeLessThanOrEqual(width - insets.right + 0.5);
          expect(Math.min(...ys)).toBeGreaterThanOrEqual(insets.top - 0.5);
          expect(Math.max(...ys)).toBeLessThanOrEqual(height - insets.bottom + 0.5);
          // Centred in it.
          expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo((insets.left + width - insets.right) / 2, 3);
          expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo((insets.top + height - insets.bottom) / 2, 3);
          // The limiting dimension uses `fill` of the free space.
          const usedW = (Math.max(...xs) - Math.min(...xs)) / (width - insets.left - insets.right);
          const usedH = (Math.max(...ys) - Math.min(...ys)) / (height - insets.top - insets.bottom);
          expect(Math.max(usedW, usedH)).toBeCloseTo(fill, 3);
        }
      });
    }
  }

  it('looks straight down in the top view with time left to right and higher notes up the screen', () => {
    const layout = createLayout(4);
    const viewport = viewports[0];
    const f = frame(sceneCorners(layout), TOP, viewport, 0.9);
    const a = projectPoint(sceneCorners(layout)[0].clone().setX(0).setZ(0), TOP, f, viewport);
    const later = projectPoint(sceneCorners(layout)[0].clone().setX(1).setZ(0), TOP, f, viewport);
    const higher = projectPoint(sceneCorners(layout)[0].clone().setX(0).setZ(-1), TOP, f, viewport);
    expect(later.x).toBeGreaterThan(a.x);
    expect(Math.abs(later.y - a.y)).toBeLessThan(0.5);
    expect(higher.y).toBeLessThan(a.y);
  });
});
