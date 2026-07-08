// Where: mobile/ios/KinicShareExtension/ShareViewController.swift
// What: Share Extension controller for URL capture and explicit database selection.
// Why: Browser shares must show the writable DB target before saving.

import UIKit
import ICNativeClient
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let brandImageView = UIImageView(image: UIImage(named: "KinicMark"))
    private let brandLabel = UILabel()
    private let titleLabel = UILabel()
    private let messageLabel = UILabel()
    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let databaseTableView = UITableView(frame: .zero, style: .plain)
    private let refreshButton = UIButton(type: .system)
    private let saveButton = UIButton(type: .system)
    private let doneButton = UIButton(type: .system)
    private var sharedURL: URL?
    private var sharedMetadata: ShareCaptureMetadata?
    private var databases: [DatabaseSummary] = []
    private var selectedDatabaseId: String?
    private var configuration: AppConfiguration?
    private var session: ICAuthSession?
    private var settingsStore: SharedDefaultsStore?
    private var submitter: ShareCaptureSubmitter?

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

        databaseTableView.dataSource = self
        databaseTableView.delegate = self
        databaseTableView.backgroundColor = .white
        databaseTableView.separatorColor = KinicDesign.uiHairlineGray
        databaseTableView.layer.borderColor = KinicDesign.uiHairlineGray.cgColor
        databaseTableView.layer.borderWidth = 1
        databaseTableView.layer.cornerRadius = KinicDesign.radius
        databaseTableView.isHidden = true

        refreshButton.configuration = iconButtonConfiguration(systemName: "arrow.clockwise")
        refreshButton.accessibilityLabel = "Refresh databases"
        refreshButton.addTarget(self, action: #selector(refreshDatabases), for: .touchUpInside)
        refreshButton.isHidden = true

        saveButton.configuration = buttonConfiguration(title: "Save", filled: true)
        saveButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        saveButton.addTarget(self, action: #selector(saveSelectedDatabase), for: .touchUpInside)
        saveButton.isHidden = true
        saveButton.isEnabled = false

        doneButton.configuration = buttonConfiguration(title: "Done", filled: false)
        doneButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        doneButton.addTarget(self, action: #selector(finish), for: .touchUpInside)

        let textStack = UIStackView(arrangedSubviews: [titleLabel, messageLabel])
        textStack.axis = .vertical
        textStack.alignment = .fill
        textStack.spacing = 8

        let actionStack = UIStackView(arrangedSubviews: [activityIndicator, databaseTableView, refreshButton, saveButton, doneButton])
        actionStack.axis = .vertical
        actionStack.alignment = .fill
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
            databaseTableView.heightAnchor.constraint(equalToConstant: 240),
            refreshButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
            saveButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
            doneButton.widthAnchor.constraint(equalTo: stack.widthAnchor),
            doneButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50)
        ])
    }

    private func buttonConfiguration(title: String, filled: Bool) -> UIButton.Configuration {
        var configuration = UIButton.Configuration.plain()
        configuration.title = title
        configuration.baseForegroundColor = filled ? .white : .black
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 18, bottom: 14, trailing: 18)
        configuration.background.backgroundColor = filled ? KinicDesign.uiHotPink : .white
        configuration.background.strokeColor = filled ? KinicDesign.uiHotPink : KinicDesign.uiHairlineGray
        configuration.background.strokeWidth = 1
        configuration.background.cornerRadius = KinicDesign.radius
        return configuration
    }

    private func iconButtonConfiguration(systemName: String) -> UIButton.Configuration {
        var configuration = UIButton.Configuration.plain()
        configuration.image = UIImage(systemName: systemName)
        configuration.baseForegroundColor = .black
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 18, bottom: 14, trailing: 18)
        configuration.background.backgroundColor = .white
        configuration.background.strokeColor = KinicDesign.uiHairlineGray
        configuration.background.strokeWidth = 1
        configuration.background.cornerRadius = KinicDesign.radius
        return configuration
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
                self?.loadMetadataAndPrepareDatabaseSelection(for: sharedURL)
            }
        }
    }

    private func loadMetadataAndPrepareDatabaseSelection(for url: URL) {
        titleLabel.text = "Reading shared link..."
        messageLabel.text = "Checking whether the post includes preview text."
        Task { [weak self] in
            let metadata = await XPostMetadataFetcher().metadata(for: url)
            await MainActor.run {
                self?.prepareDatabaseSelection(for: url, captureMetadata: metadata)
            }
        }
    }

    private func showProcessing() {
        titleLabel.text = "Saving to KinicWiki..."
        messageLabel.text = "Keep this sheet open for a moment."
        activityIndicator.startAnimating()
        databaseTableView.isHidden = true
        refreshButton.isHidden = true
        saveButton.isHidden = true
        doneButton.isHidden = true
    }

    private func prepareDatabaseSelection(for url: URL, captureMetadata: ShareCaptureMetadata?) {
        sharedURL = url
        sharedMetadata = captureMetadata
        let configuration: AppConfiguration
        let activeSettingsStore: SharedDefaultsStore
        let activeSubmitter: ShareCaptureSubmitter
        do {
            configuration = AppConfiguration.liveFromBundle()
            activeSettingsStore = try SharedDefaultsStore(appGroupId: configuration.appGroupId, strict: true)
            activeSubmitter = try ShareCaptureSubmitter.makeLive(configuration: configuration)
        } catch {
            showResult(.failed(message: error.localizedDescription))
            return
        }
        self.configuration = configuration
        settingsStore = activeSettingsStore
        submitter = activeSubmitter

        guard let session = KinicAuthSessionStore(configuration: configuration).restore() else {
            submitSharedURL(url, captureMetadata: captureMetadata)
            return
        }
        self.session = session

        let cachedDatabases = activeSettingsStore.writableDatabases
        if !cachedDatabases.isEmpty {
            showDatabaseSelection(cachedDatabases, savedDatabaseId: activeSettingsStore.databaseId)
            return
        }

        refreshWritableDatabases(
            configuration: configuration,
            session: session,
            settingsStore: activeSettingsStore,
            fallbackWhenEmpty: true
        )
    }

    private func refreshWritableDatabases(
        configuration: AppConfiguration,
        session: ICAuthSession,
        settingsStore: SharedDefaultsStore,
        fallbackWhenEmpty: Bool
    ) {
        titleLabel.text = "Choose database"
        messageLabel.text = "Loading writable databases..."
        activityIndicator.startAnimating()
        databaseTableView.isHidden = true
        refreshButton.isHidden = true
        saveButton.isHidden = true
        doneButton.isHidden = true

        Task { [weak self] in
            let client = KinicICClient(configuration: configuration)
            do {
                let databases = try await client.listWritableDatabases(session: session)
                await MainActor.run {
                    settingsStore.writableDatabases = databases
                    self?.showDatabaseSelection(
                        databases,
                        savedDatabaseId: settingsStore.databaseId,
                        fallbackWhenEmpty: fallbackWhenEmpty
                    )
                }
            } catch {
                await MainActor.run {
                    self?.showRefreshFailure(error)
                }
            }
        }
    }

    private func showDatabaseSelection(_ loadedDatabases: [DatabaseSummary], savedDatabaseId: String, fallbackWhenEmpty: Bool = false) {
        guard !loadedDatabases.isEmpty else {
            if fallbackWhenEmpty {
                settingsStore?.databaseId = ""
                submitSharedURL(sharedURL, captureMetadata: sharedMetadata)
                return
            }
            databases = []
            selectedDatabaseId = nil
            titleLabel.text = "Choose database"
            messageLabel.text = "No writable databases were found."
            activityIndicator.stopAnimating()
            databaseTableView.reloadData()
            databaseTableView.isHidden = true
            refreshButton.isHidden = false
            refreshButton.isEnabled = true
            saveButton.isHidden = false
            doneButton.isHidden = false
            updateSaveButton()
            return
        }
        databases = loadedDatabases
        let savedId = savedDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        selectedDatabaseId = databases.contains(where: { $0.databaseId == savedId }) ? savedId : nil
        titleLabel.text = "Choose database"
        messageLabel.text = "Select where KinicWiki saves this URL."
        activityIndicator.stopAnimating()
        databaseTableView.reloadData()
        if let selectedIndex = databases.firstIndex(where: { $0.databaseId == selectedDatabaseId }) {
            databaseTableView.selectRow(
                at: IndexPath(row: selectedIndex, section: 0),
                animated: false,
                scrollPosition: .middle
            )
        }
        databaseTableView.isHidden = false
        refreshButton.isHidden = false
        refreshButton.isEnabled = true
        saveButton.isHidden = false
        doneButton.isHidden = false
        updateSaveButton()
    }

    private func submitSharedURL(
        _ url: URL?,
        databaseIdOverride: String? = nil,
        captureMetadata: ShareCaptureMetadata? = nil
    ) {
        guard let url else {
            showFailure(ShareExtensionError.missingURL)
            return
        }
        let activeSubmitter: ShareCaptureSubmitter
        if let submitter {
            activeSubmitter = submitter
        } else {
            do {
                activeSubmitter = try ShareCaptureSubmitter.makeLive(configuration: AppConfiguration.liveFromBundle())
            } catch {
                showResult(.failed(message: error.localizedDescription))
                return
            }
        }
        Task { [weak self] in
            let result = await activeSubmitter.submitSharedURL(
                url,
                databaseIdOverride: databaseIdOverride,
                captureMetadata: captureMetadata
            )
            await MainActor.run {
                self?.showResult(result)
            }
        }
    }

    private func updateSaveButton() {
        saveButton.isEnabled = selectedDatabaseId != nil
    }

    private func showResult(_ result: ShareCaptureResult) {
        activityIndicator.stopAnimating()
        databaseTableView.isHidden = true
        refreshButton.isHidden = true
        saveButton.isHidden = true
        doneButton.isHidden = false
        switch result {
        case .saved:
            titleLabel.text = "Capture started"
            messageLabel.text = "KinicWiki is generating the source capture."
        case let .queued(reason):
            titleLabel.text = "Saved for later"
            messageLabel.text = reason
        case let .failed(message):
            titleLabel.text = "Could not complete capture"
            messageLabel.text = message
        }
    }

    private func showFailure(_ error: Error) {
        activityIndicator.stopAnimating()
        databaseTableView.isHidden = true
        refreshButton.isHidden = true
        saveButton.isHidden = true
        titleLabel.text = "Could not complete capture"
        messageLabel.text = error.localizedDescription
        doneButton.isHidden = false
    }

    @objc private func saveSelectedDatabase() {
        guard let selectedDatabaseId else {
            return
        }
        settingsStore?.databaseId = selectedDatabaseId
        let databaseTitle = databases.first { $0.databaseId == selectedDatabaseId }?.displayTitle ?? selectedDatabaseId
        titleLabel.text = "Saving to KinicWiki..."
        messageLabel.text = "Saving to \(databaseTitle)."
        activityIndicator.startAnimating()
        databaseTableView.isHidden = true
        refreshButton.isHidden = true
        saveButton.isHidden = true
        doneButton.isHidden = true
        submitSharedURL(sharedURL, databaseIdOverride: selectedDatabaseId, captureMetadata: sharedMetadata)
    }

    @objc private func refreshDatabases() {
        guard let configuration, let session, let settingsStore else {
            showResult(.failed(message: "KinicWiki session is not available."))
            return
        }
        refreshButton.isEnabled = false
        saveButton.isEnabled = false
        refreshWritableDatabases(
            configuration: configuration,
            session: session,
            settingsStore: settingsStore,
            fallbackWhenEmpty: false
        )
    }

    private func showRefreshFailure(_ error: Error) {
        activityIndicator.stopAnimating()
        guard !databases.isEmpty else {
            showResult(.failed(message: error.localizedDescription))
            return
        }
        messageLabel.text = "Could not refresh databases: \(error.localizedDescription)"
        databaseTableView.isHidden = false
        refreshButton.isHidden = false
        refreshButton.isEnabled = true
        saveButton.isHidden = false
        doneButton.isHidden = false
        updateSaveButton()
    }

    @objc private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}

extension ShareViewController: UITableViewDataSource, UITableViewDelegate {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        databases.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let database = databases[indexPath.row]
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        cell.textLabel?.font = .preferredFont(forTextStyle: .headline)
        cell.textLabel?.text = database.displayTitle
        cell.detailTextLabel?.font = .preferredFont(forTextStyle: .footnote)
        cell.detailTextLabel?.textColor = KinicDesign.uiBodyGray
        cell.detailTextLabel?.numberOfLines = 2
        cell.detailTextLabel?.text = "\(database.role.displayName) - \(database.databaseId)"
        cell.tintColor = KinicDesign.uiHotPink
        cell.accessoryType = database.databaseId == selectedDatabaseId ? .checkmark : .none
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        selectedDatabaseId = databases[indexPath.row].databaseId
        tableView.deselectRow(at: indexPath, animated: true)
        tableView.reloadData()
        updateSaveButton()
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
