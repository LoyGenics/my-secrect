# iOS Credential Provider Extension — PLANNED, not implemented

## Goal
System AutoFill in Safari and other apps: the vault offers logins /
passkeys for the current app/website, and fills only the credential
the user picks, after vault unlock.

## What is needed (native work, Xcode)
- App Group shared between the main app and the extension
  (`group.com.loygenics.my-secrect`) for the encrypted vault store.
- `ASCredentialProviderViewController` subclass (AuthenticationServices
  framework), `CredentialProvider` extension target with
  `NSExtensionPointIdentifier = com.apple.authentication-services.credential-provider`.
- Associated Domains entitlement (`webcredentials:`) for passkey /
  password AutoFill matching by domain — never fill on a mismatched
  or suspicious origin.
- The extension must NOT receive the whole vault or the decryption
  keys: it requests one decrypted credential at a time from the
  unlocked app context, or decrypts a single item with a key handed
  over only for that fill.
- Passkeys: `ASAuthorizationController` + `ASPasskeyCredentialRequest`
  for sign-in with a stored passkey; creation via
  `ASAuthorizationPlatformPublicKeyCredentialProvider`.

## Status
No extension target, no entitlements file, no Swift code exists yet
in this repo. The React Native UI in `src/` does not fake AutoFill —
there is no AutoFill button or flow in the app. This folder is the
spec + checklist for the native step.
