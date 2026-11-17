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
const { withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

const APP_GROUP = 'group.com.loygenics.my-secrect';
const KEYCHAIN_ACCESS_GROUP = '$(AppIdentifierPrefix)com.loygenics.my-secrect.shared';

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
  return config;
};
