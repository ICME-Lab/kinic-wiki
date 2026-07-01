// Where: mobile/ios/KinicShareExtension/ShareViewController.swift
// What: Minimal Share Extension controller for URL capture.
// Why: Browser share should submit immediately when possible and otherwise preserve the URL.

import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let brandImageView = UIImageView(image: UIImage(named: "KinicMark"))
    private let brandLabel = UILabel()
    private let titleLabel = UILabel()
    private let messageLabel = UILabel()
    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let doneButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.overrideUserInterfaceStyle = .light
        view.backgroundColor = .white
        configureView()
        showProcessing()
        processSharedURL()
    }

    private func configureView() {
        brandImageView.contentMode = .scaleAspectFit
        brandImageView.translatesAutoresizingMaskIntoConstraints = false
        brandImageView.widthAnchor.constraint(equalToConstant: 28).isActive = true
        brandImageView.heightAnchor.constraint(equalToConstant: 28).isActive = true
        brandImageView.accessibilityElementsHidden = true

        brandLabel.text = "KinicWiki"
        brandLabel.font = .preferredFont(forTextStyle: .headline)
        brandLabel.textColor = .black

        let brandStack = UIStackView(arrangedSubviews: [brandImageView, brandLabel])
        brandStack.axis = .horizontal
        brandStack.alignment = .center
        brandStack.spacing = 8

        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.textColor = .black
        titleLabel.numberOfLines = 0

        messageLabel.font = .preferredFont(forTextStyle: .body)
        messageLabel.textColor = KinicDesign.uiBodyGray
        messageLabel.numberOfLines = 0

        activityIndicator.color = KinicDesign.uiHotPink
        activityIndicator.hidesWhenStopped = true

        var doneConfiguration = UIButton.Configuration.plain()
        doneConfiguration.title = "Done"
        doneConfiguration.baseForegroundColor = .black
        doneConfiguration.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 18, bottom: 14, trailing: 18)
        doneConfiguration.background.backgroundColor = .white
        doneConfiguration.background.strokeColor = KinicDesign.uiHairlineGray
        doneConfiguration.background.strokeWidth = 1
        doneConfiguration.background.cornerRadius = KinicDesign.radius
        doneButton.configuration = doneConfiguration
        doneButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        doneButton.addTarget(self, action: #selector(finish), for: .touchUpInside)

        let textStack = UIStackView(arrangedSubviews: [titleLabel, messageLabel])
        textStack.axis = .vertical
        textStack.alignment = .fill
        textStack.spacing = 8

        let actionStack = UIStackView(arrangedSubviews: [activityIndicator, doneButton])
        actionStack.axis = .vertical
        actionStack.alignment = .center
        actionStack.spacing = 12

        let stack = UIStackView(arrangedSubviews: [brandStack, textStack, actionStack])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            doneButton.widthAnchor.constraint(equalTo: stack.widthAnchor),
            doneButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50)
        ])
    }

    private func processSharedURL() {
        let providers = extensionContext?.inputItems
            .compactMap { $0 as? NSExtensionItem }
            .flatMap { $0.attachments ?? [] } ?? []
        guard let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) else {
            showFailure(ShareExtensionError.missingURL)
            return
        }
        provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] item, error in
            let sharedURL = shareURL(from: item)
            let loadErrorDescription = error?.localizedDescription
            Task { @MainActor in
                if let loadErrorDescription {
                    self?.showFailure(ShareExtensionError.loadFailed(loadErrorDescription))
                    return
                }
                guard let sharedURL else {
                    self?.showFailure(ShareExtensionError.missingURL)
                    return
                }
                self?.submitSharedURL(sharedURL)
            }
        }
    }

    private func showProcessing() {
        titleLabel.text = "Saving to KinicWiki..."
        messageLabel.text = "Keep this sheet open for a moment."
        activityIndicator.startAnimating()
        doneButton.isHidden = true
    }

    private func submitSharedURL(_ url: URL) {
        let submitter = ShareCaptureSubmitter(configuration: AppConfiguration.liveFromBundle())
        Task { [weak self] in
            let result = await submitter.submitSharedURL(url)
            await MainActor.run {
                self?.showResult(result)
            }
        }
    }

    private func showResult(_ result: ShareCaptureResult) {
        activityIndicator.stopAnimating()
        doneButton.isHidden = false
        switch result {
        case let .saved(requestPath, triggerError):
            titleLabel.text = "Saved to KinicWiki"
            messageLabel.text = triggerError ?? "Source capture request created at \(requestPath)."
        case let .queued(reason):
            titleLabel.text = "Saved for later"
            messageLabel.text = reason
        case let .failed(message):
            titleLabel.text = "Could not save URL"
            messageLabel.text = message
        }
    }

    private func showFailure(_ error: Error) {
        activityIndicator.stopAnimating()
        titleLabel.text = "Could not save URL"
        messageLabel.text = error.localizedDescription
        doneButton.isHidden = false
    }

    @objc private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}

private func shareURL(from item: NSSecureCoding?) -> URL? {
    if let url = item as? URL {
        return url
    }
    if let nsURL = item as? NSURL {
        return nsURL as URL
    }
    if let text = item as? String {
        return URL(string: text)
    }
    return nil
}

private enum ShareExtensionError: LocalizedError {
    case missingURL
    case loadFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingURL:
            return "No share URL was provided by this browser."
        case let .loadFailed(message):
            return message
        }
    }
}
