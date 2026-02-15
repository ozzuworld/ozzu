Pod::Spec.new do |s|
  s.name           = 'ExpoGlasses'
  s.version        = '0.1.0'
  s.summary        = 'Meta Smart Glasses integration for Expo'
  s.license        = 'MIT'
  s.author         = 'ozzu'
  s.homepage       = 'https://github.com/ozzuworld/ozzu'
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ozzuworld/ozzu.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,swift}'
end
