import ExpoModulesCore
import UIKit

#if canImport(MWDATCore)
import MWDATCore
#endif
#if canImport(MWDATCamera)
import MWDATCamera
#endif

/// GlassesModule — Expo native module wrapping Meta's Wearables DAT SDK (iOS).
public class GlassesModule: Module {
    private static let jpegQuality: CGFloat = 0.6
    private static let defaultFrameRate: UInt = 15

#if canImport(MWDATCore)
    private var registrationTask: Task<Void, Never>?
#endif
#if canImport(MWDATCamera)
    private var streamSession: StreamSession?
    private var stateListenerToken: AnyListenerToken?
    private var videoFrameListenerToken: AnyListenerToken?
    private var photoDataListenerToken: AnyListenerToken?
    private var errorListenerToken: AnyListenerToken?
#endif

    private var connectionState = "disconnected"
    private var streaming = false
    private var initialized = false

    private var sdkAvailable: Bool {
#if canImport(MWDATCore)
        return true
#else
        return false
#endif
    }

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
            return self.sdkAvailable
        }

        // ── Diagnostics ──

        Function("getDiagnostics") { () -> [String: Any] in
            var info: [String: Any] = [
                "sdkLinked": self.sdkAvailable,
                "initialized": self.initialized,
                "connectionState": self.connectionState,
                "streaming": self.streaming
            ]

            // Read MWDAT plist config
            if let mwdat = Bundle.main.object(forInfoDictionaryKey: "MWDAT") as? [String: Any] {
                info["mwdatConfig"] = mwdat
            } else {
                info["mwdatConfig"] = "MISSING — no MWDAT key in Info.plist"
            }

            // Check if Meta AI app is installed
            if let metaUrl = URL(string: "fb-viewapp://") {
                info["metaAIAppInstalled"] = UIApplication.shared.canOpenURL(metaUrl)
            }

            // Check URL scheme registration
            if let urlTypes = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] {
                let schemes = urlTypes.compactMap { ($0["CFBundleURLSchemes"] as? [String])?.first }
                info["registeredURLSchemes"] = schemes
            }

            info["bundleId"] = Bundle.main.bundleIdentifier ?? "unknown"

#if canImport(MWDATCore)
            info["registrationState"] = "\(Wearables.shared.registrationState)"
#endif

            return info
        }

        // ── Registration ──

        AsyncFunction("initialize") { () -> Bool in
#if canImport(MWDATCore)
            if self.initialized { return true }

            // Log MWDAT plist config for diagnostics
            if let mwdat = Bundle.main.object(forInfoDictionaryKey: "MWDAT") as? [String: Any] {
                print("[ExpoGlasses] MWDAT plist config: \(mwdat)")
            } else {
                print("[ExpoGlasses] WARNING: No MWDAT key found in Info.plist!")
            }
            print("[ExpoGlasses] Bundle ID: \(Bundle.main.bundleIdentifier ?? "nil")")

            do {
                try Wearables.configure()
                print("[ExpoGlasses] Wearables.configure() succeeded")

                // Log initial registration state
                let regState = Wearables.shared.registrationState
                print("[ExpoGlasses] Initial registration state: \(regState)")

                self.registrationTask?.cancel()
                self.registrationTask = Task { @MainActor [weak self] in
                    guard let self = self else { return }
                    for await state in Wearables.shared.registrationStateStream() {
                        let stateStr: String
                        switch state {
                        case .registered:
                            stateStr = "connected"
                        case .registering:
                            stateStr = "connecting"
                        case .available:
                            stateStr = "disconnected"
                        case .unavailable:
                            stateStr = "unavailable"
                        @unknown default:
                            stateStr = "unavailable"
                        }
                        print("[ExpoGlasses] Registration state changed: \(state) -> \(stateStr)")
                        self.connectionState = stateStr
                        self.sendEvent("onConnectionChanged", ["state": stateStr])
                    }
                }

                self.initialized = true
                self.connectionState = "disconnected"
                self.sendEvent("onConnectionChanged", ["state": self.connectionState])
                print("[ExpoGlasses] Initialized with Meta DAT SDK v0.4.0")
                return true
            } catch {
                print("[ExpoGlasses] Initialize failed: \(error)")
                print("[ExpoGlasses] Initialize error type: \(type(of: error))")
                self.sendEvent("onError", [
                    "code": "INIT_FAILED",
                    "message": "\(error)"
                ])
                return false
            }
#else
            print("[ExpoGlasses] SDK not available — MWDATCore not linked")
            self.sendEvent("onError", [
                "code": "SDK_NOT_LINKED",
                "message": "Meta DAT SDK is not linked in this build"
            ])
            return false
#endif
        }

        AsyncFunction("registerDevice") {
#if canImport(MWDATCore)
            guard self.initialized else {
                self.sendEvent("onError", [
                    "code": "NOT_INITIALIZED",
                    "message": "Call initialize() first"
                ])
                return
            }

            // Pre-flight check: is Meta AI app installed?
            let metaAppInstalled: Bool
            if let metaUrl = URL(string: "fb-viewapp://") {
                metaAppInstalled = await MainActor.run {
                    UIApplication.shared.canOpenURL(metaUrl)
                }
            } else {
                metaAppInstalled = false
            }
            print("[ExpoGlasses] Meta AI app installed: \(metaAppInstalled)")

            if !metaAppInstalled {
                self.sendEvent("onError", [
                    "code": "META_APP_MISSING",
                    "message": "Meta AI app is not installed. Install it from the App Store to connect glasses."
                ])
                self.sendEvent("onConnectionChanged", [
                    "state": "disconnected",
                    "error": "Meta AI app is not installed"
                ])
                return
            }

            // Log current state before attempting registration
            let regState = Wearables.shared.registrationState
            print("[ExpoGlasses] Current registration state before connect: \(regState)")

            self.connectionState = "connecting"
            self.sendEvent("onConnectionChanged", ["state": self.connectionState])

            do {
                try await Wearables.shared.startRegistration()
                print("[ExpoGlasses] startRegistration() succeeded")
            } catch let regError as RegistrationError {
                // Catch RegistrationError specifically — .description has the real error message
                let desc = regError.description
                print("[ExpoGlasses] RegistrationError: \(desc) (raw: \(regError))")
                self.connectionState = "disconnected"
                self.sendEvent("onConnectionChanged", [
                    "state": self.connectionState,
                    "error": desc
                ])
                self.sendEvent("onError", [
                    "code": "REGISTRATION_FAILED",
                    "message": desc
                ])
            } catch {
                // Fallback for unexpected error types
                let msg = "\(error)"
                print("[ExpoGlasses] Registration failed (unexpected): \(msg)")
                print("[ExpoGlasses] Error type: \(type(of: error))")
                self.connectionState = "disconnected"
                self.sendEvent("onConnectionChanged", [
                    "state": self.connectionState,
                    "error": msg
                ])
                self.sendEvent("onError", [
                    "code": "REGISTRATION_FAILED",
                    "message": msg
                ])
            }
#endif
        }

        AsyncFunction("unregisterDevice") {
#if canImport(MWDATCore)
            do {
                if self.streaming {
                    await self.stopStream()
                }
                try await Wearables.shared.startUnregistration()
                self.connectionState = "disconnected"
                self.sendEvent("onConnectionChanged", ["state": self.connectionState])
            } catch let unregError as UnregistrationError {
                let desc = unregError.description
                print("[ExpoGlasses] UnregistrationError: \(desc)")
                self.sendEvent("onError", [
                    "code": "UNREGISTER_FAILED",
                    "message": desc
                ])
            } catch {
                print("[ExpoGlasses] Unregistration failed: \(error)")
                self.sendEvent("onError", [
                    "code": "UNREGISTER_FAILED",
                    "message": "\(error)"
                ])
            }
#endif
        }

        Function("getConnectionState") { () -> String in
            return self.connectionState
        }

        // ── Video Streaming ──

        AsyncFunction("startVideoStream") { (options: [String: Any]) in
#if canImport(MWDATCamera)
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

            let qualityStr = options["quality"] as? String ?? "medium"
            let frameRate = options["frameRate"] as? UInt ?? GlassesModule.defaultFrameRate

            let resolution: StreamingResolution
            switch qualityStr {
            case "high": resolution = .high
            case "low": resolution = .low
            default: resolution = .medium
            }

            let config = StreamSessionConfig(
                videoCodec: .raw,
                resolution: resolution,
                frameRate: frameRate
            )

            let deviceSelector = AutoDeviceSelector(wearables: Wearables.shared)
            let session = await StreamSession(
                streamSessionConfig: config,
                deviceSelector: deviceSelector
            )
            self.streamSession = session

            // Subscribe to state changes
            self.stateListenerToken = await session.statePublisher.listen { [weak self] state in
                Task { @MainActor [weak self] in
                    guard let self = self else { return }
                    let stateStr: String
                    switch state {
                    case .stopped:
                        stateStr = "stopped"
                        self.streaming = false
                    case .waitingForDevice:
                        stateStr = "waiting"
                    case .starting:
                        stateStr = "starting"
                    case .streaming:
                        stateStr = "started"
                        self.streaming = true
                    case .paused:
                        stateStr = "paused"
                    case .stopping:
                        stateStr = "stopping"
                    @unknown default:
                        stateStr = "unknown"
                    }
                    self.sendEvent("onStreamStateChanged", ["state": stateStr])
                }
            }

            // Subscribe to video frames
            self.videoFrameListenerToken = await session.videoFramePublisher.listen { [weak self] frame in
                Task { @MainActor [weak self] in
                    guard let self = self else { return }
                    guard let image = frame.makeUIImage(),
                          let jpegData = image.jpegData(compressionQuality: GlassesModule.jpegQuality) else {
                        return
                    }
                    let base64 = jpegData.base64EncodedString()
                    self.sendEvent("onVideoFrame", [
                        "data": base64,
                        "width": Int(image.size.width),
                        "height": Int(image.size.height),
                        "timestamp": Int(Date().timeIntervalSince1970 * 1000)
                    ])
                }
            }

            // Subscribe to photo captures
            self.photoDataListenerToken = await session.photoDataPublisher.listen { [weak self] photoData in
                Task { @MainActor [weak self] in
                    guard let self = self else { return }
                    let base64 = photoData.data.base64EncodedString()
                    self.sendEvent("onPhotoCaptured", [
                        "data": base64,
                        "format": "jpeg"
                    ])
                }
            }

            // Subscribe to errors
            self.errorListenerToken = await session.errorPublisher.listen { [weak self] error in
                Task { @MainActor [weak self] in
                    self?.sendEvent("onError", [
                        "code": "STREAM_ERROR",
                        "message": "\(error)"
                    ])
                }
            }

            // Start the stream
            await session.start()
            print("[ExpoGlasses] Stream started: quality=\(qualityStr), frameRate=\(frameRate)")
#else
            self.sendEvent("onError", [
                "code": "SDK_NOT_LINKED",
                "message": "MWDATCamera not linked in this build"
            ])
#endif
        }

        AsyncFunction("stopVideoStream") {
            await self.stopStream()
        }

        AsyncFunction("capturePhoto") { () -> String? in
#if canImport(MWDATCamera)
            guard let session = self.streamSession, self.streaming else {
                self.sendEvent("onError", [
                    "code": "NO_STREAM",
                    "message": "Start a video stream before capturing photos"
                ])
                return nil
            }

            _ = await MainActor.run { session.capturePhoto(format: .jpeg) }
            print("[ExpoGlasses] Photo capture triggered")
#endif
            return nil
        }

        // ── Lifecycle ──

        OnAppEntersBackground {
            self.handleBackground()
        }
    }

    private func stopStream() async {
#if canImport(MWDATCamera)
        stateListenerToken = nil
        videoFrameListenerToken = nil
        photoDataListenerToken = nil
        errorListenerToken = nil
        await streamSession?.stop()
        streamSession = nil
#endif
        streaming = false
        sendEvent("onStreamStateChanged", ["state": "stopped"])
        print("[ExpoGlasses] Stream stopped")
    }

    private func handleBackground() {
        if streaming {
            Task {
                await self.stopStream()
            }
        }
    }

    deinit {
#if canImport(MWDATCore)
        registrationTask?.cancel()
#endif
#if canImport(MWDATCamera)
        stateListenerToken = nil
        videoFrameListenerToken = nil
        photoDataListenerToken = nil
        errorListenerToken = nil
#endif
        streaming = false
        initialized = false
    }
}
