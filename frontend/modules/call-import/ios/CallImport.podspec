Pod::Spec.new do |s|
  s.name           = 'CallImport'
  s.version        = '1.0.0'
  s.summary        = 'On-device OCR call log import from screenshots'
  s.homepage       = 'https://github.com/ozzuworld/ozzu'
  s.license        = 'MIT'
  s.author         = 'Cipher'
  s.platform       = :ios, '15.0'
  s.source         = { git: '' }
  s.source_files   = '*.swift'
  s.frameworks     = 'Vision'

  s.dependency 'ExpoModulesCore'
end
