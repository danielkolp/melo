import { RoundedBox, Text } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Suspense, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { swungSpan } from '../core/groove';
import { noteName } from '../core/theory';
import type { NoteEvent, TrackId } from '../core/types';
import { studio } from '../state/useStudio';
import { setCursor, useSceneBridge, useSceneTheme } from './context';
import { soundingPitches } from './Notes';
import { BLACK_KEY_LENGTH, KEY_LENGTH, LANE, SLAB_HEIGHT, type RollLayout } from './layout';
import monoFont from '@fontsource/martian-mono/files/martian-mono-latin-400-normal.woff?url';

const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
const BLACK_OFFSETS = [1, 3, 6, 8, 10];
const WHITE_HEIGHT = 0.09;
const BLACK_HEIGHT = 0.11;
const KEY_TOP = -0.012;
/** Gap between neighbouring keys along the pitch axis. */
const KEY_SPACING = 0.008;

interface KeySpec {
  pitch: number;
  black: boolean;
  /** Centre and size along the pitch axis. */
  z: number;
  size: number;
}

/** Keys aligned to the roll's lanes: black keys sit exactly on their lanes, white keys share 12 lanes seven ways. */
function buildKeys(layout: RollLayout): KeySpec[] {
  const keys: KeySpec[] = [];
  const front = layout.depth / 2;
  for (let octave = layout.low; octave <= layout.high; octave += 12) {
    const lane0 = octave - layout.low;
    WHITE_OFFSETS.forEach((offset, k) => {
      if (octave + offset > layout.high) return;
      const a = lane0 + (k * 12) / 7;
      const b = lane0 + ((k + 1) * 12) / 7;
      keys.push({ pitch: octave + offset, black: false, z: front - ((a + b) / 2) * LANE, size: (b - a) * LANE - KEY_SPACING });
    });
    for (const offset of BLACK_OFFSETS) {
      if (octave + offset > layout.high) continue;
      const lane = lane0 + offset;
      keys.push({ pitch: octave + offset, black: true, z: front - (lane + 0.5) * LANE, size: LANE * 0.78 });
    }
  }
  return keys;
}

interface Props {
  layout: RollLayout;
  notes: readonly NoteEvent[];
  swing: number;
}

export function Keyboard({ layout, notes, swing }: Props) {
  const { clock, audition } = useSceneBridge();
  const theme = useSceneTheme();
  const keys = useMemo(() => buildKeys(layout), [layout]);
  const spans = useMemo(
    () => notes.map((n) => ({ pitch: n.pitch, track: n.track, ...swungSpan(n.start, n.duration, swing) })),
    [notes, swing],
  );
  const pivots = useRef<(THREE.Group | null)[]>([]);
  const materials = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const state = useRef({ press: new Float32Array(keys.length), manual: new Map<number, number>(), sounding: new Map<number, TrackId>() });
  const colors = useMemo(() => {
    const out = {} as Record<TrackId, THREE.Color>;
    for (const t of Object.keys(theme.tracks) as TrackId[]) out[t] = new THREE.Color(theme.tracks[t]);
    return out;
  }, [theme]);
  const white = useMemo(() => new THREE.Color(theme.whiteKey), [theme]);
  const black = useMemo(() => new THREE.Color(theme.blackKey), [theme]);
  // Every white key is the same size, and so is every black key: two shared geometries.
  const shapes = useMemo(() => {
    const whiteSize = keys.find((k) => !k.black)?.size ?? LANE;
    const blackSize = keys.find((k) => k.black)?.size ?? LANE;
    return {
      white: new RoundedBoxGeometry(KEY_LENGTH - 0.01, WHITE_HEIGHT, whiteSize, 2, 0.012),
      black: new RoundedBoxGeometry(BLACK_KEY_LENGTH - 0.01, BLACK_HEIGHT, blackSize, 2, 0.014),
    };
  }, [keys]);

  if (state.current.press.length !== keys.length) state.current.press = new Float32Array(keys.length);

  useFrame((_, dt) => {
    const s = state.current;
    const sounding = clock.isRunning() ? soundingPitches(spans, clock.getTicks(), s.sounding) : (s.sounding.clear(), s.sounding);
    const now = performance.now() / 1000;
    keys.forEach((key, i) => {
      const pivot = pivots.current[i];
      const mat = materials.current[i];
      if (!pivot || !mat) return;
      const manualUntil = s.manual.get(key.pitch) ?? 0;
      const track = sounding.get(key.pitch) ?? (manualUntil > now ? studio.getState().activeTrack : undefined);
      s.press[i] = THREE.MathUtils.damp(s.press[i], track ? 1 : 0, track ? 45 : 10, dt);
      pivot.rotation.z = s.press[i] * 0.04;
      const base = key.black ? black : white;
      mat.color.copy(base);
      if (track) mat.color.lerp(colors[track], 0.7 * s.press[i] + 0.1);
      else if (s.press[i] > 0.01) mat.color.lerp(colors[studio.getState().activeTrack], s.press[i] * 0.4);
      mat.emissive.copy(track ? colors[track] : base);
      mat.emissiveIntensity = track ? 0.22 * s.press[i] : 0;
    });
  });

  const onKeyDown = (e: ThreeEvent<PointerEvent>, pitch: number) => {
    e.stopPropagation();
    state.current.manual.set(pitch, performance.now() / 1000 + 0.25);
    audition(studio.getState().activeTrack, pitch, 0.8);
  };

  const pivotX = layout.keyboardX + KEY_LENGTH;
  const bedY = -SLAB_HEIGHT / 2 - 0.05;

  return (
    <group>
      <RoundedBox
        args={[KEY_LENGTH + 0.08, SLAB_HEIGHT * 0.7, layout.depth + 0.08]}
        radius={0.03}
        smoothness={3}
        position={[layout.keyboardX + KEY_LENGTH / 2, bedY, 0]}
        receiveShadow
        castShadow
        raycast={() => null}
      >
        <meshStandardMaterial color={theme.keyBed} roughness={0.9} />
      </RoundedBox>
      {keys.map((key, i) => {
        const length = key.black ? BLACK_KEY_LENGTH : KEY_LENGTH;
        const height = key.black ? BLACK_HEIGHT : WHITE_HEIGHT;
        const top = key.black ? KEY_TOP + 0.05 : KEY_TOP;
        return (
          <group key={key.pitch} ref={(g) => void (pivots.current[i] = g)} position={[pivotX, top - height / 2, key.z]}>
            <mesh
              position={[-length / 2 - 0.004, 0, 0]}
              geometry={key.black ? shapes.black : shapes.white}
              castShadow
              receiveShadow
              onPointerDown={(e) => onKeyDown(e, key.pitch)}
              onPointerOver={(e) => {
                e.stopPropagation();
                setCursor('pointer');
              }}
              onPointerOut={() => setCursor('auto')}
            >
              <meshStandardMaterial
                ref={(m) => void (materials.current[i] = m)}
                color={key.black ? theme.blackKey : theme.whiteKey}
                roughness={key.black ? 0.32 : 0.5}
                metalness={0}
              />
            </mesh>
          </group>
        );
      })}
      <Suspense fallback={null}>
        {keys
          .filter((k) => k.pitch % 12 === 0)
          .map((k) => (
            <Text
              key={k.pitch}
              font={monoFont}
              fontSize={0.095}
              color="#6a665e"
              anchorX="left"
              anchorY="middle"
              rotation={[-Math.PI / 2, 0, 0]}
              position={[layout.keyboardX + 0.07, KEY_TOP + 0.002, k.z]}
              raycast={() => null}
            >
              {noteName(k.pitch)}
            </Text>
          ))}
      </Suspense>
    </group>
  );
}
