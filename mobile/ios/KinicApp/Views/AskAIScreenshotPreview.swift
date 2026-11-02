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
                                .fixedSize(horizontal: true, vertical: false)
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
                    openSource: { _ in },
                    createWorkItem: { _ in }
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
                    openSource: { _ in },
                    createWorkItem: { _ in }
                )
            }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Text("Message Kinic AI")
                .foregroundStyle(.secondary)
                .padding(.leading, 18)
                .padding(.vertical, 13)
                .frame(maxWidth: .infinity, alignment: .leading)

            Image(systemName: "arrow.up")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: 36, height: 36)
                .background(Color.primary.opacity(0.08), in: Circle())
                .frame(minWidth: 44, minHeight: 44)
                .padding(.trailing, 2)
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
        .shadow(color: Color(red: 0.078, green: 0.078, blue: 0.169).opacity(0.04), radius: 10, y: 4)
        .padding(.horizontal, KinicDesign.screenPadding)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }
}
#endif
