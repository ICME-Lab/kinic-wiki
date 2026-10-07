# Viewer-oriented review of the 19.5-second revision

Reviewed the encoded-frame sheets and `src/revised-demo.tsx` timing. This review
assesses communication and presentation; decoding successfully is not sufficient
for a finished public demo. Subjective audio listening was not performed.

1. **High — the story changes items without explaining the switch.** At 2–7.5 s,
   the user creates Write launch notes. At 7.5–14 s, the discussion belongs to
   Review launch copy. At 14–19.5 s, the widget opens Write launch notes again.
   The viewer must infer why the topic changed twice. Prefer one item across
   creation, teammate discussion, and widget entry. If separate items must remain,
   make the switch explicit and visually lead the eye to the selected row.
2. **Medium — the Home Screen exposes the XCTest runner.** From 14 s, the blank
   KinicUITests-Ru… icon is visible among the neighboring app icons. It reads as
   capture machinery or an unfinished app. Recapture the same widget with the
   runner uninstalled, retaining the normal neighboring icons.
3. **Medium — the send ring outlives its button.** The reply tap begins at frame
   314 and persists through frame 322. The screen changes to the posted result at
   frame 320. For frames 320–322 (approximately 10.67–10.73 s), the ring is drawn
   over the new comment's author header at the old button coordinate. Gate the
   ring to the pre-send screen or end it before the cut.
4. **Medium — discussion text gets little magnification.** Native 17-point text
   is enlarged only to roughly 18.3 points at the maximum 1.075× zoom. Several
   cards, principal IDs, and the empty composer remain on screen. On a small
   embedded player, the request and reply are less prominent than the captions.
   Present an enlarged discussion region that retains both author headers and
   message bodies, while leaving the active send button visible during input.

The revised widget presentation now communicates that this is a Home Screen
feature: full context precedes a restrained zoom, and neighboring icons remain
visible. Removing Close improves the pace. The widget tap cuts to its matching
item at 16.6 s without overlapping before/after screens or a blank frame.

The earlier technical review was too narrow to justify treating the public-facing
presentation as complete. The first two findings should be addressed before
calling this a polished release demo.
