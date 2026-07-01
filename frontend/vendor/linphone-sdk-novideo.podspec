Pod::Spec.new do |s|
  s.name          = 'linphone-sdk-novideo'
  s.version       = '5.3.5'
  s.summary       = 'liblinphone audio-only SDK (vendored from the Belledonne download server)'
  s.description    = <<-DESC
    Local podspec for linphone-sdk-novideo. Belledonne's CocoaPods spec repo lives on
    gitlab.linphone.org, whose IPs are unreachable from CI cloud runners ("No route to
    host"). Their DOWNLOAD server (download.linphone.org) IS reachable, so we pull the
    prebuilt xcframeworks + the generated Swift wrapper straight from there and skip the
    git spec repo entirely. Wired into the Podfile by ./plugins/linphone-config.js.
    (dir_1782918712595)
  DESC
  s.homepage      = 'https://www.linphone.org'
  s.license       = { :type => 'GPLv3' }
  s.author        = 'Belledonne Communications'
  s.platform      = :ios, '15.1'

  # Prebuilt SDK archive (the reachable download server, not the blocked git host).
  s.source        = { :http => 'https://download.linphone.org/releases/ios/novideo/linphone-sdk-ios-5.3.5.zip' }

  # All the compiled xcframeworks (linphone core + belle-sip, bctoolbox, mediastreamer2,
  # ortp, belr, belcard, lime, codecs). Testers are excluded below.
  s.vendored_frameworks = 'linphone-sdk-novideo/apple-darwin/XCFrameworks/*.xcframework'
  s.exclude_files = 'linphone-sdk-novideo/apple-darwin/XCFrameworks/*tester*.xcframework'

  # The high-level Swift API — compiled as the `linphonesw` module we `import`.
  s.source_files  = 'linphone-sdk-novideo/apple-darwin/share/linphonesw/LinphoneWrapper.swift'
  s.module_name   = 'linphonesw'
  s.swift_version = '5.0'
end
