// Where: mobile/ios/KinicVoiceWidget/KinicVoiceWidget.swift
// What: Home and Lock Screen launchers for Kinic voice dictation.
// Why: A widget tap should reach the foreground recorder without attempting microphone work in the extension.

import SwiftUI
import WidgetKit

@main
struct KinicVoiceWidgetBundle: WidgetBundle {
    var body: some Widget {
        KinicVoiceWidget()
    }
}

struct KinicVoiceWidget: Widget {
    static let kind = "KinicVoiceWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: VoiceTimelineProvider()) { entry in
            VoiceWidgetEntryView(entry: entry)
                .containerBackground(for: .widget) {
                    Color(red: 0.98, green: 0.97, blue: 0.99)
                }
        }
        .configurationDisplayName("Kinic Voice Note")
        .description("Open KinicWiki and dictate a private on-device note.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

private struct VoiceTimelineEntry: TimelineEntry {
    let date: Date
}

private struct VoiceTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> VoiceTimelineEntry {
        VoiceTimelineEntry(date: .now)
    }

    func getSnapshot(in context: Context, completion: @escaping (VoiceTimelineEntry) -> Void) {
        completion(VoiceTimelineEntry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<VoiceTimelineEntry>) -> Void) {
        completion(Timeline(entries: [VoiceTimelineEntry(date: .now)], policy: .never))
    }
}

private struct VoiceWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: VoiceTimelineEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            Image(systemName: "mic.fill")
                .font(.title3)
                .widgetURL(WidgetVoiceCaptureLink.dictation)
                .accessibilityLabel("Start Kinic voice note")
        case .accessoryRectangular:
            Label("Voice Note", systemImage: "mic.fill")
                .font(.headline)
                .widgetURL(WidgetVoiceCaptureLink.dictation)
        case .systemMedium:
            HStack(spacing: 16) {
                widgetMark
                VStack(alignment: .leading, spacing: 6) {
                    Text("KinicWiki")
                        .font(.headline)
                    Text("Dictate a private note")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Link(destination: WidgetVoiceCaptureLink.dictation) {
                        Label("Start Voice Note", systemImage: "mic.fill")
                            .font(.subheadline.weight(.semibold))
                    }
                    Link(destination: WidgetVoiceCaptureLink.voiceMemo) {
                        Label("Start Voice Memo", systemImage: "waveform")
                            .font(.subheadline.weight(.semibold))
                    }
                }
                Spacer(minLength: 0)
            }
        default:
            VStack(spacing: 12) {
                widgetMark
                Text("Voice Note")
                    .font(.headline)
                Text("Tap to dictate")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .widgetURL(WidgetVoiceCaptureLink.dictation)
        }
    }

    private var widgetMark: some View {
        Image(systemName: "waveform.circle.fill")
            .font(.system(size: 42))
            .foregroundStyle(Color(red: 0.96, green: 0.13, blue: 0.48))
            .accessibilityHidden(true)
    }
}

#Preview(as: .systemSmall) {
    KinicVoiceWidget()
} timeline: {
    VoiceTimelineEntry(date: .now)
}

#Preview(as: .systemMedium) {
    KinicVoiceWidget()
} timeline: {
    VoiceTimelineEntry(date: .now)
}

#Preview(as: .accessoryCircular) {
    KinicVoiceWidget()
} timeline: {
    VoiceTimelineEntry(date: .now)
}

#Preview(as: .accessoryRectangular) {
    KinicVoiceWidget()
} timeline: {
    VoiceTimelineEntry(date: .now)
}
