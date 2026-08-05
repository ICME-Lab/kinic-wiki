// Where: mobile/ios/KinicApp/Views/AskAIScreenshotPreview.swift
// What: Public-safe Ask AI fixture used to capture App Store screenshots.
// Why: Store images must not depend on personal sign-in state or production data.

#if DEBUG
import SwiftUI

struct AskAIScreenshotPreview: View {
    private let sources = [
        AskAISource(
            id: "S1",
            path: "/Knowledge/AI Research Notes.md",
            excerpt: "Reliable memory keeps source context, retrieval boundaries, and evidence visible.",
            score: 0.96,
            matchReasons: ["title", "content"]
        ),
        AskAISource(
            id: "S2",
            path: "/Sources/web/Designing Reliable Agent Memory.md",
            excerpt: "Grounded answers should cite the notes that support each conclusion.",
            score: 0.91,
            matchReasons: ["content"]
        )
    ]

    var body: some View {
        TabView(selection: .constant(AppTab.askAI)) {
            Color.clear
                .tabItem { Label("Home", systemImage: "house") }
                .tag(AppTab.home)

            Color.clear
                .tabItem { Label("Browse", systemImage: "folder") }
                .tag(AppTab.browse)

            NavigationStack {
                workspace
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbarBackground(.visible, for: .navigationBar)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Text("Personal Memory")
                                .font(.headline)
                        }
                        ToolbarItemGroup(placement: .topBarTrailing) {
                            Button("History", systemImage: "clock.arrow.circlepath") {}
                                .labelStyle(.iconOnly)
                            Button("New conversation", systemImage: "square.and.pencil") {}
                                .labelStyle(.iconOnly)
                        }
                    }
            }
            .tabItem { Label("Ask AI", systemImage: "sparkles") }
            .tag(AppTab.askAI)

            Color.clear
                .tabItem { Label("Manage", systemImage: "slider.horizontal.3") }
                .tag(AppTab.manage)
        }
    }

    private var workspace: some View {
        ZStack {
            KinicDesign.appBackground
                .ignoresSafeArea()

            conversation
        }
        .safeAreaInset(edge: .bottom) {
            composer
        }
    }

    private var conversation: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                AskAIMessageView(
                    message: AskAIMessage(
                        role: .user,
                        text: "What makes agent memory reliable?"
                    ),
                    openSource: { _ in }
                )

                AskAIMessageView(
                    message: AskAIMessage(
                        role: .assistant,
                        text: "Reliable agent memory stays **grounded in source notes**, keeps retrieval scoped to one database, and shows the evidence behind each answer.",
                        sources: sources,
                        trace: [
                            AskAITraceEvent(
                                stage: .searching,
                                title: "Searched with 3 queries",
                                detail: "agent memory reliable\nagent memory grounded\nagent memory"
                            ),
                            AskAITraceEvent(
                                stage: .found,
                                title: "Found 4 candidate notes"
                            ),
                            AskAITraceEvent(
                                stage: .verifying,
                                title: "Verified 2 matching notes",
                                detail: "/Knowledge/agent-memory.md\n/Sources/memory-grounding.md"
                            ),
                            AskAITraceEvent(
                                stage: .reading,
                                title: "Used 2 notes for answer",
                                detail: "/Knowledge/agent-memory.md\n/Sources/memory-grounding.md"
                            )
                        ]
                    ),
                    openSource: { _ in }
                )
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 10) {
                Text("Message Kinic AI")
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: KinicDesign.largeRadius))

            Label(
                "Messages and recent conversation are sent to Kinic AI. Relevant notes are included only when needed.",
                systemImage: "lock.shield"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, KinicDesign.screenPadding)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(.ultraThinMaterial)
    }
}
#endif
