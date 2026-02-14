Pod::Spec.new do |s|
  s.name           = 'PcmPlayer'
  s.version        = '0.1.0'
  s.summary        = 'PCM audio playback and recording for Expo'
  s.description    = 'Native PCM audio module with 24kHz playback, 16kHz recording, and AEC'
  s.license        = 'MIT'
  s.author         = 'ozzu'
  s.homepage       = 'https://github.com/ozzuworld/ozzu'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ozzuworld/ozzu.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
