import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStudio } from '../state/useStudio';
import { prefersReducedMotion } from './context';
import { ISO, TOP, cameraBasis, frame, sceneCorners, stageInsets, type Framing, type Orientation } from './framing';
import type { RollLayout } from './layout';

/** How much of the free stage the roll fills at the default zoom. */
const FILL = 0.94;
/** Zoom range in the fixed views, relative to the fitted framing. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 3.2;
/** Orthographic, so distance only matters for clipping. */
const DISTANCE = 60;

interface CamState {
  target: THREE.Vector3;
  polar: number;
  azimuth: number;
  zoom: number;
}

const offset = new THREE.Vector3();
const spherical = new THREE.Spherical();
const clamp = THREE.MathUtils.clamp;

function applyTo(camera: THREE.OrthographicCamera, s: CamState) {
  offset.setFromSphericalCoords(DISTANCE, s.polar, s.azimuth);
  camera.position.copy(s.target).add(offset);
  camera.up.set(0, 1, 0);
  camera.lookAt(s.target);
  if (camera.zoom !== s.zoom) {
    camera.zoom = s.zoom;
    camera.updateProjectionMatrix();
  }
}

/** Eases `cur` towards `goal` in spherical terms, so view changes arc around the roll. Returns true once there. */
function glide(cur: CamState, goal: CamState, dt: number, rate = 6): boolean {
  const k = prefersReducedMotion() ? 1 : 1 - Math.exp(-dt * rate);
  const dAz = Math.atan2(Math.sin(goal.azimuth - cur.azimuth), Math.cos(goal.azimuth - cur.azimuth));
  const zoomRatio = Math.log(goal.zoom / cur.zoom);
  const done =
    cur.target.distanceToSquared(goal.target) < 1e-7 &&
    Math.abs(goal.polar - cur.polar) < 1e-4 &&
    Math.abs(dAz) < 1e-4 &&
    Math.abs(zoomRatio) < 1e-4;
  if (done || k === 1) {
    cur.target.copy(goal.target);
    cur.polar = goal.polar;
    cur.azimuth = goal.azimuth;
    cur.zoom = goal.zoom;
    return true;
  }
  cur.target.lerp(goal.target, k);
  cur.polar += (goal.polar - cur.polar) * k;
  cur.azimuth += dAz * k;
  cur.zoom *= Math.exp(zoomRatio * k);
  return false;
}

/**
 * Isometric and Top are composed views: the camera is fixed, and the wheel
 * only zooms (towards the pointer, within limits). Explore hands the camera to
 * orbit controls. Every change of view glides rather than jumps.
 */
export function CameraRig({ layout }: { layout: RollLayout }) {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera;
  const size = useThree((s) => s.size);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const view = useStudio((s) => s.view);
  const nonce = useStudio((s) => s.cameraNonce);
  const controls = useRef<OrbitControlsImpl>(null);
  const cur = useRef<CamState | null>(null);
  /** Zoom factor and pan (along the camera's x/y, world units) the wheel has applied in the fixed views. */
  const user = useRef({ zoom: 1, pan: new THREE.Vector2() });
  /** Explore's reset target while it glides; null when the user has the camera. */
  const exploreGoal = useRef<CamState | null>(null);

  const corners = useMemo(() => sceneCorners(layout), [layout]);
  const viewport = useMemo(() => ({ width: size.width, height: size.height, insets: stageInsets(size.width) }), [size.width, size.height]);
  const fits = useMemo(
    () => ({ iso: frame(corners, ISO, viewport, FILL), top: frame(corners, TOP, viewport, FILL) }),
    [corners, viewport],
  );
  // Explore starts orbiting around wherever the camera is looking.
  const exploreTarget = useMemo(() => cur.current?.target.clone() ?? fits.iso.target.clone(), [view]);
  const fixed: { orientation: Orientation; fit: Framing } = view === 'top' ? { orientation: TOP, fit: fits.top } : { orientation: ISO, fit: fits.iso };

  const fixedGoal = (): CamState => {
    const { orientation, fit } = fixed;
    const { x, y } = cameraBasis(orientation);
    const u = user.current;
    return {
      target: fit.target.clone().addScaledVector(x, u.pan.x).addScaledVector(y, u.pan.y),
      polar: orientation.polar,
      azimuth: orientation.azimuth,
      zoom: fit.zoom * u.zoom,
    };
  };

  // Reset (F), view switches and a new loop length all return to the fitted framing.
  // Entering Explore keeps the current shot; resetting inside it glides back to the composed angle.
  const lastView = useRef(view);
  useEffect(() => {
    user.current.zoom = 1;
    user.current.pan.set(0, 0);
    if (view === 'explore' && lastView.current === 'explore' && cur.current) {
      exploreGoal.current = { target: fits.iso.target.clone(), polar: ISO.polar, azimuth: ISO.azimuth, zoom: fits.iso.zoom };
    }
    lastView.current = view;
    invalidate();
  }, [nonce, view, layout.bars]);

  // Keep wheel zoom inside the content: the further in, the further it may pan.
  const clampPan = () => {
    const u = user.current;
    const { half } = fixed.fit;
    const slack = 1 - 1 / u.zoom;
    u.pan.x = clamp(u.pan.x, -half.x * slack, half.x * slack);
    u.pan.y = clamp(u.pan.y, -half.y * slack, half.y * slack);
  };

  // Wheel and pinch zoom towards the pointer in the fixed views.
  useEffect(() => {
    if (view === 'explore') return;
    const el = gl.domElement;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const u = user.current;
      const base = fixed.fit.zoom;
      const before = u.zoom;
      const speed = e.ctrlKey ? 0.01 : 0.0016;
      u.zoom = clamp(u.zoom * Math.exp(-e.deltaY * speed), MIN_ZOOM, MAX_ZOOM);
      if (u.zoom === before) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - rect.width / 2;
      const py = e.clientY - rect.top - rect.height / 2;
      // Keep the point under the pointer where it is.
      const k = 1 / (base * before) - 1 / (base * u.zoom);
      u.pan.x += px * k;
      u.pan.y -= py * k;
      clampPan();
      invalidate();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const takeOver = () => {
      exploreGoal.current = null;
      c.enableDamping = true;
    };
    c.addEventListener('start', takeOver);
    return () => c.removeEventListener('start', takeOver);
  }, [view]);

  useFrame((_, dt) => {
    if (!cur.current) {
      // First frame: start exactly on the framing.
      cur.current = fixedGoal();
      applyTo(camera, cur.current);
      return;
    }
    const s = cur.current;
    const c = controls.current;

    if (view === 'explore' && c) {
      if (exploreGoal.current) {
        // Drop any orbit inertia first, or it keeps nudging the camera after the glide lands.
        if (c.enableDamping) {
          c.enableDamping = false;
          c.update();
        }
        const done = glide(s, exploreGoal.current, dt);
        applyTo(camera, s);
        c.target.copy(s.target);
        c.update();
        if (done) {
          exploreGoal.current = null;
          c.enableDamping = true;
        }
      } else {
        // The user is driving: remember where they are so leaving Explore glides from here.
        s.target.copy(c.target);
        spherical.setFromVector3(offset.copy(camera.position).sub(c.target));
        s.polar = spherical.phi;
        s.azimuth = spherical.theta;
        s.zoom = camera.zoom;
      }
      return;
    }

    if (view !== 'explore') {
      glide(s, fixedGoal(), dt);
      applyTo(camera, s);
    }
  });

  if (view !== 'explore') return null;
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={exploreTarget}
      enableDamping
      dampingFactor={0.09}
      rotateSpeed={0.55}
      zoomSpeed={0.9}
      minZoom={fits.iso.zoom * 0.45}
      maxZoom={fits.iso.zoom * 4}
      maxPolarAngle={Math.PI * 0.47}
      screenSpacePanning
    />
  );
}
