import AuthenticationServices
import UIKit

/// AutoFill Credential Provider (passwords) — specs/mobile-local-store.md §6.
///
/// 1. List: `autofill_index` (vault.db opened with the LSK) filtered by
///    DomainMatching for the requesting site; the user picks ONE login.
/// 2. `device_unlock` must exist, else "Open my-secrect and enable
///    biometric unlock" and the request is cancelled.
/// 3. Face ID / Touch ID → AMK → Vault Key → Item Key → that one row →
///    `ASPasswordCredential(user, password)`. Keys are wiped after use.
/// Every failure cancels with an `ASExtensionError`; no empty or made-up
/// credential is ever returned. Passkeys are not handled here.
final class CredentialProviderViewController: ASCredentialProviderViewController {
    private static let unlockReason = "Unlock my-secrect to fill the password you picked."
    private static let enableBiometricUnlock = "Open my-secrect and enable biometric unlock."
    /// The request is answered exactly once (a late unlock after Cancel is dropped).
    private var answered = false
    /// LocalAuthentication refuses a prompt from an extension that is not on
    /// screen yet (LAError.notInteractive, "Caller is not running
    /// foreground"), which is the case inside
    /// prepareInterfaceToProvideCredential. The prompt waits for viewDidAppear.
    private var isOnScreen = false
    private var runWhenOnScreen: (() -> Void)?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        isOnScreen = true
        let pending = runWhenOnScreen
        runWhenOnScreen = nil
        pending?()
    }

    private func whenOnScreen(_ work: @escaping () -> Void) {
        if isOnScreen { work() } else { runWhenOnScreen = work }
    }

    // MARK: - System entry points

    /// The user opened the provider from the AutoFill sheet / key icon.
    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        let entries: [AutoFillIndexEntry]
        do {
            entries = try ProviderVault.open().autofillEntries()
        } catch {
            fail(error)
            return
        }
        CredentialIdentitySync.replaceAll(with: entries)
        let candidates = AutoFillMatcher.candidates(entries: entries, serviceIdentifiers: serviceIdentifiers)
        let pageHost = serviceIdentifiers.lazy.compactMap(AutoFillMatcher.pageHost(for:)).first
        show(CredentialListViewController(
            candidates: candidates,
            pageHost: pageHost,
            onSelect: { [weak self] candidate in self?.confirmThenFill(candidate) },
            onCancel: { [weak self] in self?.cancel(.userCanceled) }
        ))
    }

    /// QuickType suggestion without UI. Every fill needs Face ID / Touch ID,
    /// so ask the system for the interactive path instead.
    override func provideCredentialWithoutUserInteraction(for credentialIdentity: ASPasswordCredentialIdentity) {
        cancel(.userInteractionRequired)
    }

    /// QuickType suggestion with UI (after `.userInteractionRequired`).
    override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
        guard let recordID = credentialIdentity.recordIdentifier else {
            cancel(.credentialIdentityNotFound)
            return
        }
        let entry: AutoFillIndexEntry?
        do {
            entry = try ProviderVault.open().autofillEntry(id: recordID)
        } catch {
            fail(error)
            return
        }
        guard let entry else {
            cancel(.credentialIdentityNotFound)
            return
        }
        // Same gate as the list, against the identity the system matched.
        let service = credentialIdentity.serviceIdentifier
        switch AutoFillMatcher.decision(entry: entry, service: service) {
        case .allowed:
            fill(AutoFillCandidate(entry: entry, serviceIdentifier: service, confirmation: nil))
        case .needsConfirmation(let reason):
            confirmThenFill(AutoFillCandidate(entry: entry, serviceIdentifier: service, confirmation: reason))
        case .denied(let reason):
            showMessage(reason) { [weak self] in self?.cancel(.failed, reason) }
        }
    }

    /// Settings › General › AutoFill & Passwords, when the provider is enabled.
    override func prepareInterfaceForExtensionConfiguration() {
        show(ConfigurationViewController { [weak self] in
            self?.extensionContext.completeExtensionConfigurationRequest()
        })
    }

    // MARK: - Fill one credential

    private func confirmThenFill(_ candidate: AutoFillCandidate) {
        guard let reason = candidate.confirmation else {
            fill(candidate)
            return
        }
        let alert = UIAlertController(title: "Check this website", message: reason, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in self?.cancel(.userCanceled) })
        alert.addAction(UIAlertAction(title: "Fill", style: .destructive) { [weak self] _ in self?.fill(candidate) })
        present(alert, animated: true)
    }

    private func fill(_ candidate: AutoFillCandidate) {
        guard let pageHost = AutoFillMatcher.pageHost(for: candidate.serviceIdentifier),
              let accessGroup = ProviderVault.keychainAccessGroup else {
            cancel(.failed)
            return
        }
        // Everything read before the prompt is ciphertext or metadata.
        let row: EncryptedVaultRow
        let unlock: DeviceUnlockRecord
        let storedKeysJSON: String
        do {
            let db = try ProviderVault.open()
            guard let found = try db.row(id: candidate.entry.id) else {
                cancel(.credentialIdentityNotFound)
                return
            }
            guard let record = try db.deviceUnlock() else {
                showMessage(Self.enableBiometricUnlock) { [weak self] in self?.cancel(.failed, Self.enableBiometricUnlock) }
                return
            }
            row = found
            unlock = record
            storedKeysJSON = try db.storedKeysJSON()
        } catch {
            fail(error)
            return
        }

        show(MessageViewController(message: "Unlocking…", busy: true, onClose: { [weak self] in self?.cancel(.userCanceled) }))
        whenOnScreen { [weak self] in
            DeviceUnlock.authenticate(reason: Self.unlockReason) { authentication in
                // LocalAuthentication queue: keychain and crypto stay off the main thread.
                let outcome = Result<LoginSecret, Error> {
                    let context = try authentication.get()
                    defer { context.invalidate() }
                    let accountMasterKey = try DeviceUnlock.unwrapAccountMasterKey(unlock, accessGroup: accessGroup, context: context)
                    defer { accountMasterKey.wipe() }
                    return try CredentialFill.decryptLogin(
                        row: row, storedKeysJSON: storedKeysJSON, accountMasterKey: accountMasterKey, pageHost: pageHost
                    )
                }
                DispatchQueue.main.async { self?.finish(outcome) }
            }
        }
    }

    private func finish(_ outcome: Result<LoginSecret, Error>) {
        switch outcome {
        case .success(let login):
            guard !answered else { return }
            answered = true
            extensionContext.completeRequest(
                withSelectedCredential: ASPasswordCredential(user: login.username, password: login.password),
                completionHandler: nil
            )
        case .failure(let error):
            fail(error)
        }
    }

    // MARK: - Failure handling (always cancel; never a fabricated credential)

    private func fail(_ error: Error) {
        let code = Self.extensionErrorCode(for: error)
        if code == .userCanceled || code == .credentialIdentityNotFound {
            cancel(code, Self.message(for: error))
            return
        }
        let message = Self.message(for: error)
        showMessage(message) { [weak self] in self?.cancel(code, message) }
    }

    static func extensionErrorCode(for error: Error) -> ASExtensionError.Code {
        switch error {
        case DeviceUnlockError.userCancel:
            return .userCanceled
        case FillError.itemNotFound, FillError.notALogin:
            return .credentialIdentityNotFound
        default:
            return .failed
        }
    }

    /// User-facing text. Never contains key material or item contents.
    static func message(for error: Error) -> String {
        switch error {
        case DeviceUnlockError.keyInvalidated:
            return "Biometric unlock was turned off, or Face ID / Touch ID changed. Open my-secrect, unlock with your passphrase and enable biometric unlock again."
        case DeviceUnlockError.notEnrolled, DeviceUnlockError.notAvailable:
            return "Face ID / Touch ID is not available on this device, so AutoFill cannot unlock my-secrect."
        case DeviceUnlockError.lockout:
            return "Face ID / Touch ID is locked. Unlock your device with its passcode, then try again."
        case DeviceUnlockError.userCancel:
            return "Cancelled."
        case let unlock as DeviceUnlockError:
            return "my-secrect could not unlock (\(unlock.rawValue))."
        case VaultDatabaseError.missing:
            return "my-secrect has not shared its vault with AutoFill yet. Open my-secrect and unlock it once. \(enableBiometricUnlock)"
        case FillError.domainMismatch:
            return "This login belongs to a different website. my-secrect did not fill it."
        case FillError.itemNotFound, FillError.notALogin:
            return "This login is no longer in my-secrect, or has no password."
        default:
            return "my-secrect could not fill this password (\(String(describing: error)))."
        }
    }

    private func cancel(_ code: ASExtensionError.Code, _ message: String? = nil) {
        guard !answered else { return }
        answered = true
        extensionContext.cancelRequest(withError: NSError(
            domain: ASExtensionErrorDomain,
            code: code.rawValue,
            userInfo: message.map { [NSLocalizedDescriptionKey: $0] }
        ))
    }

    // MARK: - Child view controllers

    private func showMessage(_ message: String, onClose: @escaping () -> Void) {
        show(MessageViewController(message: message, busy: false, onClose: onClose))
    }

    private func show(_ viewController: UIViewController) {
        for child in children {
            child.willMove(toParent: nil)
            child.view.removeFromSuperview()
            child.removeFromParent()
        }
        let nav = UINavigationController(rootViewController: viewController)
        addChild(nav)
        nav.view.frame = view.bounds
        nav.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(nav.view)
        nav.didMove(toParent: self)
    }
}

/// One row per matching login: title + username. No secrets are shown.
final class CredentialListViewController: UITableViewController {
    private let candidates: [AutoFillCandidate]
    private let pageHost: String?
    private let onSelect: (AutoFillCandidate) -> Void
    private let onCancel: () -> Void

    init(candidates: [AutoFillCandidate], pageHost: String?,
         onSelect: @escaping (AutoFillCandidate) -> Void, onCancel: @escaping () -> Void) {
        self.candidates = candidates
        self.pageHost = pageHost
        self.onSelect = onSelect
        self.onCancel = onCancel
        super.init(style: .insetGrouped)
        title = "my-secrect"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped))
    }

    @objc private func cancelTapped() {
        onCancel()
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        candidates.count
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        pageHost.map { "Logins for \($0)" }
    }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        guard candidates.isEmpty else { return "Face ID / Touch ID is required to fill." }
        return "No my-secrect logins match \(pageHost ?? "this website")."
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "login")
            ?? UITableViewCell(style: .subtitle, reuseIdentifier: "login")
        let candidate = candidates[indexPath.row]
        cell.textLabel?.text = candidate.entry.title
        let username = candidate.entry.username.isEmpty ? "(no username)" : candidate.entry.username
        cell.detailTextLabel?.text = candidate.confirmation == nil ? username : "\(username) · check website"
        cell.accessibilityIdentifier = "autofill-login-\(candidate.entry.id)"
        cell.accessoryType = .disclosureIndicator
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        onSelect(candidates[indexPath.row])
    }
}

/// A status or error message with a Close button.
final class MessageViewController: UIViewController {
    private let message: String
    private let busy: Bool
    private let onClose: () -> Void

    init(message: String, busy: Bool, onClose: @escaping () -> Void) {
        self.message = message
        self.busy = busy
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
        title = "my-secrect"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let label = UILabel()
        label.numberOfLines = 0
        label.text = message
        label.accessibilityIdentifier = "autofill-message"
        let stack = UIStackView(arrangedSubviews: [label])
        stack.axis = .vertical
        stack.spacing = 16
        if busy {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            stack.insertArrangedSubview(spinner, at: 0)
        }
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
        ])
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: busy ? .cancel : .close, target: self, action: #selector(closeTapped)
        )
    }

    @objc private func closeTapped() {
        onClose()
    }
}
