// Expo config plugin — wires the (vendored) linphone-sdk-novideo pod into the Podfile.
//
// Belledonne's CocoaPods spec repo is on gitlab.linphone.org, whose IPs are unreachable
// from CI cloud runners ("No route to host"). Their DOWNLOAD server IS reachable, so instead
// of a spec-repo `source` we point CocoaPods at a LOCAL podspec
// (frontend/vendor/linphone-sdk-novideo.podspec) that pulls the prebuilt SDK straight from
// download.linphone.org. This plugin injects that `pod ... :podspec` line into the app target
// plus the non-modular-includes build flag the dynamic linphone frameworks need. The
// dependency itself is declared in modules/voip-call/ios/VoipCall.podspec. (dir_1782918712595)
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const POD_LINE = "pod 'linphone-sdk-novideo', :podspec => '../vendor/linphone-sdk-novideo.podspec'";
const NONMODULAR_FLAG = "CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES";

module.exports = function withLinphone(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      let podfile = fs.readFileSync(podfilePath, "utf8");

      // 1) point CocoaPods at the local podspec (reachable download server, not the git host).
      //    Inject inside the app target, right after use_expo_modules!.
      if (!podfile.includes("linphone-sdk-novideo")) {
        podfile = podfile.replace(/use_expo_modules!/, `use_expo_modules!\n  ${POD_LINE}`);
      }

      // 2) allow non-modular includes so the app archives against the dynamic linphone frameworks
      if (!podfile.includes(NONMODULAR_FLAG) && /post_install do \|installer\|/.test(podfile)) {
        const inject =
          "post_install do |installer|\n" +
          "    installer.pods_project.targets.each do |lt|\n" +
          "      lt.build_configurations.each do |bc|\n" +
          `        bc.build_settings['${NONMODULAR_FLAG}'] = 'YES'\n` +
          "      end\n" +
          "    end";
        podfile = podfile.replace(/post_install do \|installer\|/, inject);
      }

      fs.writeFileSync(podfilePath, podfile);
      return cfg;
    },
  ]);
};
