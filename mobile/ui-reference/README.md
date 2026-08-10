# Mobile UI reference captures

The current iOS SwiftUI implementation is the visual source of truth for Android.
Captures use production view components with deterministic, public-safe state.

## Reference states

| Mode | State |
| --- | --- |
| `home` | Signed out, empty database list, status guidance visible |
| `browse` | Readable database list with Personal Memory available |
| `ask-ai` | Completed grounded answer with retrieval trace and source chips |
| `manage` | Owner database with Database, Access, Cycles, and Danger Zone sections |

Store paired captures as `ios/<mode>.png` and `android/<mode>.png`. Do not use the
July 2026 App Store captures as baselines; they predate the current SwiftUI views.

The iOS PNGs were captured from the current production SwiftUI components on an iOS
26.5 phone simulator. The temporary multi-screen iOS capture fixture was removed after
capture; the pre-existing Ask AI screenshot preview remains unchanged.

## Android capture mode

Launch the Debug activity with the matching intent extra:

```text
xyz.kinic.android.UI_REFERENCE_MODE = home | browse | ask-ai | manage
```

For example, after installing a Debug APK:

```bash
adb shell am force-stop xyz.kinic.android.kinicwiki
adb shell am start -n xyz.kinic.android.kinicwiki/xyz.kinic.android.MainActivity \
  --es xyz.kinic.android.UI_REFERENCE_MODE ask-ai
adb exec-out screencap -p > mobile/ui-reference/android/ask-ai.png
```

Use an API 35 phone at the default font scale in light appearance. Compare information
order, colors, 16/20 spacing and radii, and 44dp minimum targets. System bars, glyphs,
and platform font rasterization are intentionally allowed to differ.
