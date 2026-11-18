Pod::Spec.new do |s|
  s.name            = 'ImportTransport'
  s.version         = '0.1.0'
  s.summary         = 'HTTPS transport for an explicitly authorized import preview'
  s.homepage        = 'https://my.msecret.app'
  s.author          = 'my-secrect'
  s.license         = { :type => 'UNLICENSED' }
  s.platforms       = { :ios => '15.1' }
  s.swift_version   = '5.9'
  s.source          = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
