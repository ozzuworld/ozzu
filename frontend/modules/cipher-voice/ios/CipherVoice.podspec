Pod::Spec.new do |s|
  s.name           = 'CipherVoice'
  s.version        = '0.1.0'
  s.summary        = 'On-device STT/TTS for Cipher voice pipeline (iPhone only)'
  s.description    = 'SFSpeechRecognizer for STT and AVSpeechSynthesizer for TTS — A18 Pro Neural Engine'
  s.license        = 'MIT'
  s.author         = 'ozzu'
  s.homepage       = 'https://github.com/ozzuworld/ozzu'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ozzuworld/ozzu.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'Speech', 'AVFoundation'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
