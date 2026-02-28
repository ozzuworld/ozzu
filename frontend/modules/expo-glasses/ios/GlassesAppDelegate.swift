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
        // Log ALL incoming URLs to GlassesModule's in-app log buffer
        GlassesModule.log("[URL] received: \(url.absoluteString)")
        GlassesModule.log("[URL] scheme=\(url.scheme ?? "nil") host=\(url.host ?? "nil")")
        GlassesModule.log("[URL] query=\(url.query ?? "nil")")

#if canImport(MWDATCore)
        // Forward ALL URLs with our scheme to the SDK — let it decide what's relevant.
        // The SDK's handleUrl returns true if it recognized the URL.
        if url.scheme == "ozzu" || url.absoluteString.contains("metaWearablesAction") {
            GlassesModule.log("[URL] Forwarding to Wearables.shared.handleUrl()")
            Task { @MainActor in
                do {
                    let handled = try await Wearables.shared.handleUrl(url)
                    GlassesModule.log("[URL] handleUrl returned: \(handled)")
                } catch {
                    GlassesModule.log("[URL] handleUrl FAILED: \(error)")
                    GlassesModule.log("[URL] handleUrl error type: \(type(of: error))")
                }
            }
            return true
        } else {
            GlassesModule.log("[URL] Not for glasses — scheme='\(url.scheme ?? "nil")', skipping")
        }
#else
        GlassesModule.log("[URL] MWDATCore not linked — cannot handle URL")
#endif
        return false
    }
}
