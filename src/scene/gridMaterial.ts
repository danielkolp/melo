import * as THREE from 'three';
import type { SceneTheme } from '../theme';

/**
 * Draws the piano-roll grid procedurally on top of the table surface: faint
 * lane shading for black keys and in-scale notes, then a quiet hierarchy of
 * sixteenth, beat, bar and octave lines. Lines are antialiased in screen space
 * so they stay hairline-thin at any zoom.
 */

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uBeats;
  uniform float uBeatsPerBar;
  uniform float uLanes;
  uniform float uLow;
  uniform float uScaleMask;
  uniform float uTonic;
  uniform vec3 uInk;
  uniform vec3 uShade;
  uniform float uShadeAlpha;
  uniform float uLineAlpha;
  uniform float uPlay;
  uniform float uPlaying;
  varying vec2 vUv;

  float bit(float mask, float index) {
    return mod(floor(mask / exp2(index)), 2.0);
  }

  // 1.0 on integer values of coord, widthPx pixels wide, antialiased.
  float gridLine(float coord, float widthPx) {
    float fw = max(fwidth(coord), 1e-5);
    float d = abs(fract(coord + 0.5) - 0.5) / fw;
    return 1.0 - clamp(d - widthPx * 0.5 + 0.5, 0.0, 1.0);
  }

  // Fades a family of lines out once they get closer than a few pixels.
  float density(float coord) {
    return 1.0 - smoothstep(0.1, 0.25, fwidth(coord));
  }

  // Cheap value noise for a faint material grain.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  vec4 over(vec4 dst, vec3 color, float alpha) {
    return vec4(color * alpha + dst.rgb * (1.0 - alpha), alpha + dst.a * (1.0 - alpha));
  }

  void main() {
    float beat = vUv.x * uBeats;
    float lane = vUv.y * uLanes;
    float pitch = uLow + floor(lane);
    float pc = mod(pitch, 12.0);

    vec4 c = vec4(0.0);
    // Black-key rows sit slightly lower in tone, like the keys they continue.
    c = over(c, uShade, bit(1354.0, pc) * 0.1 * uShadeAlpha);
    c = over(c, uInk, bit(uScaleMask, pc) * 0.014 * uLineAlpha);
    c = over(c, uInk, (abs(pc - uTonic) < 0.5 ? 1.0 : 0.0) * 0.028 * uLineAlpha);
    c = over(c, uShade, (hash(floor(gl_FragCoord.xy)) - 0.5) * 0.02 * uShadeAlpha + 0.01 * uShadeAlpha);

    if (uPlaying > 0.5 && beat < uPlay) {
      c = over(c, uInk, exp(-(uPlay - beat) * 2.4) * 0.035 * uLineAlpha);
    }

    float l = uLineAlpha;
    c = over(c, uInk, gridLine(lane, 1.0) * 0.028 * l * density(lane));
    c = over(c, uInk, gridLine((lane - mod(12.0 - mod(uLow, 12.0), 12.0)) / 12.0, 1.0) * 0.09 * l);
    c = over(c, uInk, gridLine(beat * 4.0, 1.0) * 0.02 * l * density(beat * 4.0));
    c = over(c, uInk, gridLine(beat, 1.0) * 0.065 * l * density(beat));
    c = over(c, uInk, gridLine(beat / uBeatsPerBar, 1.25) * 0.2 * l);

    gl_FragColor = vec4(c.rgb / max(c.a, 1e-4), c.a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createGridMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uBeats: { value: 16 },
      uBeatsPerBar: { value: 4 },
      uLanes: { value: 48 },
      uLow: { value: 36 },
      uScaleMask: { value: 0 },
      uTonic: { value: 0 },
      uInk: { value: new THREE.Color('#2b2925') },
      uShade: { value: new THREE.Color('#5a554c') },
      uShadeAlpha: { value: 1 },
      uLineAlpha: { value: 1 },
      uPlay: { value: 0 },
      uPlaying: { value: 0 },
    },
  });
}

export function applyGridTheme(material: THREE.ShaderMaterial, theme: SceneTheme): void {
  const u = material.uniforms;
  (u.uInk.value as THREE.Color).set(theme.ink);
  (u.uShade.value as THREE.Color).set(theme.shade);
  u.uShadeAlpha.value = theme.grid.shade;
  u.uLineAlpha.value = theme.grid.lines;
}

export function scaleMask(pitchClasses: readonly number[]): number {
  return pitchClasses.reduce((mask, pc) => mask | (1 << pc), 0);
}
