Pod::Spec.new do |s|
  s.name           = 'BleBeacon'
  s.version        = '0.1.0'
  s.summary        = 'BLE peripheral advertising for indoor positioning (iPhone only)'
  s.description    = 'CBPeripheralManager beacon — advertises a known service UUID so ESP32 nodes can detect iPhone'
  s.license        = 'MIT'
  s.author         = 'ozzu'
  s.homepage       = 'https://github.com/ozzuworld/ozzu'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ozzuworld/ozzu.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'CoreBluetooth'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
