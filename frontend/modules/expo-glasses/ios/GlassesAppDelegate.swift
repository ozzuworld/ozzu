import ExpoModulesCore
import UIKit

#if canImport(MWDATCore)
import MWDATCore
#endif

/// Handles URL callbacks from the Meta AI app during device registration.
/// The Meta DAT SDK uses a URL scheme callback to complete OAuth registration.
public class GlassesAppDelegate: ExpoAppDelegateSubscriber {
    public func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        // Log ALL incoming URLs for debugging
        NSLog("[ExpoGlasses] URL received: \(url.absoluteString)")
        NSLog("[ExpoGlasses] URL scheme: \(url.scheme ?? "nil"), host: \(url.host ?? "nil")")
        NSLog("[ExpoGlasses] URL query: \(url.query ?? "nil")")

#if canImport(MWDATCore)
        // Forward ALL URLs with our scheme to the SDK — let it decide what's relevant.
        // The SDK's handleUrl returns true if it recognized the URL.
        if url.scheme == "ozzu" || url.absoluteString.contains("metaWearablesAction") {
            NSLog("[ExpoGlasses] Forwarding URL to Wearables.shared.handleUrl()")
            Task { @MainActor in
                do {
                    let handled = try await Wearables.shared.handleUrl(url)
                    NSLog("[ExpoGlasses] handleUrl returned: \(handled)")
                } catch {
                    NSLog("[ExpoGlasses] handleUrl FAILED: \(error)")
                    NSLog("[ExpoGlasses] handleUrl error type: \(type(of: error))")
                }
            }
            return true
        } else {
            NSLog("[ExpoGlasses] URL not for glasses — scheme is '\(url.scheme ?? "nil")', skipping")
        }
#else
        NSLog("[ExpoGlasses] MWDATCore not linked — cannot handle URL")
#endif
        return false
    }
}
