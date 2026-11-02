// Where: mobile/ios/KinicApp/Views/AskAIComposerView.swift
// What: Multiline conversational composer.
// Why: Keep message entry and generation controls compact and accessible.

import SwiftUI

struct AskAIComposerView: View {
    @Bindable var model: AskAIModel
    @FocusState private var isFocused: Bool

    private var isNearLimit: Bool { model.remainingQuestionCharacters < 200 }

    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message Kinic AI", text: $model.draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .focused($isFocused)
                    .padding(.leading, 18)
                    .padding(.vertical, 13)

                Group {
                    if model.isGenerating {
                        Button(action: model.cancelGeneration) {
                            Label("Stop generating", systemImage: "stop.fill")
                                .foregroundStyle(KinicDesign.primaryButtonForeground)
                                .frame(width: 36, height: 36)
                                .background(KinicDesign.primaryButtonBackground.opacity(0.85), in: Circle())
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .disabled(model.isSynchronizingWorker)
                    } else {
                        Button(action: model.send) {
                            Label("Send", systemImage: "arrow.up")
                                .foregroundStyle(model.canSend ? Color.white : KinicDesign.bodyGray)
                                .frame(width: 36, height: 36)
                                .background {
                                    Circle().fill(model.canSend ? AnyShapeStyle(KinicDesign.auroraGradient) : AnyShapeStyle(Color.primary.opacity(0.08)))
                                }
                                .frame(minWidth: 44, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .disabled(!model.canSend)
                    }
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
                .font(.system(size: 16, weight: .bold))
                .padding(.trailing, 2)
                .padding(.bottom, 1)
                .animation(KinicDesign.spring, value: model.canSend)
                .animation(KinicDesign.spring, value: model.isGenerating)
                .sensoryFeedback(.impact(weight: .light), trigger: model.isGenerating) { _, new in new }
            }
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .strokeBorder(isFocused ? AnyShapeStyle(KinicDesign.auroraGradient) : AnyShapeStyle(Color.primary.opacity(0.08)), lineWidth: isFocused ? 1.2 : 0.5)
            }
            .shadow(color: Color(red: 0.078, green: 0.078, blue: 0.169).opacity(0.04), radius: 10, y: 4)
            .animation(.easeOut(duration: 0.2), value: isFocused)

            Text("\(model.draft.count) / \(AskAIModel.maximumQuestionCharacters) characters")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(isNearLimit ? KinicDesign.hotPink : .secondary)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, 10)
                .accessibilityLabel("\(model.remainingQuestionCharacters) characters remaining")
        }
        .padding(.horizontal, KinicDesign.screenPadding)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background {
            LinearGradient(colors: [Color(uiColor: .systemBackground).opacity(0), Color(uiColor: .systemBackground).opacity(0.9)], startPoint: .top, endPoint: .center)
                .ignoresSafeArea()
        }
    }
}
