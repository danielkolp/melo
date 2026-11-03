import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { memo, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { PPQ, STEP, TRACK_IDS, type NoteEvent, type TrackId } from '../core/types';
import { studio, useStudio } from '../state/useStudio';
import type { SceneTheme } from '../theme';
import { ghost, prefersReducedMotion, setCursor, useSceneBridge, useSceneTheme } from './context';
import { LANE, NOTE_HEIGHT, NOTE_LIFT, noteRect, type RollLayout } from './layout';

const geometries = new Map<string, RoundedBoxGeometry>();

/** Shared per size: most notes are one of a handful of lengths. */
function blockGeometry(width: number, height: number, depth: number): RoundedBoxGeometry {
  const key = `${width.toFixed(3)}|${height}|${depth}`;
  let g = geometries.get(key);
  if (!g) {
    g = new RoundedBoxGeometry(width, height, depth, 2, Math.min(0.016, width * 0.25, height * 0.3));
    geometries.set(key, g);
  }
  return g;
}

const damp = THREE.MathUtils.damp;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();
/** Pixels the pointer must travel before a press on a note becomes a drag. */
const DRAG_THRESHOLD = 4;

interface Props {
  layout: RollLayout;
  notes: readonly NoteEvent[];
  swing: number;
}

export function Notes({ layout, notes, swing }: Props) {
  const selectedId = useStudio((s) => s.selectedId);
  const muted = useStudio((s) => s.muted);
  const theme = useSceneTheme();
  return (
    <group>
      {notes.map((note) => (
        <NoteBlock
          key={note.id}
          note={note}
          layout={layout}
          swing={swing}
          selected={note.id === selectedId}
          muted={muted[note.track]}
          theme={theme}
        />
      ))}
    </group>
  );
}

interface BlockProps {
  note: NoteEvent;
  layout: RollLayout;
  swing: number;
  selected: boolean;
  muted: boolean;
  theme: SceneTheme;
}

interface DragState {
  mode: 'move' | 'resize';
  /** Screen position of the press, for the click/drag threshold. */
  sx: number;
  sy: number;
  moved: boolean;
  x: number;
  z: number;
  start: number;
  pitch: number;
  duration: number;
  lastPitch: number;
}

const NoteBlock = memo(function NoteBlock({ note, layout, swing, selected, muted, theme }: BlockProps) {
  const group = useRef<THREE.Group>(null);
  const material = useRef<THREE.MeshPhysicalMaterial>(null);
  const { clock, audition } = useSceneBridge();
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const drag = useRef<DragState | null>(null);
  const anim = useRef({ born: -1, glow: 0, sel: 0, hover: 0, placed: false, hovered: false });

  const rect = noteRect(layout, note, swing);
  const isChord = note.track === 'chords';
  const height = isChord ? NOTE_HEIGHT * 0.6 : NOTE_HEIGHT;
  const depth = LANE * (isChord ? 0.58 : 0.8);
  const baseY = (isChord ? 0.012 : NOTE_LIFT) + height / 2;
  const geometry = blockGeometry(rect.width, height, depth);
  const color = useMemo(() => {
    const c = new THREE.Color(theme.tracks[note.track]);
    return muted ? c.lerp(new THREE.Color(theme.muted), 0.8) : c;
  }, [note.track, muted, theme]);
  const outlineScale: [number, number, number] = [1 + 0.024 / rect.width, 1 + 0.024 / height, 1 + 0.024 / depth];

  useFrame((state, dt) => {
    const g = group.current;
    const m = material.current;
    if (!g || !m) return;
    const a = anim.current;
    const now = state.clock.elapsedTime;
    const reduced = prefersReducedMotion();
    if (a.born < 0) a.born = now + (reduced ? 0 : (rect.start / layout.totalTicks) * 0.45);

    const spawn = reduced ? 1 : easeOut(THREE.MathUtils.clamp((now - a.born) / 0.45, 0, 1));
    const ticks = clock.getTicks();
    const active = clock.isRunning() && ticks >= rect.start && ticks < rect.end && (clock.isAudible?.(note.track) ?? true);
    a.glow = damp(a.glow, active ? 1 : 0, active ? 30 : 6, dt);
    a.sel = damp(a.sel, selected ? 1 : 0, 16, dt);
    a.hover = damp(a.hover, a.hovered || drag.current ? 1 : 0, 16, dt);

    if (!a.placed) {
      g.position.set(rect.x, baseY, rect.z);
      a.placed = true;
    } else {
      const speed = drag.current ? 40 : 12;
      g.position.x = damp(g.position.x, rect.x, speed, dt);
      g.position.z = damp(g.position.z, rect.z, speed, dt);
    }
    // Small lifts only: a played note rises a hair, a hovered or selected one a little more.
    g.position.y = baseY + (1 - spawn) * 0.6 + a.sel * 0.045 + a.hover * 0.018 + a.glow * 0.016;
    g.scale.y = 0.15 + 0.85 * spawn;
    m.emissiveIntensity = muted ? 0 : 0.02 + a.glow * theme.glow + a.hover * 0.05 + a.sel * 0.05;
  });

  const resizeZone = (x: number) => rect.width > 0.14 && rect.x + rect.width / 2 - x < Math.max(0.06, rect.width * 0.2);

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = studio.getState();
    s.select(note.id);
    audition(note.track, note.pitch, note.velocity / 127);
    drag.current = {
      mode: resizeZone(e.point.x) ? 'resize' : 'move',
      sx: e.nativeEvent.clientX,
      sy: e.nativeEvent.clientY,
      moved: false,
      x: e.point.x,
      z: e.point.z,
      start: note.start,
      pitch: note.pitch,
      duration: note.duration,
      lastPitch: note.pitch,
    };
    dragPlane.constant = -e.point.y;
    (e.target as unknown as Element).setPointerCapture(e.pointerId);
    if (controls) controls.enabled = false;
    s.beginGesture();
    setCursor(drag.current.mode === 'resize' ? 'ew-resize' : 'grabbing');
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const d = drag.current;
    if (!d) {
      setCursor(resizeZone(e.point.x) ? 'ew-resize' : 'grab');
      return;
    }
    // A press that hasn't travelled is still a click: nothing moves until it does.
    if (!d.moved && Math.hypot(e.nativeEvent.clientX - d.sx, e.nativeEvent.clientY - d.sy) < DRAG_THRESHOLD) return;
    d.moved = true;
    if (!e.ray.intersectPlane(dragPlane, hit)) return;
    const deltaTicks = Math.round((((hit.x - d.x) / layout.beatWidth) * PPQ) / STEP) * STEP;
    if (d.mode === 'resize') {
      studio.getState().previewNote(note.id, { duration: Math.max(STEP, d.duration + deltaTicks) });
      return;
    }
    const pitch = d.pitch + Math.round((d.z - hit.z) / LANE);
    studio.getState().previewNote(note.id, { start: d.start + deltaTicks, pitch });
    if (pitch !== d.lastPitch) {
      d.lastPitch = pitch;
      audition(note.track, pitch, note.velocity / 127);
    }
  };

  const endDrag = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current) return;
    e.stopPropagation();
    (e.target as unknown as Element).releasePointerCapture?.(e.pointerId);
    drag.current = null;
    if (controls) controls.enabled = true;
    studio.getState().endGesture();
    setCursor('grab');
  };

  return (
    <group ref={group}>
      <mesh
        geometry={geometry}
        castShadow
        receiveShadow
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onPointerOver={(e) => {
          e.stopPropagation();
          anim.current.hovered = true;
          ghost.visible = false;
        }}
        onPointerOut={() => {
          anim.current.hovered = false;
          if (!drag.current) setCursor('auto');
        }}
      >
        <meshPhysicalMaterial
          ref={material}
          color={color}
          emissive={color}
          emissiveIntensity={0.02}
          roughness={0.48}
          metalness={0}
          clearcoat={0.25}
          clearcoatRoughness={0.4}
        />
      </mesh>
      {selected && (
        <>
          <mesh geometry={geometry} scale={outlineScale} raycast={() => null}>
            <meshBasicMaterial color={theme.ink} side={THREE.BackSide} />
          </mesh>
          {/* Resize grip on the right end of the selected note. */}
          {rect.width > 0.14 && (
            <mesh position={[rect.width / 2 - 0.035, height / 2 + 0.002, 0]} rotation-x={-Math.PI / 2} raycast={() => null}>
              <planeGeometry args={[0.012, depth * 0.55]} />
              <meshBasicMaterial color={theme.ink} transparent opacity={0.45} depthWrite={false} />
            </mesh>
          )}
        </>
      )}
    </group>
  );
});

/** Which track is sounding on each pitch right now, for lighting up keys. Melody wins ties. */
export function soundingPitches(
  spans: readonly { pitch: number; start: number; end: number; track: TrackId }[],
  ticks: number,
  out: Map<number, TrackId>,
): Map<number, TrackId> {
  out.clear();
  for (const s of spans) {
    if (ticks < s.start || ticks >= s.end) continue;
    const current = out.get(s.pitch);
    if (current === undefined || TRACK_IDS.indexOf(s.track) < TRACK_IDS.indexOf(current)) out.set(s.pitch, s.track);
  }
  return out;
}
