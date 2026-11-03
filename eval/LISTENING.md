# Listening test: before vs after

The numbers in `report.md` are structural proxies. They say whether a melody repeats, whether the bass answers the kick, whether parts pile up on the same sixteenth. They can't say whether a loop is any good. This is the check that can.

## Files

`eval/midi/before/` was written by the generator before the overhaul, `eval/midi/after/` by the current one. Each folder has the same seeds in every style, 8 bars, key taken from the seed:

- `<style>-<seed>.mid`: the loop, one track per part (melody, counter, brass, chords, bass).
- `<style>-11-song.mid`, `<style>-222-song.mid`: the whole arrangement with drums and section markers.

Regenerate both with `EVAL_LABEL=before npm run eval` (only on the old code) and `npm run eval`.

## Setup in Ableton

1. Set the tempo to the style's: UKG 132, house 124, deep 122, melodic 122, rap 140. Swing is already in the timing.
2. Make five MIDI tracks with fixed sounds you know well, so only the notes change: a lead, a soft pluck (counter), a brass stab, an electric piano or pad (chords), a sub or reese bass. Add a simple drum loop in the style on its own track.
3. Drag a `before` file and its `after` twin onto the same tracks in two scenes. Ableton splits a multi-track file across tracks.
4. Have someone else rename the scenes **X** and **Y** at random and note which is which, so you don't know which engine you're hearing.

## Rating

Loop each scene four times. Rate each from 1 to 5:

| | What to listen for |
|---|---|
| **Hook** | Could you hum the top line after hearing it? Does it have one idea that comes back? |
| **Groove** | Does the bass move with the drums: sitting on some kicks, answering others, leaving space? Does it make you nod? |
| **Fit** | Do the parts leave each other room, or pile up on the same beats and registers? |
| **Development** | Does the 8 bars go somewhere (repeat, change, resolve), or loop the same bar? |
| **Use it?** | Would you drop this into a project and build on it? |

For the song files, also rate **Arrangement**: do the sections feel related but different, or the same loop with parts muted?

Do at least four seeds per style, UKG first. Then reveal X/Y and compare averages. A difference under half a point on a handful of loops is noise.

## What would count as better

- After wins **Hook** and **Groove** in UKG on most seeds, without losing **Use it?** elsewhere.
- No style gets worse on **Fit**.
- If after is busier but not better, that's a regression: more notes is not the goal.
