// Where: mobile/ios/KinicApp/Views/Vault/VaultPasswordGeneratorSheet.swift
// What: Standalone and inline password/passphrase generator with entropy strength meter.
// Why: Everyday 1Password-grade credential creation needs fast, unbiased password generation.

import KinicVaultCore
import SwiftUI

struct VaultPasswordStrengthBadge: View {
    let strength: VaultPasswordStrength

    init(password: String, overrideStrength: VaultPasswordStrength? = nil) {
        self.strength = overrideStrength ?? VaultPasswordGenerator.estimateStrength(password)
    }

    private var tintColor: Color {
        switch strength.level {
        case .weak: KinicDesign.errorRed
        case .fair: .orange
        case .strong: KinicDesign.vaultIndigo
        case .veryStrong: KinicDesign.successGreen
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: strength.level == .weak ? "exclamationmark.shield.fill" : "checkmark.shield.fill")
                .font(.caption2)
            Text("\(strength.level.displayName) · \(Int(strength.entropyBits.rounded())) bits")
                .font(.caption.weight(.semibold))
        }
        .foregroundStyle(tintColor)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(tintColor.opacity(0.14), in: Capsule())
        .accessibilityLabel("Password strength \(strength.level.displayName), estimated \(Int(strength.entropyBits.rounded())) bits of entropy")
    }
}

struct VaultPasswordGeneratorSheet: View {
    enum Mode: String, CaseIterable, Identifiable {
        case random = "Random"
        case passphrase = "Passphrase"
        var id: String { rawValue }
    }

    let onUse: ((String) -> Void)?

    @Environment(\.dismiss) private var dismiss
    @State private var mode: Mode = .random
    @State private var passwordOptions = VaultPasswordOptions()
    @State private var passphraseOptions = VaultPassphraseOptions()
    @State private var preview = ""
    @State private var copied = false

    init(onUse: ((String) -> Void)? = nil) {
        self.onUse = onUse
    }

    private var activeStrength: VaultPasswordStrength {
        switch mode {
        case .random:
            VaultPasswordGenerator.estimateStrength(preview)
        case .passphrase:
            VaultPasswordGenerator.estimatePassphraseStrength(passphraseOptions)
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 14) {
                        Picker("Mode", selection: $mode) {
                            ForEach(Mode.allCases) { item in
                                Text(item.rawValue).tag(item)
                            }
                        }
                        .pickerStyle(.segmented)
                        .onChange(of: mode) { regenerate() }

                        styledPasswordText(preview)
                            .font(.system(.title3, design: .monospaced).weight(.semibold))
                            .textSelection(.enabled)
                            .lineSpacing(4)
                            .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .background(KinicDesign.cardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                        HStack(spacing: 8) {
                            VaultPasswordStrengthBadge(password: preview, overrideStrength: activeStrength)
                            Spacer(minLength: 8)
                            Button {
                                regenerate()
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: "arrow.clockwise")
                                    Text("Regenerate")
                                }
                                .font(.caption.weight(.semibold))
                            }
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.capsule)
                            .controlSize(.small)
                            .tint(KinicDesign.hotPink)
                        }
                    }
                    .padding(.vertical, 4)
                }

                if mode == .random {
                    Section("Random Password Options") {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text("Length")
                                Spacer()
                                Text("\(passwordOptions.length)")
                                    .font(.body.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                            Slider(
                                value: Binding(
                                    get: { Double(passwordOptions.length) },
                                    set: {
                                        passwordOptions.length = Int($0.rounded())
                                        regenerate()
                                    }
                                ),
                                in: 8...64,
                                step: 1
                            )
                            .tint(KinicDesign.hotPink)
                        }

                        Toggle("Uppercase (A–Z)", isOn: Binding(
                            get: { passwordOptions.uppercase },
                            set: { passwordOptions.uppercase = $0; regenerate() }
                        ))
                        Toggle("Lowercase (a–z)", isOn: Binding(
                            get: { passwordOptions.lowercase },
                            set: { passwordOptions.lowercase = $0; regenerate() }
                        ))
                        Toggle("Numbers (0–9)", isOn: Binding(
                            get: { passwordOptions.digits },
                            set: { passwordOptions.digits = $0; regenerate() }
                        ))
                        Toggle("Symbols (!@#…)", isOn: Binding(
                            get: { passwordOptions.symbols },
                            set: { passwordOptions.symbols = $0; regenerate() }
                        ))
                        Toggle("Exclude ambiguous (0, O, 1, l, I)", isOn: Binding(
                            get: { passwordOptions.excludeAmbiguous },
                            set: { passwordOptions.excludeAmbiguous = $0; regenerate() }
                        ))
                    }
                } else {
                    Section("Passphrase Options") {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text("Words")
                                Spacer()
                                Text("\(passphraseOptions.words)")
                                    .font(.body.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                            Slider(
                                value: Binding(
                                    get: { Double(passphraseOptions.words) },
                                    set: {
                                        passphraseOptions.words = Int($0.rounded())
                                        regenerate()
                                    }
                                ),
                                in: 3...8,
                                step: 1
                            )
                            .tint(KinicDesign.hotPink)
                        }

                        Picker("Separator", selection: Binding(
                            get: { passphraseOptions.separator },
                            set: { passphraseOptions.separator = $0; regenerate() }
                        )) {
                            Text("Hyphen (-)").tag("-")
                            Text("Dot (.)").tag(".")
                            Text("Underscore (_)").tag("_")
                            Text("Space").tag(" ")
                        }

                        Toggle("Capitalize words", isOn: Binding(
                            get: { passphraseOptions.capitalize },
                            set: { passphraseOptions.capitalize = $0; regenerate() }
                        ))
                        Toggle("Include number", isOn: Binding(
                            get: { passphraseOptions.includeNumber },
                            set: { passphraseOptions.includeNumber = $0; regenerate() }
                        ))
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                bottomActionBar
            }
            .navigationTitle("Password Generator")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                if preview.isEmpty { regenerate() }
            }
        }
    }

    private var bottomActionBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Button {
                    VaultClipboardHelper.copy(preview, kind: .password)
                    copied = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        Text(copied ? "Copied" : (onUse == nil ? "Copy Password" : "Copy"))
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .tint(KinicDesign.hotPink)
                .disabled(preview.isEmpty)

                if let onUse {
                    Button {
                        onUse(preview)
                        dismiss()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "checkmark")
                            Text("Use Password")
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(KinicDesign.actionPink)
                    .disabled(preview.isEmpty)
                }
            }

            Text("Copied passwords stay on this device and clear after 60s.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) { Divider() }
    }

    private func regenerate() {
        copied = false
        switch mode {
        case .random:
            preview = (try? VaultPasswordGenerator.generate(passwordOptions)) ?? ""
        case .passphrase:
            preview = (try? VaultPasswordGenerator.generatePassphrase(passphraseOptions)) ?? ""
        }
    }

    private func styledPasswordText(_ text: String) -> Text {
        var result = AttributedString()
        for ch in text {
            var segment = AttributedString(String(ch))
            if ch.isNumber {
                segment.foregroundColor = KinicDesign.hotPink
            } else if !ch.isLetter {
                segment.foregroundColor = KinicDesign.vaultIndigo
            }
            result.append(segment)
        }
        return Text(result)
    }
}

#Preview {
    VaultPasswordGeneratorSheet(onUse: { _ in })
}
