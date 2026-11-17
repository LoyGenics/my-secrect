import UIKit

/// Shown when the provider is switched on in Settings. Reports the real
/// state of the shared store and re-syncs the QuickType identities.
final class ConfigurationViewController: UIViewController {
    private let onDone: () -> Void
    private let statusLabel = UILabel()

    init(onDone: @escaping () -> Void) {
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
        title = "my-secrect AutoFill"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        statusLabel.numberOfLines = 0
        statusLabel.accessibilityIdentifier = "autofill-config-status"
        let stack = UIStackView(arrangedSubviews: [statusLabel])
        stack.axis = .vertical
        stack.spacing = 20
        stack.alignment = .leading
        #if DEBUG && targetEnvironment(simulator)
        stack.addArrangedSubview(DebugSimulatorSeed.button(target: self, action: #selector(seedTapped)))
        #endif
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
        ])
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(doneTapped))
        refresh()
    }

    private func refresh(prefix: String? = nil) {
        let status: String
        do {
            let db = try ProviderVault.open()
            let entries = try db.autofillEntries()
            CredentialIdentitySync.replaceAll(with: entries)
            let logins = entries.filter { $0.type == "login" }.count
            if try db.deviceUnlock() == nil {
                status = "\(logins) logins are indexed, but biometric unlock is off. Open my-secrect and enable biometric unlock to fill passwords."
            } else {
                status = "AutoFill is ready: \(logins) logins can be offered. Every fill asks for Face ID / Touch ID."
            }
        } catch {
            // Do not advertise suggestions the provider cannot fill.
            CredentialIdentitySync.removeAll()
            status = "my-secrect has not shared its vault with AutoFill yet. Open my-secrect, unlock it, and enable biometric unlock. (\(error))"
        }
        statusLabel.text = [prefix, status].compactMap { $0 }.joined(separator: "\n\n")
    }

    @objc private func doneTapped() {
        onDone()
    }

    #if DEBUG && targetEnvironment(simulator)
    @objc private func seedTapped() {
        do {
            refresh(prefix: try DebugSimulatorSeed.run())
        } catch {
            refresh(prefix: "Seed failed: \(error)")
        }
    }
    #endif
}
