Pod::Spec.new do |s|
  s.name           = 'VoipCall'
  s.version        = '1.0.0'
  s.summary        = 'CallKit + SIP VoIP for Ozzu'
  s.description    = 'Native CallKit integration with SIP audio bridge to Asterisk'
  s.homepage       = 'https://ozzu.world'
  s.license        = 'MIT'
  s.author         = 'Ozzu'
  s.platform       = :ios, '13.0'
  s.source         = { :git => '' }
  s.source_files   = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'CallKit', 'AVFoundation', 'PushKit', 'Network'
end
