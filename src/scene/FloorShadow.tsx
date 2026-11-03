import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { SLAB_HEIGHT, TABLE_MARGIN, deckBounds, type RollLayout } from './layout';

const SIZE = 256;
/** Fraction of the texture the solid footprint covers; the rest is blur. */
const CORE = 0.74;

/**
 * A soft shadow a little below the instrument, so it reads as an object
 * floating over the stage. Painted once into a small texture rather than
 * rendered from depth every time, which keeps it cheap and free of artefacts.
 */
function createShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext('2d')!;
  const inset = (SIZE * (1 - CORE)) / 2;
  // Draw the rectangle off-canvas and keep only its blurred shadow (works without ctx.filter).
  g.shadowColor = 'rgba(0,0,0,1)';
  g.shadowBlur = SIZE * 0.06;
  g.shadowOffsetX = SIZE * 2;
  g.fillStyle = '#000';
  g.beginPath();
  g.roundRect(inset - SIZE * 2, inset, SIZE * CORE, SIZE * CORE, SIZE * 0.04);
  g.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function FloorShadow({ layout, opacity }: { layout: RollLayout; opacity: number }) {
  const texture = useMemo(createShadowTexture, []);
  useEffect(() => () => texture.dispose(), [texture]);

  const left = layout.keyboardX;
  const right = layout.x1 + TABLE_MARGIN.side;
  const back = -layout.depth / 2 - TABLE_MARGIN.back;
  const front = deckBounds(layout).front;
  // The key light comes from the back left, so the shadow falls forward and right,
  // and is a touch smaller than the table so its blur never shows behind it.
  const x = (left + right) / 2 + 0.6;
  const z = (back + front) / 2 + 1;
  const shrink = 0.86;

  return (
    <mesh position={[x, -SLAB_HEIGHT - 0.5, z]} rotation-x={-Math.PI / 2} raycast={() => null} renderOrder={-1}>
      <planeGeometry args={[((right - left) * shrink) / CORE, ((front - back) * shrink) / CORE]} />
      <meshBasicMaterial map={texture} color="#000000" transparent opacity={opacity} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}
