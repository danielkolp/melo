import { RoundedBox } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { unswingTick } from '../core/groove';
import { scalePitchClasses } from '../core/theory';
import { BEATS_PER_BAR, PPQ, STEP, type CompositionSettings } from '../core/types';
import { studio, useStudio } from '../state/useStudio';
import { ghost, setCursor, useSceneBridge, useSceneTheme } from './context';
import { applyGridTheme, createGridMaterial, scaleMask } from './gridMaterial';
import { LANE, NOTE_HEIGHT, NOTE_LIFT, SLAB_HEIGHT, TABLE_MARGIN, pitchToZ, tickToX, xToTick, zToPitch, type RollLayout } from './layout';

interface Props {
  layout: RollLayout;
  settings: CompositionSettings;
}

export function RollTable({ layout, settings }: Props) {
  const material = useMemo(createGridMaterial, []);
  const theme = useSceneTheme();
  const { clock, audition } = useSceneBridge();
  const centerX = (layout.x0 + layout.x1) / 2;
  const slabDepth = layout.depth + TABLE_MARGIN.back + TABLE_MARGIN.front;
  const slabZ = (TABLE_MARGIN.front - TABLE_MARGIN.back) / 2;

  useEffect(() => {
    const u = material.uniforms;
    u.uBeats.value = layout.bars * BEATS_PER_BAR;
    u.uLanes.value = layout.lanes;
    u.uLow.value = layout.low;
    u.uScaleMask.value = scaleMask(scalePitchClasses(settings.key, settings.scale));
    u.uTonic.value = settings.key;
  }, [material, layout, settings.key, settings.scale]);

  useEffect(() => applyGridTheme(material, theme), [material, theme]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    material.uniforms.uPlay.value = (clock.getTicks() / PPQ) % (layout.bars * BEATS_PER_BAR);
    material.uniforms.uPlaying.value = clock.isRunning() ? 1 : 0;
  });

  /** Grid cell under the pointer: straight-time start tick and pitch. */
  const cellAt = (point: THREE.Vector3) => {
    const tick = unswingTick(Math.max(0, xToTick(layout, point.x)), settings.swing);
    const start = Math.min(layout.totalTicks - STEP, Math.floor(tick / STEP) * STEP);
    const pitch = Math.max(layout.low, Math.min(layout.high, Math.round(zToPitch(layout, point.z))));
    return { start, pitch };
  };

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (studio.getState().dragging) return;
    const { start, pitch } = cellAt(e.point);
    const length = studio.getState().activeTrack === 'chords' ? STEP * 4 : STEP * 2;
    ghost.visible = true;
    ghost.width = tickToX(layout, start + length) - tickToX(layout, start) - 0.012;
    ghost.x = tickToX(layout, start) + ghost.width / 2;
    ghost.z = pitchToZ(layout, pitch);
    setCursor('crosshair');
  };

  const onLeave = () => {
    ghost.visible = false;
    setCursor('auto');
  };

  const onDoubleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const { start, pitch } = cellAt(e.point);
    const track = studio.getState().activeTrack;
    const duration = track === 'chords' ? STEP * 4 : STEP * 2;
    studio.getState().addNote({ track, pitch, start, duration, velocity: 96 });
    audition(track, pitch, 0.75);
  };

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return;
    studio.getState().select(null);
  };

  return (
    <group>
      <RoundedBox
        args={[layout.width + TABLE_MARGIN.side * 2, SLAB_HEIGHT, slabDepth]}
        radius={0.04}
        smoothness={4}
        position={[centerX, -SLAB_HEIGHT / 2 - 0.002, slabZ]}
        receiveShadow
        castShadow
      >
        <meshStandardMaterial color={theme.table} roughness={0.88} metalness={0} />
      </RoundedBox>
      <mesh
        rotation-x={-Math.PI / 2}
        position={[centerX, 0.001, 0]}
        material={material}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onDoubleClick={onDoubleClick}
        onClick={onClick}
      >
        <planeGeometry args={[layout.width, layout.depth]} />
      </mesh>
      <GhostNote />
    </group>
  );
}

function GhostNote() {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useRef<THREE.MeshBasicMaterial>(null);
  const activeTrack = useStudio((s) => s.activeTrack);
  const theme = useSceneTheme();
  const dragging = useStudio((s) => s.dragging);

  useFrame(() => {
    if (!mesh.current) return;
    mesh.current.visible = ghost.visible && !dragging;
    mesh.current.position.set(ghost.x, NOTE_LIFT + NOTE_HEIGHT / 2, ghost.z);
    mesh.current.scale.set(Math.max(0.02, ghost.width), NOTE_HEIGHT, LANE * 0.78);
  });

  return (
    <mesh ref={mesh} visible={false} raycast={() => null}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial ref={material} color={theme.tracks[activeTrack]} transparent opacity={0.3} depthWrite={false} />
    </mesh>
  );
}
