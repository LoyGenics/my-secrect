/**
 * Expo config plugin: iOS AutoFill Credential Provider extension.
 *
 * On `npx expo prebuild --platform ios` it adds to the generated project
 * (apps/mobile/ios, not committed — specs/mobile-local-store.md §7):
 *   - app extension target `CredentialProvider`
 *     (`<app bundle id>.CredentialProvider`), compiling the Swift files in
 *     native/ios-credential-provider/{Sources/AutoFillCore,Extension} IN
 *     PLACE (no copies), with that folder's Info.plist and entitlements;
 *   - Swift packages linked by the extension only: swift-sodium (Clibsodium,
 *     static, XChaCha20-Poly1305) and SQLCipher.swift (SQLCipher 4, a
 *     dynamic framework) — same pins as native/ios-credential-provider/Package.swift;
 *   - in the app target: "Embed Foundation Extensions", a target dependency,
 *     and "Embed Frameworks (CredentialProvider)", which copies and signs the
 *     SQLCipher.framework the extension build put in BUILT_PRODUCTS_DIR into
 *     the APP's Frameworks/ (an app extension may not carry its own
 *     Frameworks/ folder; the extension's rpath has @executable_path/../../Frameworks).
 *     The app binary itself does not link SQLCipher;
 *   - the App Group and shared keychain access group on the APP target too
 *     (both sides of the contract need them), merged idempotently.
 *
 * Build-time setting (no default, no placeholder):
 *   MY_SECRECT_WEBCREDENTIALS_DOMAINS="example.org,login.example.org"
 *     adds `webcredentials:<domain>` Associated Domains to the APP target.
 *     Password AutoFill from this provider does not need it; see
 *     native/ios-credential-provider/README.md.
 *
 * Re-running prebuild on an existing ios/ folder is a no-op for the target.
 */
const fs = require('fs');
const path = require('path');
const { withEntitlementsPlist, withXcodeProject } = require('expo/config-plugins');

const TARGET = 'CredentialProvider';
const APP_GROUP = 'group.com.loygenics.my-secrect';
const KEYCHAIN_GROUP = '$(AppIdentifierPrefix)com.loygenics.my-secrect.shared';
const NATIVE_DIR = path.resolve(__dirname, '../../../native/ios-credential-provider');
const SOURCE_DIRS = ['Sources/AutoFillCore', 'Extension'];
// Keep in sync with native/ios-credential-provider/Package.swift.
const SWIFT_PACKAGES = [
  { name: 'swift-sodium', url: 'https://github.com/jedisct1/swift-sodium.git', version: '0.11.0', products: ['Clibsodium'] },
  { name: 'SQLCipher.swift', url: 'https://github.com/sqlcipher/SQLCipher.swift.git', version: '4.20.0', products: ['SQLCipher'], embed: true },
];

const q = (value) => JSON.stringify(String(value));
const unq = (value) => (typeof value === 'string' ? value.replace(/^"(.*)"$/, '$1') : value);

function addUnique(list, value) {
  const out = Array.isArray(list) ? [...list] : [];
  if (!out.includes(value)) out.push(value);
  return out;
}

function withSharedEntitlements(config) {
  return withEntitlementsPlist(config, (cfg) => {
    const e = cfg.modResults;
    e['com.apple.security.application-groups'] = addUnique(e['com.apple.security.application-groups'], APP_GROUP);
    e['keychain-access-groups'] = addUnique(e['keychain-access-groups'], KEYCHAIN_GROUP);
    const domains = (process.env.MY_SECRECT_WEBCREDENTIALS_DOMAINS || '')
      .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
    for (const domain of domains) {
      if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error(`MY_SECRECT_WEBCREDENTIALS_DOMAINS: invalid domain "${domain}"`);
      e['com.apple.developer.associated-domains'] = addUnique(e['com.apple.developer.associated-domains'], `webcredentials:${domain}`);
    }
    return cfg;
  });
}

function swiftSources() {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    for (const name of fs.readdirSync(path.join(NATIVE_DIR, dir)).sort()) {
      if (name.endsWith('.swift')) files.push(`${dir}/${name}`);
    }
  }
  if (files.length === 0) throw new Error(`with-ios-credential-provider: no Swift sources in ${NATIVE_DIR}`);
  return files;
}

function addExtensionTarget(project, { iosDir, bundleId, marketingVersion, buildNumber }) {
  const objects = project.hash.project.objects;
  const section = (isa) => (objects[isa] = objects[isa] || {});
  const entries = (isa) => Object.entries(section(isa)).filter(([k]) => !k.endsWith('_comment'));
  const add = (isa, fields, comment) => {
    const id = project.generateUuid();
    section(isa)[id] = { isa, ...fields };
    section(isa)[`${id}_comment`] = comment;
    return id;
  };

  if (entries('PBXNativeTarget').some(([, t]) => unq(t.name) === TARGET)) return;

  const projectId = project.hash.project.rootObject;
  const pbxProject = section('PBXProject')[projectId];
  const [, appTarget] = entries('PBXNativeTarget')
    .find(([, t]) => unq(t.productType) === 'com.apple.product-type.application');
  const appConfigs = section('XCConfigurationList')[appTarget.buildConfigurationList].buildConfigurations
    .map(({ value }) => section('XCBuildConfiguration')[value]);
  const appSettings = appConfigs[0].buildSettings;
  const rel = path.relative(iosDir, NATIVE_DIR).split(path.sep).join('/');

  // Swift Package references need objectVersion >= 52.
  if (Number(project.hash.project.objectVersion) < 54) project.hash.project.objectVersion = 54;

  // Files, shown in a group that points at native/ios-credential-provider.
  const groupChildren = [];
  const sourceBuildFiles = [];
  for (const file of swiftSources()) {
    const name = path.posix.basename(file);
    const ref = add('PBXFileReference', {
      lastKnownFileType: 'sourcecode.swift', name: q(name), path: q(file), sourceTree: q('<group>'),
    }, name);
    groupChildren.push({ value: ref, comment: name });
    sourceBuildFiles.push({ value: add('PBXBuildFile', { fileRef: ref, fileRef_comment: name }, `${name} in Sources`), comment: `${name} in Sources` });
  }
  for (const [file, type] of [['Extension/Info.plist', 'text.plist.xml'], ['Extension/CredentialProvider.entitlements', 'text.plist.entitlements']]) {
    const name = path.posix.basename(file);
    groupChildren.push({ value: add('PBXFileReference', { lastKnownFileType: type, name: q(name), path: q(file), sourceTree: q('<group>') }, name), comment: name });
  }
  const groupId = add('PBXGroup', { children: groupChildren, name: q(TARGET), path: q(rel), sourceTree: q('<group>') }, TARGET);
  section('PBXGroup')[pbxProject.mainGroup].children.push({ value: groupId, comment: TARGET });

  const productName = `${TARGET}.appex`;
  const productId = add('PBXFileReference', {
    explicitFileType: q('wrapper.app-extension'), includeInIndex: 0, path: q(productName), sourceTree: 'BUILT_PRODUCTS_DIR',
  }, productName);
  section('PBXGroup')[pbxProject.productRefGroup].children.push({ value: productId, comment: productName });

  // Swift packages (reused if the project already references the same URL).
  pbxProject.packageReferences = pbxProject.packageReferences || [];
  const productDeps = [];
  const frameworkBuildFiles = [];
  const embedFrameworkFiles = [];
  for (const pkg of SWIFT_PACKAGES) {
    const refComment = `XCRemoteSwiftPackageReference "${pkg.name}"`;
    let pkgRef = entries('XCRemoteSwiftPackageReference').find(([, r]) => unq(r.repositoryURL) === pkg.url)?.[0];
    if (!pkgRef) {
      pkgRef = add('XCRemoteSwiftPackageReference', {
        repositoryURL: q(pkg.url), requirement: { kind: 'exactVersion', version: q(pkg.version) },
      }, refComment);
      pbxProject.packageReferences.push({ value: pkgRef, comment: refComment });
    }
    for (const product of pkg.products) {
      const dep = add('XCSwiftPackageProductDependency', { package: pkgRef, package_comment: refComment, productName: q(product) }, product);
      productDeps.push({ value: dep, comment: product });
      frameworkBuildFiles.push({ value: add('PBXBuildFile', { productRef: dep, productRef_comment: product }, `${product} in Frameworks`), comment: `${product} in Frameworks` });
      if (pkg.embed) {
        const framework = `${product}.framework`;
        const ref = add('PBXFileReference', {
          explicitFileType: 'wrapper.framework', includeInIndex: 0, path: q(framework), sourceTree: 'BUILT_PRODUCTS_DIR',
        }, framework);
        groupChildren.push({ value: ref, comment: framework });
        const comment = `${framework} in Embed Frameworks (${TARGET})`;
        embedFrameworkFiles.push({ value: add('PBXBuildFile', {
          fileRef: ref, fileRef_comment: framework, settings: { ATTRIBUTES: ['CodeSignOnCopy', 'RemoveHeadersOnCopy'] },
        }, comment), comment });
      }
    }
  }

  const phase = (isa, comment, files) => ({
    value: add(isa, { buildActionMask: 2147483647, files, runOnlyForDeploymentPostprocessing: 0 }, comment), comment,
  });
  const buildPhases = [
    phase('PBXSourcesBuildPhase', 'Sources', sourceBuildFiles),
    phase('PBXFrameworksBuildPhase', 'Frameworks', frameworkBuildFiles),
    phase('PBXResourcesBuildPhase', 'Resources', []),
  ];

  const common = {
    APPLICATION_EXTENSION_API_ONLY: 'YES',
    CLANG_ENABLE_MODULES: 'YES',
    CODE_SIGN_ENTITLEMENTS: q(`${rel}/Extension/CredentialProvider.entitlements`),
    CODE_SIGN_STYLE: 'Automatic',
    CURRENT_PROJECT_VERSION: q(buildNumber),
    GENERATE_INFOPLIST_FILE: 'NO',
    INFOPLIST_FILE: q(`${rel}/Extension/Info.plist`),
    IPHONEOS_DEPLOYMENT_TARGET: appSettings.IPHONEOS_DEPLOYMENT_TARGET || '15.1',
    LD_RUNPATH_SEARCH_PATHS: q('$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks'),
    MARKETING_VERSION: q(marketingVersion),
    PRODUCT_BUNDLE_IDENTIFIER: q(bundleId),
    PRODUCT_NAME: q('$(TARGET_NAME)'),
    SKIP_INSTALL: 'YES',
    SWIFT_VERSION: '5.0',
    TARGETED_DEVICE_FAMILY: q('1,2'),
  };
  if (appSettings.DEVELOPMENT_TEAM) common.DEVELOPMENT_TEAM = appSettings.DEVELOPMENT_TEAM;
  const debugId = add('XCBuildConfiguration', {
    buildSettings: {
      ...common,
      DEBUG_INFORMATION_FORMAT: 'dwarf',
      SWIFT_ACTIVE_COMPILATION_CONDITIONS: q('$(inherited) DEBUG'),
      SWIFT_OPTIMIZATION_LEVEL: q('-Onone'),
    },
    name: 'Debug',
  }, 'Debug');
  const releaseId = add('XCBuildConfiguration', {
    buildSettings: {
      ...common,
      DEBUG_INFORMATION_FORMAT: q('dwarf-with-dsym'),
      SWIFT_COMPILATION_MODE: 'wholemodule',
      SWIFT_OPTIMIZATION_LEVEL: q('-O'),
    },
    name: 'Release',
  }, 'Release');
  const listComment = `Build configuration list for PBXNativeTarget "${TARGET}"`;
  const configListId = add('XCConfigurationList', {
    buildConfigurations: [{ value: debugId, comment: 'Debug' }, { value: releaseId, comment: 'Release' }],
    defaultConfigurationIsVisible: 0,
    defaultConfigurationName: 'Release',
  }, listComment);

  const targetId = add('PBXNativeTarget', {
    buildConfigurationList: configListId,
    buildConfigurationList_comment: listComment,
    buildPhases,
    buildRules: [],
    dependencies: [],
    name: q(TARGET),
    packageProductDependencies: productDeps,
    productName: q(TARGET),
    productReference: productId,
    productReference_comment: productName,
    productType: q('com.apple.product-type.app-extension'),
  }, TARGET);
  pbxProject.targets.push({ value: targetId, comment: TARGET });
  pbxProject.attributes.TargetAttributes = pbxProject.attributes.TargetAttributes || {};
  pbxProject.attributes.TargetAttributes[targetId] = { CreatedOnToolsVersion: '16.0' };

  // App target: build the extension first, then embed it in PlugIns/.
  const proxyId = add('PBXContainerItemProxy', {
    containerPortal: projectId, containerPortal_comment: 'Project object',
    proxyType: 1, remoteGlobalIDString: targetId, remoteInfo: q(TARGET),
  }, 'PBXContainerItemProxy');
  const dependencyId = add('PBXTargetDependency', {
    target: targetId, target_comment: TARGET, targetProxy: proxyId, targetProxy_comment: 'PBXContainerItemProxy',
  }, 'PBXTargetDependency');
  appTarget.dependencies = appTarget.dependencies || [];
  appTarget.dependencies.push({ value: dependencyId, comment: 'PBXTargetDependency' });
  const embedComment = `${productName} in Embed Foundation Extensions`;
  const embedFile = add('PBXBuildFile', {
    fileRef: productId, fileRef_comment: productName, settings: { ATTRIBUTES: ['RemoveHeadersOnCopy'] },
  }, embedComment);
  const embedPhase = add('PBXCopyFilesBuildPhase', {
    buildActionMask: 2147483647, dstPath: q(''), dstSubfolderSpec: 13,
    files: [{ value: embedFile, comment: embedComment }],
    name: q('Embed Foundation Extensions'), runOnlyForDeploymentPostprocessing: 0,
  }, 'Embed Foundation Extensions');
  appTarget.buildPhases.push({ value: embedPhase, comment: 'Embed Foundation Extensions' });
  const frameworksPhaseName = `Embed Frameworks (${TARGET})`;
  const frameworksPhase = add('PBXCopyFilesBuildPhase', {
    buildActionMask: 2147483647, dstPath: q(''), dstSubfolderSpec: 10,
    files: embedFrameworkFiles, name: q(frameworksPhaseName), runOnlyForDeploymentPostprocessing: 0,
  }, frameworksPhaseName);
  appTarget.buildPhases.push({ value: frameworksPhase, comment: frameworksPhaseName });
}

module.exports = function withIosCredentialProvider(config) {
  if (!config.ios?.bundleIdentifier) throw new Error('with-ios-credential-provider: expo.ios.bundleIdentifier is required');
  config = withSharedEntitlements(config);
  return withXcodeProject(config, (cfg) => {
    addExtensionTarget(cfg.modResults, {
      iosDir: cfg.modRequest.platformProjectRoot,
      bundleId: `${cfg.ios.bundleIdentifier}.${TARGET}`,
      marketingVersion: cfg.version || '1.0.0',
      buildNumber: cfg.ios.buildNumber || '1',
    });
    return cfg;
  });
};
