import Foundation
import linphonesw

// Round-1 bring-up (dir_1782918712595): proves linphone-sdk-novideo links and the
// linphonesw API compiles + the Core starts. Registration + call handling layer on top of
// this in later rounds. Deliberately SEPARATE from the still-live hand-rolled
// VoipCallModule / SipVoipSession so nothing that currently works breaks while we prove
// the integration archives in CI. Uses only the core, verified API surface:
// Factory.Instance.createCore -> core.callkitEnabled -> core.start().
@objc public class LinphoneManager: NSObject {
  @objc public static let shared = LinphoneManager()

  private var core: Core?

  // Create + start the liblinphone Core. Returns a status string. CallKit owns the audio
  // session, so we set callkitEnabled BEFORE start() and never touch AVAudioSession directly.
  @discardableResult
  @objc public func start() -> String {
    if core != nil { return "linphone already running" }
    do {
      let c = try Factory.Instance.createCore(configPath: "", factoryConfigPath: "", systemContext: nil)
      c.callkitEnabled = true
      try c.start()
      core = c
      NSLog("[Linphone] Core started")
      return "linphone started"
    } catch {
      NSLog("[Linphone] start failed: \(error.localizedDescription)")
      return "linphone start failed: \(error.localizedDescription)"
    }
  }
}
