Pod::Spec.new do |s|
  s.name           = 'DeviceKey'
  s.version        = '0.1.0'
  s.summary        = 'my-secrect device-protected keys: Local Storage Key and biometric Master Key wrap'
  s.description    = 'Implements specs/mobile-local-store.md sections 3-5 (Keychain, Secure Enclave, LocalAuthentication).'
  s.author         = 'my-secrect'
  s.homepage       = 'https://example.invalid/my-secrect'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'LocalAuthentication', 'Security', 'CryptoKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
