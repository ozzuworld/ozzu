import ExpoModulesCore
import UIKit

// Meta DAT SDK imports (uncomment when SPM dependency is available):
// import MWDATCore

/// Handles URL callbacks from the Meta AI app during device registration.
/// The Meta DAT SDK uses a URL scheme callback to complete OAuth registration.
public class GlassesAppDelegate: ExpoAppDelegateSubscriber {
    public func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        // Check if this URL is a Meta Wearables callback
        if url.absoluteString.contains("metaWearablesAction") ||
           url.scheme == "ozzu" {
            // TODO: Uncomment when SDK is available:
            // Task {
            //     _ = try? await Wearables.shared.handleUrl(url)
            // }
            print("[ExpoGlasses] Handled URL callback: \(url.scheme ?? "unknown")")
            return true
        }
        return false
    }
}
