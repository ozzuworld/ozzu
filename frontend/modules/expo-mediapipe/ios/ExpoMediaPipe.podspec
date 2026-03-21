Pod::Spec.new do |s|
  s.name           = 'ExpoMediaPipe'
  s.version        = '0.1.0'
  s.summary        = 'MediaPipe hand tracking for Expo'
  s.homepage       = 'https://github.com/ozzuworld/ozzu'
  s.license        = 'MIT'
  s.author         = 'ozzu'
  s.source         = { git: '' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.static_framework = true

  s.source_files   = '**/*.{h,m,swift}'
  s.resource_bundles = {
    'MediaPipeModels' => ['Resources/*.task']
  }

  s.dependency 'ExpoModulesCore'
  s.dependency 'MediaPipeTasksVision', '0.10.21'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
