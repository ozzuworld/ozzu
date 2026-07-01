Pod::Spec.new do |s|
  s.name           = 'VoipCall'
  s.version        = '1.0.0'
  s.summary        = 'CallKit + SIP VoIP for Ozzu'
  s.description    = 'Native CallKit integration with SIP audio bridge to Asterisk'
  s.homepage       = 'https://ozzu.world'
  s.license        = 'MIT'
  s.author         = 'Ozzu'
  s.platform       = :ios, '15.1'
  s.source         = { :git => '' }
  s.source_files   = '**/*.swift'
  s.dependency 'ExpoModulesCore'
  # liblinphone (audio-only SIP stack). Resolvable via the Belledonne spec-repo source
  # line injected by the ./plugins/linphone-config config plugin. (dir_1782918712595)
  s.dependency 'linphone-sdk-novideo'
  s.frameworks     = 'CallKit', 'AVFoundation', 'PushKit', 'Network'
end
