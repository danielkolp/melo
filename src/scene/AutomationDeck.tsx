import { Line, RoundedBox, Text } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Suspense, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { AUTOMATION_PARAMS, valueAt } from '../core/automation';
import { swingTick, unswingTick } from '../core/groove';
import { STEP, TICKS_PER_BAR, type AutomationLane, type AutomationPoint } from '../core/types';
import { TRACK_LABELS } from '../theme';
import { setCursor, useSceneBridge, useSceneTheme } from './context';
import { DECK, TABLE_MARGIN, deckBounds, tickToX, type RollLayout } from './layout';
import monoFont from '@fontsource/martian-mono/files/martian-mono-latin-400-normal.woff?url';

interface Props {
  layout: RollLayout;
  lane: AutomationLane | null;
  index: number;
  count: number;
  swing: number;
  /** Clicking the deck shows the next lane. */
  onNext(): void;
}

const flat: [number, number, number] = [-Math.PI / 2, 0, 0];
const noRaycast = () => null;
/** Deck surface sits a little below the table so it reads as its own tier. */
const TOP = -0.045;
const INSET = 0.12;
const RIBBON = 0.035;

/** Breakpoints subdivided finely enough that swing bends the line where it bends the notes. */
function densify(points: readonly AutomationPoint[]): AutomationPoint[] {
  const out: AutomationPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.max(1, Math.ceil((b.tick - a.tick) / (STEP / 2)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      out.push({ tick: a.tick + (b.tick - a.tick) * t, value: a.value + (b.value - a.value) * t });
    }
  }
  return out;
}

/**
 * The focused automation lane, drawn as a raised ribbon on a strip in front of
 * the roll. Higher values sit further back, like higher notes do.
 */
export function AutomationDeck({ layout, lane, index, count, swing, onNext }: Props) {
  const { clock } = useSceneBridge();
  const theme = useSceneTheme();
  const bounds = deckBounds(layout);
  const left = layout.keyboardX - 0.05;
  const right = layout.x1 + TABLE_MARGIN.side;
  const zOf = (v: number) => bounds.front - INSET - v * (DECK.depth - INSET * 2);
  const color = lane?.enabled ? theme.tracks[lane.track] : theme.muted;

  const shape = useMemo(() => {
    if (!lane) return null;
    const pts = densify(lane.points).map((p) => ({ x: tickToX(layout, swingTick(p.tick, swing)), z: zOf(p.value) }));
    const base = zOf(0);
    const fill: number[] = [];
    const wall: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      fill.push(a.x, 0, base, b.x, 0, base, b.x, 0, b.z, a.x, 0, base, b.x, 0, b.z, a.x, 0, a.z);
      wall.push(a.x, 0, a.z, b.x, 0, b.z, b.x, RIBBON, b.z, a.x, 0, a.z, b.x, RIBBON, b.z, a.x, RIBBON, a.z);
    }
    const geometry = (data: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(data, 3));
      g.computeVertexNormals();
      return g;
    };
    return {
      fill: geometry(fill),
      wall: geometry(wall),
      line: pts.map((p) => [p.x, RIBBON, p.z] as [number, number, number]),
    };
  }, [lane, layout, swing]); // zOf depends only on the layout.

  const dot = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!dot.current) return;
    dot.current.visible = !!lane?.enabled;
    if (!lane) return;
    const ticks = clock.getTicks() % layout.totalTicks;
    const v = valueAt(lane.points, unswingTick(ticks, swing));
    dot.current.position.set(tickToX(layout, ticks), RIBBON, zOf(v));
  });

  const spec = lane ? AUTOMATION_PARAMS[lane.param] : null;

  return (
    <group position={[0, TOP, 0]}>
      <RoundedBox
        args={[right - left, DECK.height, DECK.depth]}
        radius={0.03}
        smoothness={3}
        position={[(left + right) / 2, -DECK.height / 2 - 0.002, (bounds.back + bounds.front) / 2]}
        receiveShadow
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.delta <= 4 && count > 1) onNext();
        }}
        onPointerOver={() => count > 1 && setCursor('pointer')}
        onPointerOut={() => setCursor('auto')}
      >
        <meshStandardMaterial color={theme.table} roughness={0.85} metalness={0.05} />
      </RoundedBox>

      {/* Range guides and bar lines. */}
      {[0, 1].map((v) => (
        <mesh key={v} position={[(layout.x0 + layout.x1) / 2, 0.001, zOf(v)]} rotation={flat} raycast={noRaycast}>
          <planeGeometry args={[layout.width, 0.006]} />
          <meshBasicMaterial color={theme.ink} transparent opacity={v ? 0.08 : 0.16} depthWrite={false} />
        </mesh>
      ))}
      {Array.from({ length: layout.bars + 1 }, (_, bar) => (
        <mesh key={bar} position={[tickToX(layout, bar * TICKS_PER_BAR), 0.001, zOf(0.5)]} rotation={flat} raycast={noRaycast}>
          <planeGeometry args={[0.006, DECK.depth - INSET * 2]} />
          <meshBasicMaterial color={theme.ink} transparent opacity={0.1} depthWrite={false} />
        </mesh>
      ))}

      {shape && (
        <>
          <mesh geometry={shape.fill} position-y={0.002} raycast={noRaycast}>
            <meshBasicMaterial color={color} transparent opacity={lane?.enabled ? 0.16 : 0.08} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
          <mesh geometry={shape.wall} raycast={noRaycast} castShadow>
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={lane?.enabled ? 0.35 : 0}
              roughness={0.45}
              transparent
              opacity={lane?.enabled ? 0.9 : 0.5}
              side={THREE.DoubleSide}
            />
          </mesh>
          <Line points={shape.line} color={color} lineWidth={1.6} transparent opacity={lane?.enabled ? 1 : 0.5} raycast={noRaycast} />
        </>
      )}

      <group ref={dot} visible={false}>
        <mesh raycast={noRaycast}>
          <sphereGeometry args={[0.032, 20, 14]} />
          <meshStandardMaterial color={theme.ink} emissive={theme.ink} emissiveIntensity={0.5} roughness={0.3} />
        </mesh>
      </group>

      <Suspense fallback={null}>
        <group position={[layout.keyboardX + 0.04, 0.002, bounds.back + INSET * 0.6]}>
          <Text font={monoFont} fontSize={0.065} color={theme.ink} fillOpacity={0.5} anchorX="left" anchorY="top" rotation={flat} raycast={noRaycast}>
            {count > 1 ? `AUTOMATION ${index + 1}/${count} ›` : 'AUTOMATION'}
          </Text>
          <Text
            font={monoFont}
            fontSize={0.092}
            color={theme.ink}
            fillOpacity={lane?.enabled === false ? 0.45 : 0.9}
            anchorX="left"
            anchorY="top"
            rotation={flat}
            position={[0, 0, 0.115]}
            raycast={noRaycast}
          >
            {lane ? lane.title : 'None suggested'}
          </Text>
          {lane && spec && (
            <Text
              font={monoFont}
              fontSize={0.066}
              color={color}
              anchorX="left"
              anchorY="top"
              rotation={flat}
              position={[0, 0, 0.255]}
              raycast={noRaycast}
            >
              {`${TRACK_LABELS[lane.track]} · ${spec.short}${lane.enabled ? '' : ' · off'}`}
            </Text>
          )}
        </group>
      </Suspense>
    </group>
  );
}
