import ExpoModulesCore
import UIKit
import os.log

#if canImport(MWDATCore)
import MWDATCore
#endif

private let delegateLog = OSLog(subsystem: "com.ozzu.glasses", category: "AppDelegate")

private func glassesLog(_ message: String) {
    NSLog("[ExpoGlasses] %@", message)
    os_log("[ExpoGlasses] %{public}@", log: delegateLog, type: .error, message)
}

/// Handles URL callbacks from the Meta AI app during device registration.
/// The Meta DAT SDK uses a URL scheme callback to complete OAuth registration.
public class GlassesAppDelegate: ExpoAppDelegateSubscriber {
    public func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        // Log ALL incoming URLs for debugging
        glassesLog("URL received: \(url.absoluteString)")
        glassesLog("URL scheme: \(url.scheme ?? "nil"), host: \(url.host ?? "nil")")
        glassesLog("URL query: \(url.query ?? "nil")")

#if canImport(MWDATCore)
        // Forward ALL URLs with our scheme to the SDK — let it decide what's relevant.
        // The SDK's handleUrl returns true if it recognized the URL.
        if url.scheme == "ozzu" || url.absoluteString.contains("metaWearablesAction") {
            glassesLog("Forwarding URL to Wearables.shared.handleUrl()")
            Task { @MainActor in
                do {
                    let handled = try await Wearables.shared.handleUrl(url)
                    glassesLog("handleUrl returned: \(handled)")
                } catch {
                    glassesLog("handleUrl FAILED: \(error)")
                    glassesLog("handleUrl error type: \(type(of: error))")
                }
            }
            return true
        } else {
            glassesLog("URL not for glasses — scheme is '\(url.scheme ?? "nil")', skipping")
        }
#else
        glassesLog("MWDATCore not linked — cannot handle URL")
#endif
        return false
    }
}
