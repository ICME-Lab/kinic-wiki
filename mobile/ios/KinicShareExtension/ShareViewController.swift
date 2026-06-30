// Where: mobile/ios/KinicShareExtension/ShareViewController.swift
// What: Minimal Share Extension controller for URL capture.
// Why: Browser share should enqueue a URL without requiring long-running canister work.

import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private var didEnqueue = false
    private var enqueueError: Error?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        enqueueSharedURL()
    }

    private func enqueueSharedURL() {
        let providers = extensionContext?.inputItems
            .compactMap { $0 as? NSExtensionItem }
            .flatMap { $0.attachments ?? [] } ?? []
        guard let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) else {
            complete()
            return
        }
        provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] item, _ in
            let sharedURL = item as? URL
            Task { @MainActor in
                if let sharedURL {
                    do {
                        let writer = try ShareQueueWriter()
                        try writer.enqueue(sharedURL)
                        self?.didEnqueue = true
                    } catch {
                        self?.enqueueError = error
                    }
                }
                self?.complete()
            }
        }
    }

    private func complete() {
        if let enqueueError {
            extensionContext?.cancelRequest(withError: enqueueError)
            return
        }
        if didEnqueue,
           let urlText = Bundle.main.object(forInfoDictionaryKey: "KINIC_OPEN_URL") as? String,
           let url = URL(string: urlText) {
            extensionContext?.open(url)
            extensionContext?.completeRequest(returningItems: nil)
            return
        }
        extensionContext?.completeRequest(returningItems: nil)
    }
}
