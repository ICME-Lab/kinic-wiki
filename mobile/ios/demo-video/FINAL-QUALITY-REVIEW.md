# Final demo review — 2026-10-07

Deliverable: `../build/NewFeaturesDemo/KinicWiki-new-features-final.mp4`.
24.000 seconds, 1206 × 2622, 30 fps, 720 frames, H.264 yuv420p with limited-range
BT.709 primaries/transfer/matrix, AAC stereo at 48 kHz. Size: 5,118,686 bytes.
The MP4 `moov` atom precedes `mdat`, so playback can start before download completes.

## Review result

The main defects recorded in `QUALITY-REVIEW.md` are resolved in this version.
This is an assessment against the agreed demo criteria, not a claim that no
further artistic improvement is possible.

| Earlier issue | Change and encoded-frame evidence |
| --- | --- |
| Shared work was unclear | Team Wiki is visible; Review launch copy has a teammate's existing comment and a reply from a different author. Both IDs and the discussion remain visible at 12.0 s. |
| Send button was cut off | The camera stays centered horizontally and reaches only 1.075× in the discussion chapter. The complete send circle is visible at 9.6667 and 10.4667 s. |
| Closed focus box crossed the wrong row | The new box encloses the actual title and Closed metadata at 16.8333 s, without enclosing Updated. |
| Tap effects preceded the result by too long | Save, send, close, and widget result transitions start six frames (0.20 s) after their tap cues. Fade-in completes within another eight or nine frames. |
| Destination/keyboard dominated typing | Native title/body card pixels are isolated and enlarged over a blurred backdrop. The active keyboard is outside the foreground crop; typed content is reconstructed. Check 3.1333 and 4.4667 s. |
| Widget entry waited and ending lingered | The widget is presented at roughly twice its native size; tap is at 20.4667 s and the linked item is fully visible by 20.9667 s. The final app view lasts about three seconds. |
| Clock/database text were inconsistent | Actual captures use 9:41 and Team Wiki, which fits in the widget. The widget item title matches the opened detail. |
| New transition defect found during preview | Before screens remain underneath each crossfade until the after screen is opaque; no zero-opacity gap remains. |
| Caption could cover the result composer | Reply caption fades out before the new comment is posted. The Complete caption appears only after returning to the list. |

## Verification evidence

- `testCaptureFinalSharedDemo` passed: one test, zero failures. It asserted the
  created item, teammate comment, posted reply, Reopen state, Closed list,
  widget item, app foreground state after the widget tap, and linked body.
  Result bundle: `../build/FinalSharedDemo3.xcresult`.
- Additional composer-card capture passed: one test, zero failures. Its test
  name was subsequently clarified to `testCaptureFinalComposerCards`; the
  capture source does retain a keyboard, and the video crops the native cards.
- `verify-final-output.py` extracted 30 exact-time frames from the final encoded
  deliverable, including before/during/after interactions and the last frame.
  Both sheets were visually inspected. Evidence:
  `../build/NewFeaturesDemo/final-review/encoded-sheet-0.jpg` and
  `encoded-sheet-1.jpg`.
- All 720 frames decoded successfully to reduced-resolution PNGs. Minimum mean
  RGB intensity was 10.157, at frame 628; the interaction transitions contain
  no fully black frame. Statistics: `final-review/verification.json`.
- Source soundtrack peak: −11.788 dBFS; RMS: −28.054 dBFS; clipped samples: 0.
  This is waveform/timing verification; subjective listening was not performed.
- Tap and sound cue frames use `final-timing.json`. Typing and before/after
  transitions are editorial animation over authentic Simulator captures.
- The task-owned capture Simulator was stopped and deleted. No booted Simulator
  remained in the post-capture listing.

## Scope and provenance

The video demonstrates the real app and widget interface using local Debug
fixture data through WorkItemRepository. It is an edited feature demo, not proof
of live multi-user synchronization or real-time network latency. It deliberately
omits typing delays, the keyboard, and widget setup. No production data was used.

The create and widget chapters isolate native screen regions over a blurred
backdrop. The discussion and completion chapters retain the full native screen
and use restrained zoom. No new product functionality was invented for the edit.
