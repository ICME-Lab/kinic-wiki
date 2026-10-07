# KinicWiki launch demo

## New features demo

### Same-item story demo — latest

Latest deliverable: `../build/NewFeaturesDemo/KinicWiki-new-features-story.mp4`,
19.5 seconds, 1206 × 2622 at 30 fps. **Write launch notes** is the same item
through creation, a teammate's question, the reply, and the widget entry. The
native discussion cards are presented at 1.23× in a focused crop after posting;
their author IDs and complete message text are retained. The send ring is scoped
to the pre-send screen and cannot remain over the posted comment.

The Home Screen was recaptured after uninstalling the task Simulator's XCTest
runner. Other normal icons remain. `story-widget-clean.png` is the original
simctl capture, retained in `../build/NewFeaturesDemo/story-attachments/`.

`testCaptureSingleItemStoryDemo` passed with zero failures and asserted that the
widget reopened the item body with both the teammate question and posted reply.
The `demo-story` backend is opt-in and Debug-only. It seeds a deterministic
teammate comment when the new item is created; this is local demonstration data,
not a live remote user or synchronization claim. Production services are unused.
The owned Simulator was stopped and deleted after exporting all captures.

Regenerate with `python3 prepare-story-assets.py && python3 story-soundtrack.py && node render-story-demo.mjs`.
Use `verify-story-output.py` for encoded frame inspection. Reproduction also
needs the earlier `final-compose-clean-empty.png` card capture; retain the prior
composer attachment folder. New capture results are in `../build/SingleItemStory.xcresult`.

### Revised demo after viewer feedback

Latest deliverable: `../build/NewFeaturesDemo/KinicWiki-new-features-revised.mp4`,
19.5 seconds, 1206 × 2622 at 30 fps. The Close chapter is omitted. The widget
chapter first shows the actual Home Screen with neighboring app icons, then
zooms to 1.4× while keeping several icons visible. A tap cuts directly to the
linked item; no isolated widget card or overlapping before/after screens remains.

Regenerate with `python3 revised-soundtrack.py && node render-revised-demo.mjs`.
The source is `src/revised-demo.tsx`, interaction cues are in
`revised-timing.json`, and encoded-output checks use `verify-revised-output.py`.
The original 24-second version and its review are retained below for reference.

### Final reviewed portrait demo

`python3 prepare-final-assets.py && python3 final-soundtrack.py && node render-final-demo.mjs`
writes `../build/NewFeaturesDemo/KinicWiki-new-features-final.mp4`:
1206 × 2622, 30 fps, 24 seconds, H.264/AAC. `--previews-only` renders inspection
frames. The source is `src/final-demo.tsx`; cue frames are in `final-timing.json`.

The story is create **Write launch notes** in **Team Wiki**, open a teammate's
**Review launch copy**, reply to their comment, close that review, and open
**Write launch notes** from the Home Screen widget. The different author IDs
and preserved discussion make the shared-work context visible.

These are real Simulator screenshots animated and composed for the demo.
Creation fields and the widget are isolated from the captured pixels over a
blurred backdrop; typing, tap rings, focus outlines, camera movements, and
before/after transitions are editorial effects. There is no raw recording wait
and no claim of live multi-user synchronization. Data is seeded locally through
the real WorkItemRepository; production services are not used for capture.

`testCaptureFinalSharedDemo` passed with zero failures, including the widget
entry assertion that the app is foreground and the linked body is present.
Retain `../build/FinalSharedDemo3.xcresult`,
`../build/NewFeaturesDemo/final-attachments3/`, and
`../build/NewFeaturesDemo/final-composer-attachments/` for provenance and
regeneration. The additional composer-card capture passed before its test was
renamed `testCaptureFinalComposerCards`; it retains the native keyboard in the
source but only the actual title/body cards appear in the edit.

The capture-only `demo-final` fixture is Debug-only. The shared demo capture
requires `TEST_RUNNER_KINIC_DEMO_CAPTURE=1` and is skipped in normal test runs.
Use local Simulator signing (`CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`)
to retain the widget App Group entitlement. The task-owned capture Simulator
was stopped and deleted after exporting all the media.

The original synthesized audio contains no sampled music. Frame-aligned tones
use the same cue times as the edit; waveform validation is separate from
subjective listening. See `FINAL-QUALITY-REVIEW.md` for final output checks.

### Edited portrait demo

`python3 edited-soundtrack.py && node render-edited-demo.mjs` writes
`../build/NewFeaturesDemo/KinicWiki-new-features-edited.mp4` (1206 × 2622,
30fps, 25 seconds). It adds targeted zooms, frame-aligned tap rings, typing
overlays, focus borders, shorter cuts, and original interaction sounds.
`--draft` renders just the six-second create chapter; `--previews-only` renders
the inspection frames.
`python3 prepare-edited-assets.py` restores the captured images from the retained
capture folder. To recapture the widget entry, use
`TEST_RUNNER_KINIC_DEMO_CAPTURE=1 TEST_RUNNER_KINIC_DEMO_WIDGET_ONLY=1` and select
`KinicUITests/HomeNavigationUITests/testCaptureWidgetEntryDemo` with Simulator
local signing enabled.

`src/edited-demo.tsx` uses logical 402 × 874 point coordinates at 3× resolution.
Camera transforms apply equally to the captured screen and the tap/focus overlays.
Typing is reconstructed on actual captured fields; save, post, and close use
real Simulator recordings and captured results. The widget-to-item interaction
passed the opt-in `testCaptureWidgetEntryDemo` XCTest. Its before/after screenshots
are in `../build/NewFeaturesDemo/widget-entry-attachments/`. The simctl recording
stayed on the Home Screen despite XCTest capturing the opened detail, so the
final widget transition is edited from those actual screen captures rather than
using the unusable recording. All demo content remains local fixture data.

The media inputs (`edit-*.png`, `new-*.mp4`) are local in `public/`, excluded
from Git. Retain `../build/NewFeaturesDemo/` to regenerate the video.

### Earlier versions

`python3 render-ios-screen.py` writes the revised, native iPhone screen version
to `../build/NewFeaturesDemo/KinicWiki-new-features-ios.mp4` (1206 × 2622,
about 36 seconds). It shows the actual captures at full size, with no device
frame, side captions, or title cards. The widget remains a real still capture.

`src/new-features.tsx` is the focused 39-second demo of shared Work items and the
Home Screen widget. Create, comment, and close chapters use actual Simulator
recordings. The widget chapter uses a real Home Screen capture held for reading.
All data is public-safe and local: the opt-in `demo` NavigationFixture implements
the same WorkItemRepository operations against an isolated in-memory VFS. This
demonstrates the interface, not live multi-user synchronization.

The opt-in UI capture is skipped in routine tests. Run it with
`TEST_RUNNER_KINIC_DEMO_CAPTURE=1`, selecting
`KinicUITests/HomeNavigationUITests/testCaptureSharedItemsAndWidgetDemo`.
`TEST_RUNNER_KINIC_DEMO_WIDGET_ONLY=1` captures only the widget.
Build with `CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-` for Simulator captures:
the widget needs the App Group entitlements to read the app's snapshot.

Media, attachments, and scene timestamps are in `../build/NewFeaturesDemo/`.
`prepare-new-clips.py` prepares clips from `raw.mp4`, `markers.json`, and
`widget.png`. `node render-new-features.mjs` writes
`../build/NewFeaturesDemo/KinicWiki-new-features.mp4`.

## Original general introduction

30-second, 1920 × 1080, 30 fps marketing video built with Remotion. Uses current
iOS Simulator captures from the real SwiftUI views and public-safe Debug fixtures.
The Ask AI answer is seeded demo content, not a live AI request. Work item screenshots
come from the existing UI automation. The movie animates the captured screenshots;
raw Simulator recordings are retained separately. This is a marketing asset, not an App Store
Preview submission.

## Dependencies

Remotion, React, and a dedicated Chrome Headless Shell are installed locally in
this folder. Remotion includes FFmpeg; a system-wide FFmpeg install is unnecessary.
No paid editing software is required. Remotion licensing depends on organization
size and use: https://www.remotion.dev/license

Install independently of the application workspace:

```sh
pnpm --ignore-workspace install
```

## Capture

Build the current Debug app, install it on a task-owned Simulator, and run:

```sh
node capture.mjs <simulator-udid>
```

The script captures Home and Ask AI, including short recordings. It uses temporary
paths because the Simulator capture service cannot write directly to the external
volume. Export Work item attachments from the UI capture result bundle and copy a
dark screenshot as `public/detail.png`. Stop and delete the task-owned Simulator
after capture.

## Edit and render

```sh
node node_modules/@remotion/cli/remotion-cli.js studio src/index.tsx
python3 soundtrack.py
node render.mjs --stills-only
node render.mjs
```

The edit source is `src/index.tsx`. Outputs are in `../build/DemoVideo/` (ignored).
`public/` contains locally captured media and is ignored. The edit source and
dependency lock are retained for reproducible follow-up edits.

The soundtrack is generated from original sine-wave synth tones by `soundtrack.py`.
It contains no sampled or licensed third-party music.
