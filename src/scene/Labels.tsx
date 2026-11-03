import { Text } from '@react-three/drei';
import { Suspense } from 'react';
import { chordSymbol, prefersFlats } from '../core/theory';
import { ROLE_LABELS } from '../core/melody';
import { TICKS_PER_BAR, type Chord, type CompositionSettings, type Phrasing } from '../core/types';
import { useSceneTheme } from './context';
import { TABLE_MARGIN, tickToX, type RollLayout } from './layout';
import monoFont from '@fontsource/martian-mono/files/martian-mono-latin-400-normal.woff?url';

interface Props {
  layout: RollLayout;
  progression: readonly Chord[];
  phrasing: Phrasing;
  settings: CompositionSettings;
}

const flat: [number, number, number] = [-Math.PI / 2, 0, 0];
const noRaycast = () => null;
/** Martian Mono's advance width, in ems. */
const MONO_ADVANCE = 0.72;

/** Bar numbers and phrase roles along the back edge, chord symbols along the front, printed on the table. */
export function Labels({ layout, progression, phrasing, settings }: Props) {
  const flats = prefersFlats(settings.key, settings.scale);
  const theme = useSceneTheme();
  const back = -layout.depth / 2 - TABLE_MARGIN.back / 2;
  const front = layout.depth / 2 + TABLE_MARGIN.front / 2;
  return (
    <Suspense fallback={null}>
      {Array.from({ length: layout.bars }, (_, bar) => (
        <Text
          key={`bar-${bar}`}
          font={monoFont}
          fontSize={0.19}
          color={theme.ink}
          fillOpacity={0.7}
          anchorX="left"
          anchorY="middle"
          rotation={flat}
          position={[tickToX(layout, bar * TICKS_PER_BAR) + 0.05, 0.002, back]}
          raycast={noRaycast}
        >
          {String(bar + 1)}
        </Text>
      ))}
      {phrasing.sections.map((section) => (
        <Text
          key={`role-${section.start}`}
          font={monoFont}
          fontSize={0.105}
          letterSpacing={0.06}
          color={theme.tracks[section.voice]}
          fillOpacity={0.85}
          anchorX="left"
          anchorY="middle"
          rotation={flat}
          position={[tickToX(layout, section.start) + 0.3, 0.002, back + 0.01]}
          raycast={noRaycast}
        >
          {ROLE_LABELS[section.role].toUpperCase()}
        </Text>
      ))}
      {progression.map((chord) => {
        const symbol = chordSymbol(chord, flats);
        // Half-bar chords on a long loop leave little room: shrink a long symbol to fit its span.
        const span = tickToX(layout, chord.start + chord.duration) - tickToX(layout, chord.start) - 0.1;
        return (
          <Text
            key={`chord-${chord.start}`}
            font={monoFont}
            fontSize={Math.min(0.12, span / (symbol.length * MONO_ADVANCE))}
            color={theme.ink}
            fillOpacity={0.8}
            anchorX="left"
            anchorY="middle"
            rotation={flat}
            position={[tickToX(layout, chord.start) + 0.05, 0.002, front]}
            raycast={noRaycast}
          >
            {symbol}
          </Text>
        );
      })}
    </Suspense>
  );
}
