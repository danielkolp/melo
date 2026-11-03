import { Dices, Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { togglePlayback } from '../audio/playback';
import { keyLabel } from '../core/theory';
import { totalTicks, type ImportSource, type StyleId, type TrackId } from '../core/types';
import { makeVariations, type Variation } from '../core/variations';
import { canDragOut, dragOut } from '../lib/dragMidi';
import { exportTakes, takesFile } from '../lib/exportMidi';
import { studio, useComposition, useStudio } from '../state/useStudio';
import { TRACK_COLORS, TRACK_LABELS } from '../theme';
import { Group, Segmented, Slider } from './controls';
import { TakeCard } from './TakeCard';

function amountLabel(amount: number): string {
  if (amount < 0.25) return 'subtle';
  if (amount < 0.5) return 'some';
  if (amount < 0.75) return 'far';
  return 'wild';
}

/** The uploaded parts and their variation cards. Click a card to hear it in the loop. */
export function UploadSection() {
  const { source, settings } = useComposition();
  const [chosen, setChosen] = useState<TrackId | null>(null);
  if (!source) return null;
  const track = source.parts.some((p) => p.track === chosen) ? chosen! : source.parts[0].track;
  return <Takes source={source} track={track} style={settings.style} onTrack={setChosen} />;
}

function Takes({ source, track, style, onTrack }: { source: ImportSource; track: TrackId; style: StyleId; onTrack(track: TrackId): void }) {
  const playing = useStudio((s) => s.isPlaying);
  const cards = useMemo(() => makeVariations(source, track, style), [source, track, style]);
  const part = source.parts.find((p) => p.track === track)!;
  const original: Variation = { label: 'Original', notes: part.notes };
  const picked = source.picked[track];
  const ticks = totalTicks(source.bars);
  const color = TRACK_COLORS[track];

  const pick = (take: number) => {
    studio.getState().pickTake(track, take);
    if (!playing) void togglePlayback();
  };

  return (
    <Group
      title="Your upload"
      aside={
        <button
          type="button"
          onClick={() => studio.getState().removeImport()}
          title="Let go of the upload and generate every part again"
          className="text-[12px] text-fg-faint transition-colors hover:text-fg"
        >
          Remove
        </button>
      }
    >
      <p className="-mt-1 mb-3 truncate text-[12.5px] text-fg-dim" title={source.fileName}>
        {source.fileName} <span className="text-fg-faint">· read in {keyLabel(source.key, source.scale)}</span>
      </p>
      {source.parts.length > 1 && (
        <Segmented
          label="Uploaded part"
          className="mb-3"
          value={track}
          options={source.parts.map((p) => ({ value: p.track, label: TRACK_LABELS[p.track] }))}
          onChange={onTrack}
        />
      )}

      <TakeCard
        take={original}
        track={track}
        index={0}
        picked={picked === 0}
        ticks={ticks}
        color={color}
        what="The part as uploaded"
        onPick={() => pick(0)}
        wide
      />
      <ol className="mt-1.5 grid grid-cols-2 gap-1.5" aria-label={`${TRACK_LABELS[track]} variations`}>
        {cards.map((card, i) => (
          <li key={`${source.variationSeed}-${i}`}>
            <TakeCard
              take={card}
              track={track}
              index={i + 1}
              picked={picked === i + 1}
              ticks={ticks}
              color={color}
              what={`Variation ${i + 1}: ${card.label}`}
              onPick={() => pick(i + 1)}
            />
          </li>
        ))}
      </ol>

      <div className="mt-4">
        <Slider
          label="How far"
          value={Math.round(source.amount * 100)}
          min={0}
          max={100}
          display={amountLabel(source.amount)}
          accent={color}
          onChange={(v) => studio.getState().setVariationAmount(v / 100)}
        />
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => studio.getState().rerollTakes()}
          className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-well text-[12.5px] text-fg transition-colors hover:bg-tint"
        >
          <Dices size={14} strokeWidth={1.7} />
          New ideas
        </button>
        <button
          type="button"
          onClick={() => exportTakes(track, original, cards)}
          title={`Download the original and every variation, one track each${canDragOut ? ', or drag them into your DAW' : ''}`}
          {...dragOut(() => takesFile(track, original, cards), { label: `${TRACK_LABELS[track]} takes`, color })}
          className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-well text-[12.5px] text-fg transition-colors hover:bg-tint"
        >
          <Download size={14} strokeWidth={1.7} />
          Export takes
        </button>
      </div>
    </Group>
  );
}
