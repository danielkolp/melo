import * as THREE from 'three';
import { SLAB_HEIGHT, TABLE_MARGIN, deckBounds, type RollLayout } from './layout';

/**
 * Orthographic framing. Given a viewing direction and the canvas size, works
 * out where to aim and how far to zoom so the whole instrument fills the free
 * part of the stage. All sizes come from the actual scene bounds.
 */

export interface Orientation {
  /** Angle from straight down, radians. */
  polar: number;
  /** Rotation around the vertical axis, radians; 0 looks from the front. */
  azimuth: number;
}

/** The composed angle: high enough to read every row, turned enough to show the depth of the notes. */
export const ISO: Orientation = { polar: 0.86, azimuth: -0.4 };
/** Straight down, time left to right, higher notes up the screen. */
export const TOP: Orientation = { polar: 1e-3, azimuth: 0 };

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Viewport {
  width: number;
  height: number;
  /** Pixels covered by overlays (title, view switch, hints) that the roll should stay clear of. */
  insets: Insets;
}

/** Room the stage overlays take up, by canvas size. */
export function stageInsets(width: number): Insets {
  const compact = width < 640;
  return compact ? { top: 128, right: 12, bottom: 16, left: 12 } : { top: 92, right: 32, bottom: 48, left: 32 };
}

/** Corners of everything that should stay in frame: table, keyboard, automation deck, note tops. */
export function sceneCorners(layout: RollLayout): THREE.Vector3[] {
  const left = layout.keyboardX - 0.06;
  const right = layout.x1 + TABLE_MARGIN.side;
  const back = -layout.depth / 2 - TABLE_MARGIN.back;
  const front = deckBounds(layout).front;
  const corners: THREE.Vector3[] = [];
  for (const x of [left, right]) for (const z of [back, front]) for (const y of [-SLAB_HEIGHT - 0.05, 0.3]) corners.push(new THREE.Vector3(x, y, z));
  return corners;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Camera axes for an orientation, matching what `lookAt` produces with +Y up. */
export function cameraBasis({ polar, azimuth }: Orientation): { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 } {
  const z = new THREE.Vector3().setFromSphericalCoords(1, polar, azimuth);
  const x = new THREE.Vector3().crossVectors(UP, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return { x, y, z };
}

export interface Framing {
  target: THREE.Vector3;
  /** Pixels per world unit, which is what an orthographic camera's zoom means in R3F. */
  zoom: number;
  /** Half the content's size on screen at zoom 1, in world units, along the camera's x and y. */
  half: { x: number; y: number };
}

/**
 * Fits `corners` into the viewport's free area, scaled so the larger relative
 * dimension uses `fill` of it, and centred in that area rather than the canvas.
 */
export function frame(corners: readonly THREE.Vector3[], orientation: Orientation, viewport: Viewport, fill: number): Framing {
  const { x, y, z } = cameraBasis(orientation);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let depth = 0;
  for (const c of corners) {
    const px = c.dot(x);
    const py = c.dot(y);
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
    depth += c.dot(z) / corners.length;
  }
  const { width, height, insets } = viewport;
  const freeW = Math.max(1, width - insets.left - insets.right);
  const freeH = Math.max(1, height - insets.top - insets.bottom);
  const zoom = Math.min((freeW * fill) / (maxX - minX), (freeH * fill) / (maxY - minY));

  // Centre of the content, then shifted so it sits in the middle of the free area.
  const shiftX = (insets.left - insets.right) / 2 / zoom;
  const shiftY = (insets.top - insets.bottom) / 2 / zoom;
  const target = new THREE.Vector3()
    .addScaledVector(x, (minX + maxX) / 2 - shiftX)
    .addScaledVector(y, (minY + maxY) / 2 + shiftY)
    .addScaledVector(z, depth);
  return { target, zoom, half: { x: (maxX - minX) / 2, y: (maxY - minY) / 2 } };
}

/** Screen position (pixels from the canvas's top-left) of a world point for a framing. */
export function projectPoint(point: THREE.Vector3, orientation: Orientation, framing: Framing, viewport: Viewport): { x: number; y: number } {
  const { x, y } = cameraBasis(orientation);
  const rel = point.clone().sub(framing.target);
  return { x: viewport.width / 2 + rel.dot(x) * framing.zoom, y: viewport.height / 2 - rel.dot(y) * framing.zoom };
}
