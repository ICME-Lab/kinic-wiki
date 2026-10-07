# Revision after viewer feedback — 2026-10-07

Deliverable: `../build/NewFeaturesDemo/KinicWiki-new-features-revised.mp4`.
Video duration: 19.5 s (585 frames at 30 fps). Container duration: 19.52 s due
to AAC padding. 1206 × 2622, H.264 yuv420p, BT.709, AAC stereo, 5,084,500 bytes.

The Close chapter has been removed. The sequence is create, discuss, Home Screen
widget, and the item opened from the widget. The unused Close/back sound cues
were also removed. The native Close button may still appear in the app toolbar;
the video does not demonstrate changing the item's status.

The widget chapter shows the actual full Home Screen for one second, including
Fitness, Watch, Reminders, Files, and the KinicWiki icon. It then zooms to 1.4×,
with neighboring icons still visible. The widget remains in its real Home Screen
position rather than appearing as an isolated card over a blurred background.

The tap cue occurs at 16.4 s. The app detail replaces the Home Screen directly at
16.6 s. The encoded frame at 16.5667 s is still the Home Screen; at 16.6 s it is
already the linked item. There is no crossfade, blank intermediate frame, or
overlapping widget/app screen. Save and post transitions also use direct cuts.

Both 30-frame contact sheets were visually inspected:
`../build/NewFeaturesDemo/revised-review/encoded-sheet-0.jpg` and
`encoded-sheet-1.jpg`. All 585 frames decoded successfully. Minimum mean RGB
intensity was 10.228; no fully black frame was found. The shortened source audio
has no clipped samples. Statistics are in `revised-review/verification.json`.

This edit reuses the previously validated native Simulator screenshots and local
fixture data. The capture test's assertions for widget entry and item body still
apply to those screenshots; no Simulator or production services were changed
for this editing revision.
