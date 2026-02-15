import ExpoModulesCore
import UIKit

// Meta DAT SDK imports (uncomment when SPM dependency is available):
// import MWDATCore
// import MWDATCamera

/// GlassesModule — Expo native module wrapping Meta's Wearables DAT SDK (iOS).
///
/// When the actual DAT SDK is available via SPM (MWDATCore + MWDATCamera),
/// uncomment the SDK imports and implementation blocks. The module currently
/// provides the full API surface with stub implementations so the JS layer
/// and Glasses screen can be built and tested without the SDK present.
public class GlassesModule: Module {
    private static let jpegQuality: CGFloat = 0.6
    private static let defaultFrameRate = 15

    // SDK objects (uncomment with real SDK):
    // private var streamSession: StreamSession?
    // private var registrationTask: Task<Void, Never>?
    // private var devicesTask: Task<Void, Never>?

    private var connectionState = "disconnected"
    private var streaming = false
    private var initialized = false

    public func definition() -> ModuleDefinition {
        Name("ExpoGlasses")

        Events(
            "onConnectionChanged",
            "onVideoFrame",
            "onPhotoCaptured",
            "onStreamStateChanged",
            "onError"
        )

        // ── Availability check ──

        Function("isAvailable") { () -> Bool in
            if #available(iOS 17.0, *) {
                return true
            }
            return false
        }

        // ── Registration ──

        AsyncFunction("initialize") { () -> Bool in
            if self.initialized { return true }

            guard #available(iOS 17.0, *) else {
                self.sendEvent("onError", [
                    "code": "UNSUPPORTED_DEVICE",
                    "message": "DAT SDK requires iOS 17+"
                ])
                return false
            }

            do {
                // TODO: Replace with actual SDK call when SPM dependency is available:
                // try Wearables.configure()
                //
                // // Collect registration state changes
                // self.registrationTask = Task {
                //     for await state in Wearables.shared.registrationStateStream() {
                //         let stateStr: String
                //         switch state {
                //         case .connected: stateStr = "connected"
                //         case .connecting: stateStr = "connecting"
                //         case .disconnected: stateStr = "disconnected"
                //         default: stateStr = "unavailable"
                //         }
                //         self.connectionState = stateStr
                //         self.sendEvent("onConnectionChanged", ["state": stateStr])
                //     }
                // }

                self.initialized = true
                self.connectionState = "disconnected"
                self.sendEvent("onConnectionChanged", ["state": self.connectionState])
                print("[ExpoGlasses] Initialized (stub mode — SDK not yet linked)")
                return true
            } catch {
                print("[ExpoGlasses] Initialize failed: \(error)")
                self.sendEvent("onError", [
                    "code": "INIT_FAILED",
                    "message": error.localizedDescription
                ])
                return false
            }
        }

        AsyncFunction("registerDevice") {
            guard self.initialized else {
                self.sendEvent("onError", [
                    "code": "NOT_INITIALIZED",
                    "message": "Call initialize() first"
                ])
                return
            }

            do {
                self.connectionState = "connecting"
                self.sendEvent("onConnectionChanged", ["state": self.connectionState])

                // TODO: Replace with actual SDK call:
                // try await Wearables.shared.startRegistration()

                print("[ExpoGlasses] registerDevice called (stub)")
            } catch {
                print("[ExpoGlasses] Registration failed: \(error)")
                self.connectionState = "disconnected"
                self.sendEvent("onConnectionChanged", [
                    "state": self.connectionState,
                    "error": error.localizedDescription
                ])
            }
        }

        AsyncFunction("unregisterDevice") {
            do {
                // TODO: Replace with actual SDK call:
                // try await Wearables.shared.startUnregistration()

                self.connectionState = "disconnected"
                self.sendEvent("onConnectionChanged", ["state": self.connectionState])
                print("[ExpoGlasses] unregisterDevice called (stub)")
            } catch {
                print("[ExpoGlasses] Unregistration failed: \(error)")
                self.sendEvent("onError", [
                    "code": "UNREGISTER_FAILED",
                    "message": error.localizedDescription
                ])
            }
        }

        Function("getConnectionState") { () -> String in
            return self.connectionState
        }

        // ── Video Streaming ──

        AsyncFunction("startVideoStream") { (options: [String: Any]) in
            guard self.initialized else {
                self.sendEvent("onError", [
                    "code": "NOT_INITIALIZED",
                    "message": "Call initialize() first"
                ])
                return
            }
            guard !self.streaming else {
                print("[ExpoGlasses] Stream already active")
                return
            }

            let quality = options["quality"] as? String ?? "medium"
            let frameRate = options["frameRate"] as? Int ?? GlassesModule.defaultFrameRate

            do {
                // TODO: Replace with actual SDK call:
                // let config = StreamSessionConfig(
                //     videoCodec: .h264,
                //     resolution: quality == "high" ? .high : quality == "low" ? .low : .medium,
                //     frameRate: min(max(frameRate, 2), 30)
                // )
                // self.streamSession = StreamSession(config: config)
                //
                // self.streamSession?.addVideoFrameListener { [weak self] frame in
                //     guard let self = self else { return }
                //     if let image = frame.image,
                //        let jpegData = image.jpegData(compressionQuality: GlassesModule.jpegQuality) {
                //         let base64 = jpegData.base64EncodedString()
                //         self.sendEvent("onVideoFrame", [
                //             "data": base64,
                //             "width": image.size.width,
                //             "height": image.size.height,
                //             "timestamp": frame.timestamp
                //         ])
                //     }
                // }
                //
                // self.streamSession?.addStateListener { [weak self] state in
                //     self?.sendEvent("onStreamStateChanged", ["state": "\(state)"])
                // }
                //
                // try await self.streamSession?.start()

                self.streaming = true
                self.sendEvent("onStreamStateChanged", ["state": "started"])
                print("[ExpoGlasses] startVideoStream: quality=\(quality), frameRate=\(frameRate) (stub)")
            } catch {
                print("[ExpoGlasses] startVideoStream failed: \(error)")
                self.sendEvent("onError", [
                    "code": "STREAM_FAILED",
                    "message": error.localizedDescription
                ])
            }
        }

        AsyncFunction("stopVideoStream") {
            do {
                // TODO: Replace with actual SDK call:
                // try await self.streamSession?.stop()
                // self.streamSession = nil

                self.streaming = false
                self.sendEvent("onStreamStateChanged", ["state": "stopped"])
                print("[ExpoGlasses] stopVideoStream (stub)")
            } catch {
                print("[ExpoGlasses] stopVideoStream failed: \(error)")
                self.sendEvent("onError", [
                    "code": "STOP_FAILED",
                    "message": error.localizedDescription
                ])
            }
        }

        AsyncFunction("capturePhoto") { () -> String? in
            guard self.streaming else {
                self.sendEvent("onError", [
                    "code": "NO_STREAM",
                    "message": "Start a video stream before capturing photos"
                ])
                return nil
            }

            do {
                // TODO: Replace with actual SDK call:
                // let photo = try await self.streamSession?.capturePhoto()
                // if let image = photo?.image,
                //    let jpegData = image.jpegData(compressionQuality: 0.85) {
                //     let base64 = jpegData.base64EncodedString()
                //     self.sendEvent("onPhotoCaptured", [
                //         "data": base64,
                //         "format": "jpeg"
                //     ])
                //     return base64
                // }

                print("[ExpoGlasses] capturePhoto (stub — no real photo)")
                self.sendEvent("onError", [
                    "code": "STUB_MODE",
                    "message": "Photo capture unavailable in stub mode"
                ])
                return nil
            } catch {
                print("[ExpoGlasses] capturePhoto failed: \(error)")
                self.sendEvent("onError", [
                    "code": "CAPTURE_FAILED",
                    "message": error.localizedDescription
                ])
                return nil
            }
        }

        // ── Lifecycle ──

        OnAppEntersBackground {
            self.handleBackground()
        }
    }

    private func handleBackground() {
        if streaming {
            // Stop streaming when app enters background to conserve resources
            streaming = false
            // streamSession?.stop()
            // streamSession = nil
            sendEvent("onStreamStateChanged", ["state": "stopped"])
        }
    }

    deinit {
        // registrationTask?.cancel()
        // devicesTask?.cancel()
        // streamSession?.stop()
        streaming = false
        initialized = false
    }
}
