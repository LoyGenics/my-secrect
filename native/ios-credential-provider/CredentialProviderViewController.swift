import AuthenticationServices
import UIKit

/// Credential Provider extension view controller (AutoFill in Safari/apps).
///
/// Status (Phase F, 17 Nov 2026): SKELETON — NOT WORKING. There is no Xcode
/// extension target, no App Group wiring, and no unlock handoff yet, so this
/// code has never run. What is real: the class shape, the system callbacks,
/// the domain-matched identity list (via `VaultStore` + `DomainMatching`),
/// and the picker UI. What is not: `VaultStore.credential(for:)` — the
/// actual decryption — which calls `fatalError("not implemented")` on
/// purpose. It must never be "fixed" by returning a fake credential or by
/// writing plaintext to the Keychain. See README.md for what remains.
///
/// Security rules enforced here (same as the extension, `domain.ts`):
/// - Only identities whose host matches the requested domain are offered.
/// - Only ONE credential is ever returned, and only after the user picks it
///   (or the system requests it without interaction for a previously
///   approved identity).
/// - The extension never receives the whole vault or any key.
final class CredentialProviderViewController: ASCredentialProviderViewController {

    // MARK: - Credential list (user picks from the system AutoFill sheet)

    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        let identities: [ASPasswordCredentialIdentity]
        do {
            identities = try VaultStore.shared.loginIdentities(matching: serviceIdentifiers)
        } catch {
            // No shared store yet (the main app has not written the metadata
            // index) — fail closed with a clear error, never an empty list
            // presented as "no logins saved".
            extensionContext.cancelRequest(withError: NSError(
                domain: "com.loygenics.my-secrect.credential-provider",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "my-secrect vault is not shared with AutoFill yet: \(error.localizedDescription)"]
            ))
            return
        }
        let listVC = CredentialListViewController(identities: identities) { [weak self] identity in
            self?.provideCredential(for: identity)
        }
        embed(listVC)
    }

    // MARK: - Provide one credential

    /// Called when the user picks an identity in our list UI.
    override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
        provideCredential(for: credentialIdentity)
    }

    /// Called by the system for quick fill without UI (previously approved).
    override func provideCredentialWithoutUserInteraction(for credentialIdentity: ASPasswordCredentialIdentity) {
        provideCredential(for: credentialIdentity)
    }

    private func provideCredential(for identity: ASPasswordCredentialIdentity) {
        // NOT IMPLEMENTED: decrypts nothing yet — VaultStore.credential
        // calls fatalError("not implemented") until the unlock handoff
        // from the main app exists. Deliberate: a silent failure here
        // would look like "wrong password"; a crash log says exactly what
        // is missing.
        let credential = VaultStore.shared.credential(for: identity)
        extensionContext.completeRequest(withSelectedCredential: credential, completionHandler: nil)
    }

    // MARK: - Extension configuration (Settings → Passwords → AutoFill)

    override func prepareInterfaceForExtensionConfiguration() {
        let configVC = CredentialProviderConfigViewController { [weak self] in
            self?.extensionContext.completeExtensionConfigurationRequest()
        }
        embed(configVC)
    }

    // MARK: - Helpers

    private func embed(_ viewController: UIViewController) {
        let nav = UINavigationController(rootViewController: viewController)
        addChild(nav)
        nav.view.frame = view.bounds
        nav.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(nav.view)
        nav.didMove(toParent: self)
    }
}

/// Minimal picker: one row per matching login (username + domain).
/// Tapping a row returns that ONE identity to the system. No passwords
/// are shown here — only the usernames from the metadata index.
final class CredentialListViewController: UITableViewController {
    private let identities: [ASPasswordCredentialIdentity]
    private let onSelect: (ASPasswordCredentialIdentity) -> Void

    init(identities: [ASPasswordCredentialIdentity], onSelect: @escaping (ASPasswordCredentialIdentity) -> Void) {
        self.identities = identities
        self.onSelect = onSelect
        super.init(style: .plain)
        title = "my-secrect"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        identities.count
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "credential")
            ?? UITableViewCell(style: .subtitle, reuseIdentifier: "credential")
        let identity = identities[indexPath.row]
        cell.textLabel?.text = identity.user
        cell.detailTextLabel?.text = identity.serviceIdentifier.identifier
        cell.accessoryType = .disclosureIndicator
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        onSelect(identities[indexPath.row])
    }
}

/// Configuration screen shown from Settings. Explains the state honestly:
/// the provider is a skeleton until the main app shares its store.
final class CredentialProviderConfigViewController: UIViewController {
    private let onDone: () -> Void

    init(onDone: @escaping () -> Void) {
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
        title = "my-secrect AutoFill"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let label = UILabel()
        label.numberOfLines = 0
        label.text = "my-secrect AutoFill is not set up yet. The vault store has not been shared with this extension — the main app must unlock once and share its encrypted store first. See native/ios-credential-provider/README.md."
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            label.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
        ])
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done, target: self, action: #selector(doneTapped)
        )
    }

    @objc private func doneTapped() {
        onDone()
    }
}
