# Project notes for Claude

See the `blackhole-setup-reminder` skill for the machine-specific BlackHole
(sampler organelle recording) setup reminder.

## Doom lever: coupling multiple params together

`ui/doomLever.ts`'s `DOOM_LEVER_PITCH_TARGETS` normally drives one
`entity.params` key per voice (usually `frequency`/`pitch`). Sometimes
sweeping that one param toward the danger end (-135deg) doesn't read as
doomier on its own — e.g. grind's grain texture reads as quieter, not
scarier, as its frequency drops, which undercuts the lever's whole point.

The fix is `DoomLeverPitchTarget.compensate`: a second `{ param, minValue,
maxValue, centerValue? }` target, log-mapped across the same angle sweep as
the primary param (same `doomLeverAngleToValue` shape, just a second call).
`setDoomLeverAngle` (`ui/interaction.ts`) applies both in one go. See
grind's own entry for the pattern — `compensate: { param: 'level', ... }`
ramps volume up toward the danger end, flat at the lever's resting/up
position and through the safe end.

When a future voice needs the same "the danger end doesn't feel dangerous
enough" fix, reach for `compensate` rather than inventing a new mechanism.
It currently only carries one extra param; if a voice ever needs more than
two params coupled to the lever, generalize it to a list at that point
(not before — no real second caller for that shape yet).
