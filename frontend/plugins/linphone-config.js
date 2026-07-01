// Expo config plugin — makes the linphone-sdk-novideo CocoaPod resolvable + buildable.
//
// Two things expo-build-properties can't do that liblinphone needs:
//  1. A TOP-LEVEL `source '<belledonne spec repo>'` line in the Podfile. linphone-sdk-novideo
//     is NOT on the CocoaPods CDN — it lives in Belledonne's private spec repo. (extraPods'
//     per-pod `source:` is the wrong thing; CocoaPods needs the global source directive.)
//  2. CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES=YES so the app archives against
//     the dynamic linphone framework module.
//
// The pod itself is declared as a dependency in modules/voip-call/ios/VoipCall.podspec.
// (dir_1782918712595)
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const SPEC_SOURCE = "https://gitlab.linphone.org/BC/public/podspec.git";
const CDN_SOURCE = "https://cdn.cocoapods.org/";
const NONMODULAR_FLAG = "CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES";

module.exports = function withLinphone(config) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      let podfile = fs.readFileSync(podfilePath, "utf8");

      // 1) prepend the spec-repo + CDN sources (idempotent)
      if (!podfile.includes(SPEC_SOURCE)) {
        podfile = `source '${SPEC_SOURCE}'\nsource '${CDN_SOURCE}'\n` + podfile;
      }

      // 2) inject the non-modular-includes build flag into the existing post_install block
      if (!podfile.includes(NONMODULAR_FLAG) && /post_install do \|installer\|/.test(podfile)) {
        const inject =
          `post_install do |installer|\n` +
          `    installer.pods_project.targets.each do |lt|\n` +
          `      lt.build_configurations.each do |bc|\n` +
          `        bc.build_settings['${NONMODULAR_FLAG}'] = 'YES'\n` +
          `      end\n` +
          `    end`;
        podfile = podfile.replace(/post_install do \|installer\|/, inject);
      }

      fs.writeFileSync(podfilePath, podfile);
      return cfg;
    },
  ]);
};
