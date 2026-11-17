/**
 * Main-app native config for specs/mobile-local-store.md (vault.db + DeviceKey).
 *
 * iOS: App Group (vault.db lives in its container, §1) and the shared
 * keychain access group (LSK + device-unlock key, §3/§4), both also used by
 * the Credential Provider extension. The expanded access group is copied
 * into Info.plist so DeviceKeyModule.swift can pass it to the keychain.
 * SQLCipher itself comes from the expo-sqlite plugin (`useSQLCipher`).
 * Android needs nothing here: SQLCipher via expo-sqlite, biometric deps and
 * USE_BIOMETRIC via modules/device-key.
 */
const { withEntitlementsPlist, withInfoPlist, withPodfile } = require('expo/config-plugins');

const APP_GROUP = 'group.com.loygenics.my-secrect';
const KEYCHAIN_ACCESS_GROUP = '$(AppIdentifierPrefix)com.loygenics.my-secrect.shared';

// Toolchain workaround, not storage: fmt 11 (pulled in by react-native
// 0.76.9) fails to compile as C++20 with Xcode 26's clang ("call to
// consteval function ... is not a constant expression"). Build only the fmt
// pod as C++17, where fmt does not use consteval.
const FMT_MARKER = '# with-mobile-storage: fmt as C++17';
const FMT_PATCH = `
    ${FMT_MARKER}
    installer.pods_project.targets.each do |t|
      next unless t.name == 'fmt'
      t.build_configurations.each { |c| c.build_settings['CLANG_CXX_LANGUAGE_STANDARD'] = 'c++17' }
    end
`;

function addUnique(target, key, value) {
  const list = Array.isArray(target[key]) ? target[key] : [];
  if (!list.includes(value)) list.push(value);
  target[key] = list;
}

module.exports = function withMobileStorage(config) {
  config = withEntitlementsPlist(config, (c) => {
    addUnique(c.modResults, 'com.apple.security.application-groups', APP_GROUP);
    addUnique(c.modResults, 'keychain-access-groups', KEYCHAIN_ACCESS_GROUP);
    return c;
  });
  config = withInfoPlist(config, (c) => {
    c.modResults.MySecrectKeychainAccessGroup = KEYCHAIN_ACCESS_GROUP;
    return c;
  });
  config = withPodfile(config, (c) => {
    const src = c.modResults.contents;
    if (src.includes(FMT_MARKER)) return c;
    // After react_native_post_install(...), which sets every pod to C++20.
    const call = src.indexOf('react_native_post_install(');
    const close = call < 0 ? -1 : src.indexOf('\n    )\n', call);
    if (close < 0) throw new Error('with-mobile-storage: Podfile has no react_native_post_install(...) call');
    const at = close + '\n    )\n'.length;
    c.modResults.contents = src.slice(0, at) + FMT_PATCH + src.slice(at);
    return c;
  });
  return config;
};
