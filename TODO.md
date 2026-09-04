# TODO — future substantial packages

Placeholders for larger features to elaborate on when we get to each one.

1. Melody organelle.

   A `feature` organelle (same porthole/popup invocation as the ADSR
   envelope organelle — `ui/organelle.ts`: collapsed to a small porthole
   inset in its owner source's box, click to raise an expanded popup panel
   above the canvas).

   - **Content:** a musical staff, bass + treble (grand staff), with room
     for two ledger lines above and below each.
   - **Octave shift buttons:** tiny +8ve / -8ve buttons above the treble
     clef and below the bass clef. Tap cycle per button: off → +1 (or -1)
     octave, highlighted → +2 (or -2) → off again. Activating a shift does
     NOT move the staff itself — it changes which written pitch each note
     represents (the note plays one or two octaves above/below its written
     position). Existing notes visually move up/down the staff accordingly
     when a shift is (de)activated; notes are allowed to render off the top
     or bottom of the staff/ledger-line area, no clamping.
   - **Adding a note:** click a blank place on the staff to add a crotchet
     at that pitch/position.
   - **Changing note value:** click an existing note to halve its value one
     step (crotchet → quaver → semiquaver → ...). Right-click doubles it one
     step back up.
   - **Rest:** a crotchet rest icon fixed at the top right of the edit area.
     Click it to insert a rest immediately after the last note/rest/barline
     in sequence. Rest duration halves/doubles the same way notes do (click
     / right-click).
   - **Barline:** a barline icon fixed below the rest icon, top right. Click
     it to insert a barline after the last item.
   - **Dragging:** notes, rests, and barlines can all be dragged
     left/right to reposition them in sequence. Notes can also be dragged
     up/down to change pitch; a half-height drag (i.e. a drag of about half
     a staff-line/space step) adds a sharp or flat accidental instead of
     moving a full step.
   - **Key:** fixed to the key of C for now — no key signature, no
     accidental-spelling logic beyond the manual sharp/flat drag above.
     Modes/key signatures are a later discussion.

2. Sample capture.
3. Sequencer.
4. Beat matcher organelle for the sequencer.
5. Animation of the event connection line.
