import { useEffect, useState } from 'react';
import { clock } from '../audio/playback';

function useTicks(read: () => number): number {
  const [ticks, setTicks] = useState(read);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const next = read();
      setTicks((prev) => (Math.abs(prev - next) >= 1 ? next : prev));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [read]);
  return ticks;
}

const loopTicks = () => clock.getTicks();
const songTicks = () => clock.getSongTicks();

/** Current position inside the loop, in ticks, updated every animation frame while it moves. */
export function usePlaybackTicks(): number {
  return useTicks(loopTicks);
}

/** Current position in the song (the same as the loop position outside song mode). */
export function useSongTicks(): number {
  return useTicks(songTicks);
}
