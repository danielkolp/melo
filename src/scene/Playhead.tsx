import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useSceneBridge, useSceneTheme } from './context';
import { TABLE_MARGIN, tickToX, type RollLayout } from './layout';

const CURTAIN_HEIGHT = 0.3;
const STEM = 0.26;

/** A faint sheet standing on the roll, fading upward, that sweeps with playback. */
function createCurtainMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color() }, uStrength: { value: 0.05 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec2 vUv;
      void main() {
        float edge = smoothstep(0.0, 0.03, vUv.x) * smoothstep(1.0, 0.97, vUv.x);
        gl_FragColor = vec4(uColor, pow(1.0 - vUv.y, 2.6) * uStrength * edge);
      }
    `,
  });
}

/** A hairline across the grid, a faint sheet above it and a small marker on the back edge. */
export function Playhead({ layout }: { layout: RollLayout }) {
  const { clock } = useSceneBridge();
  const theme = useSceneTheme();
  const group = useRef<THREE.Group>(null);
  const curtain = useMemo(createCurtainMaterial, []);
  const back = -layout.depth / 2 - TABLE_MARGIN.back * 0.55;

  useEffect(() => void (curtain.uniforms.uColor.value as THREE.Color).set(theme.ink), [curtain, theme]);
  useEffect(() => () => curtain.dispose(), [curtain]);

  useFrame((_, dt) => {
    if (!group.current) return;
    const ticks = clock.getTicks() % layout.totalTicks;
    group.current.position.x = tickToX(layout, ticks);
    const strength = clock.isRunning() ? 0.11 : 0.04;
    curtain.uniforms.uStrength.value = THREE.MathUtils.damp(curtain.uniforms.uStrength.value, strength, 6, dt);
  });

  return (
    <group ref={group} position={[layout.x0, 0, 0]}>
      <mesh rotation-y={Math.PI / 2} position={[0, CURTAIN_HEIGHT / 2, 0]} material={curtain} raycast={() => null}>
        <planeGeometry args={[layout.depth, CURTAIN_HEIGHT]} />
      </mesh>
      <mesh position={[0, 0.003, 0]} rotation-x={-Math.PI / 2} raycast={() => null}>
        <planeGeometry args={[0.01, layout.depth]} />
        <meshBasicMaterial color={theme.ink} transparent opacity={0.75} depthWrite={false} />
      </mesh>
      <mesh position={[0, STEM / 2, back]} raycast={() => null} castShadow>
        <cylinderGeometry args={[0.006, 0.006, STEM, 8]} />
        <meshStandardMaterial color={theme.ink} roughness={0.4} />
      </mesh>
      <mesh position={[0, STEM, back]} raycast={() => null} castShadow>
        <sphereGeometry args={[0.028, 20, 16]} />
        <meshStandardMaterial color={theme.ink} roughness={0.35} />
      </mesh>
    </group>
  );
}
