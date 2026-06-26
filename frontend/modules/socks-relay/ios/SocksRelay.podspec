Pod::Spec.new do |s|
  s.name           = 'SocksRelay'
  s.version        = '1.0.0'
  s.summary        = 'SOCKS5 proxy relay for SOC engagements'
  s.homepage       = 'https://github.com/ozzuworld/ozzu'
  s.license        = 'MIT'
  s.author         = 'Cipher'
  s.platform       = :ios, '15.0'
  s.source         = { git: '' }
  s.source_files   = '*.swift'
  s.frameworks     = 'Network'

  s.dependency 'ExpoModulesCore'
end
