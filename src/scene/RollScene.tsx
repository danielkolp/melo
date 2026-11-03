import { Environment, Lightformer } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useMemo } from 'react';
import * as THREE from 'three';
import { studio, useComposition, useStudio } from '../state/useStudio';
import { AutomationDeck } from './AutomationDeck';
import { CameraRig } from './CameraRig';
import { ghost, setCursor, useSceneTheme } from './context';
import { Keyboard } from './Keyboard';
import { Labels } from './Labels';
import { Notes } from './Notes';
import { Playhead } from './Playhead';
import { RollTable } from './RollTable';
import { FloorShadow } from './FloorShadow';
import { createLayout, deckBounds, displayRange } from './layout';

/** Where the last press on the canvas started, so a drag that ends on nothing doesn't count as a click. */
const press = { x: 0, y: 0 };

export function RollScene() {
  return (
    <Canvas
      orthographic
      shadows="percentage"
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, toneMapping: THREE.NeutralToneMapping }}
      camera={{ near: 1, far: 200, position: [0, 40, 40], zoom: 40 }}
      onPointerDown={(e) => {
        press.x = e.clientX;
        press.y = e.clientY;
      }}
      onPointerMissed={(e) => {
        ghost.visible = false;
        setCursor('auto');
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 4) studio.getState().select(null);
      }}
      aria-label="3D piano roll"
      onCreated={(state) => {
        // Dev-only handle on the three.js state for debugging and automated checks.
        if (import.meta.env.DEV) Object.assign(window, { meloScene: state.get });
      }}
    >
      <Stage />
    </Canvas>
  );
}

function Stage() {
  const { notes, settings, progression, phrasing, automation } = useComposition();
  const focused = useStudio((s) => s.focusedLane);
  const theme = useSceneTheme();
  const laneIndex = Math.max(0, automation.findIndex((l) => l.id === focused));
  const range = displayRange(notes);
  const layout = useMemo(
    () => createLayout(settings.bars, range.low, range.high),
    [settings.bars, range.low, range.high],
  );
  const span = layout.x1 - layout.keyboardX;
  const front = deckBounds(layout).front;
  const { light } = theme;

  return (
    <>
      <ambientLight intensity={light.ambient} />
      <hemisphereLight args={[light.hemiSky, light.hemiGround, light.hemi]} />
      {/* One soft key light from the back left, so notes cast short shadows towards the viewer. */}
      <directionalLight
        position={[-4, 10, -6]}
        intensity={light.key}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-span * 0.7}
        shadow-camera-right={span * 0.7}
        shadow-camera-top={front + 1}
        shadow-camera-bottom={-front - 1}
        shadow-camera-near={1}
        shadow-camera-far={40}
        shadow-bias={-0.0004}
        shadow-normalBias={0.012}
        shadow-radius={5}
      />
      <directionalLight position={[6, 5, 9]} intensity={light.fill} color="#dfe6ff" />
      <Environment resolution={256} frames={1} environmentIntensity={light.env}>
        <Lightformer form="rect" intensity={2.2} color="#fff6ec" position={[0, 7, 3]} rotation-x={Math.PI / 2} scale={[14, 5, 1]} />
        <Lightformer form="rect" intensity={0.8} color="#d3dcff" position={[-9, 2.5, -2]} rotation-y={Math.PI / 2} scale={[10, 2, 1]} />
        <Lightformer form="ring" intensity={0.6} color="#ffe2d2" position={[7, 3, 7]} scale={3} />
      </Environment>

      <RollTable layout={layout} settings={settings} />
      <Labels layout={layout} progression={progression} phrasing={phrasing} settings={settings} />
      <AutomationDeck
        layout={layout}
        lane={automation[laneIndex] ?? null}
        index={laneIndex}
        count={automation.length}
        swing={settings.swing}
        onNext={() => studio.getState().focusLane(automation[(laneIndex + 1) % automation.length].id)}
      />
      <Keyboard layout={layout} notes={notes} swing={settings.swing} />
      <Notes layout={layout} notes={notes} swing={settings.swing} />
      <Playhead layout={layout} />
      <FloorShadow layout={layout} opacity={theme.contactShadow} />
      <CameraRig layout={layout} />
    </>
  );
}
