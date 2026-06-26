Pod::Spec.new do |s|
  s.name           = 'SipToolkit'
  s.version        = '1.0.0'
  s.summary        = 'SIP/VoIP red team toolkit for SOC engagements'
  s.homepage       = 'https://github.com/ozzuworld/ozzu'
  s.license        = 'MIT'
  s.author         = 'Cipher'
  s.platform       = :ios, '15.0'
  s.source         = { git: '' }
  s.source_files   = '*.swift'
  s.frameworks     = 'Network'

  s.dependency 'ExpoModulesCore'
end
