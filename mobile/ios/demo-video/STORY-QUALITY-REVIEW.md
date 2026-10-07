# Same-item demo: response to viewer review — 2026-10-07

Deliverable: `../build/NewFeaturesDemo/KinicWiki-new-features-story.mp4`.
Video duration 19.5 s (585 frames); container 19.52 s including AAC padding.
1206 × 2622, 30 fps, H.264 yuv420p, BT.709, AAC stereo. Size 4,730,691 bytes.

All four findings in `VIEWER-REVIEW-20261007.md` were addressed:

1. **One item throughout.** The created item, discussion title, widget title, and
   opened detail all say Write launch notes. The capture test reopened the same
   item through the widget and asserted the body, teammate question, and reply.
2. **No test-runner icon.** The XCTest runner was uninstalled from the task-owned
   Simulator after capture. The unchanged native Home Screen was then recaptured
   with simctl. Normal icons remain; no icon was painted out or synthesized.
   Provenance: `story-attachments/story-widget-clean.png`.
3. **No lingering send ring.** The tap exists only in the pre-send branch
   (`frame < 95` within the reply chapter). At the cut, frame 320 / 10.6667 s,
   neither the old send button nor its ring remains in the result presentation.
4. **Discussion is more prominent.** The two native comment cards are isolated
   and presented at 1.23×; effective message size is approximately 20.9 points
   rather than the earlier 18.3. Both author IDs and the complete question/reply
   remain visible with right padding. Cropping omits the timestamp area.

The Close chapter remains omitted. Widget context is shown at native scale before
zooming to 1.4× with neighboring icons visible. The tap at 16.4 s cuts directly
to the same item at 16.6 s. The final caption was moved below the composer so it
cannot cover the retained discussion or comment entry field.

## Checks

- `testCaptureSingleItemStoryDemo`: one test, zero failures, including app
  foreground and retained discussion assertions after the widget tap.
  Result bundle: `../build/SingleItemStory.xcresult`.
- Inspected both 30-frame encoded-output sheets, plus full-resolution previews
  of the enlarged conversation, clean Home Screen, and final app view.
  Evidence: `../build/NewFeaturesDemo/story-review/encoded-sheet-0.jpg`,
  `encoded-sheet-1.jpg`, and `verification.json`.
- All 585 frames decoded. Minimum mean RGB intensity: 11.622. No fully black
  frame or mixed before/after screen was found in the reviewed transitions.
- Source soundtrack: peak −12.014 dBFS, RMS −28.129 dBFS, zero clipped samples.
  Subjective listening was not performed.
- Task-owned Simulator CD8639B6-B4AE-4929-8FB7-69138658AD2C was stopped and
  deleted after all captures were saved. Post-cleanup booted listing was empty.

## Demonstration scope

Native app and widget screenshots use local, opt-in Debug data. The `demo-story`
fixture deterministically seeds the teammate question when the item is created.
This represents a discussion scenario, not a live remote participant or proof
of synchronization latency. Item creation and the reply use WorkItemRepository.
Typing, framing, magnification, and cuts are editorial effects; they do not add
product features or alter the text/author identity of the captured discussion.
