import ExpoModulesCore
import UIKit
import AVFoundation
import os.log

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
    private static let maxLogEntries = 100
    private static let osLog = OSLog(subsystem: "com.ozzu.glasses", category: "SDK")

    /// In-app ring buffer for debug logs (NSLog doesn't appear in idevicesyslog on iOS 17+)
    private static var logBuffer: [(timestamp: String, message: String)] = []

    static func log(_ message: String) {
        let ts = ISO8601DateFormatter().string(from: Date())
        logBuffer.append((timestamp: ts, message: message))
        if logBuffer.count > maxLogEntries {
            logBuffer.removeFirst(logBuffer.count - maxLogEntries)
        }
        NSLog("[ExpoGlasses] %@", message)
        os_log("[ExpoGlasses] %{public}@", log: osLog, type: .error, message)
    }

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
    private var immersiveMode = false

    // TTS feedback via glasses Bluetooth speakers
    private var feedbackSynth: AVSpeechSynthesizer?
    private var feedbackDelegate: FeedbackTTSDelegate?

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
            "onError",
            "onFeedbackDone"
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

            // Include recent log entries
            info["logCount"] = GlassesModule.logBuffer.count
            info["recentLogs"] = GlassesModule.logBuffer.suffix(20).map { "\($0.timestamp) \($0.message)" }

            return info
        }

        Function("getLogs") { () -> [[String: String]] in
            return GlassesModule.logBuffer.map { ["ts": $0.timestamp, "msg": $0.message] }
        }

        // ── Registration ──

        AsyncFunction("initialize") { () -> Bool in
#if canImport(MWDATCore)
            if self.initialized { return true }

            // Log MWDAT plist config for diagnostics
            if let mwdat = Bundle.main.object(forInfoDictionaryKey: "MWDAT") as? [String: Any] {
                GlassesModule.log("MWDAT plist config: \(mwdat)")
            } else {
                GlassesModule.log("WARNING: No MWDAT key found in Info.plist!")
            }
            GlassesModule.log("Bundle ID: \(Bundle.main.bundleIdentifier ?? "nil")")

            do {
                try Wearables.configure()
                GlassesModule.log("Wearables.configure() succeeded")

                // Log initial registration state
                let regState = Wearables.shared.registrationState
                GlassesModule.log("Initial registration state: \(regState)")

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
                        GlassesModule.log("Registration state changed: \(state) -> \(stateStr)")
                        self.connectionState = stateStr
                        self.sendEvent("onConnectionChanged", ["state": stateStr])
                    }
                }

                self.initialized = true
                self.connectionState = "disconnected"
                self.sendEvent("onConnectionChanged", ["state": self.connectionState])
                GlassesModule.log("Initialized with Meta DAT SDK v0.4.0")
                return true
            } catch {
                GlassesModule.log("Initialize failed: \(error)")
                GlassesModule.log("Initialize error type: \(type(of: error))")
                self.sendEvent("onError", [
                    "code": "INIT_FAILED",
                    "message": "\(error)"
                ])
                return false
            }
#else
            GlassesModule.log("SDK not available — MWDATCore not linked")
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
            GlassesModule.log("Meta AI app installed: \(metaAppInstalled)")

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
            GlassesModule.log("Current registration state before connect: \(regState)")

            self.connectionState = "connecting"
            self.sendEvent("onConnectionChanged", ["state": self.connectionState])

            do {
                // If already registered, unregister first then re-register
                let currentState = Wearables.shared.registrationState
                if case .registered = currentState {
                    GlassesModule.log("Already registered — unregistering first")
                    try await Wearables.shared.startUnregistration()
                    GlassesModule.log("Unregistration succeeded, now re-registering")
                }

                try await Wearables.shared.startRegistration()
                GlassesModule.log("startRegistration() succeeded")
            } catch let regError as RegistrationError {
                let desc = regError.description
                // Auto-retry: if "already registered", unregister and try once more
                if desc.lowercased().contains("already registered") {
                    GlassesModule.log("RegistrationError: already registered — auto-retrying")
                    do {
                        try await Wearables.shared.startUnregistration()
                        GlassesModule.log("Unregistration succeeded, retrying registration")
                        try await Wearables.shared.startRegistration()
                        GlassesModule.log("Re-registration succeeded after unregister")
                        return
                    } catch {
                        let retryMsg = "\(error)"
                        GlassesModule.log("Re-registration failed: \(retryMsg)")
                        self.connectionState = "disconnected"
                        self.sendEvent("onConnectionChanged", [
                            "state": self.connectionState,
                            "error": retryMsg
                        ])
                        self.sendEvent("onError", [
                            "code": "REGISTRATION_FAILED",
                            "message": retryMsg
                        ])
                        return
                    }
                }
                GlassesModule.log("RegistrationError: \(desc) (raw: \(regError))")
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
                GlassesModule.log("Registration failed (unexpected): \(msg)")
                GlassesModule.log("Error type: \(type(of: error))")
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
                GlassesModule.log("UnregistrationError: \(desc)")
                self.sendEvent("onError", [
                    "code": "UNREGISTER_FAILED",
                    "message": desc
                ])
            } catch {
                GlassesModule.log("Unregistration failed: \(error)")
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
                GlassesModule.log("Stream already active")
                return
            }

            // Request camera permission from the Meta DAT SDK before streaming.
            // This is separate from iOS camera permissions — it's the SDK's own
            // permission system that requires user approval in Meta AI.
            do {
                let currentStatus = try await Wearables.shared.checkPermissionStatus(.camera)
                GlassesModule.log("Camera permission status: \(currentStatus)")
                if currentStatus != .granted {
                    GlassesModule.log("Requesting camera permission...")
                    let requestedStatus = try await Wearables.shared.requestPermission(.camera)
                    GlassesModule.log("Camera permission after request: \(requestedStatus)")
                    if requestedStatus != .granted {
                        GlassesModule.log("Camera permission denied")
                        self.sendEvent("onError", [
                            "code": "PERMISSION_DENIED",
                            "message": "Camera permission denied. Grant permission in Meta AI settings."
                        ])
                        return
                    }
                }
                GlassesModule.log("Camera permission granted — starting stream")
            } catch {
                GlassesModule.log("Permission check/request failed: \(error)")
                self.sendEvent("onError", [
                    "code": "PERMISSION_ERROR",
                    "message": "Failed to check/request camera permission: \(error)"
                ])
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
            GlassesModule.log("Stream started: quality=\(qualityStr), frameRate=\(frameRate)")
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
            GlassesModule.log("Photo capture triggered")
#endif
            return nil
        }

        // ── Audio Feedback (TTS via Bluetooth glasses speakers) ──

        AsyncFunction("speakFeedback") { (text: String) in
            // Only speak if Bluetooth audio output is available (glasses connected).
            // This prevents the phone speaker from blasting in the user's pocket.
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(.playback, options: [.allowBluetoothA2DP])
                try session.setActive(true)
            } catch {
                GlassesModule.log("Audio session setup failed: \(error)")
                return
            }

            let hasBluetooth = session.currentRoute.outputs.contains { port in
                port.portType == .bluetoothA2DP || port.portType == .bluetoothHFP || port.portType == .bluetoothLE
            }
            guard hasBluetooth else {
                GlassesModule.log("No Bluetooth audio output — skipping TTS to avoid phone speaker")
                return
            }

            // Cancel any in-progress speech
            self.feedbackSynth?.stopSpeaking(at: .immediate)

            let synth = AVSpeechSynthesizer()
            let delegate = FeedbackTTSDelegate { [weak self] in
                self?.sendEvent("onFeedbackDone", [:])
            }
            synth.delegate = delegate
            self.feedbackSynth = synth
            self.feedbackDelegate = delegate

            let utterance = AVSpeechUtterance(string: text)
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.2
            utterance.volume = 0.8
            synth.speak(utterance)
            GlassesModule.log("TTS: \(text)")
        }

        Function("stopFeedback") {
            self.feedbackSynth?.stopSpeaking(at: .immediate)
            self.feedbackSynth = nil
            self.feedbackDelegate = nil
        }

        // ── Immersive Mode ──

        Function("setImmersiveMode") { (enabled: Bool) in
            self.immersiveMode = enabled
            GlassesModule.log("Immersive mode: \(enabled)")
        }

        Function("getImmersiveMode") { () -> Bool in
            return self.immersiveMode
        }

        // ── Lifecycle ──

        OnAppEntersForeground {
            // Re-check registration state when returning from Meta AI app
            // The URL callback might have been processed while we were in background
#if canImport(MWDATCore)
            if self.initialized {
                let currentState = Wearables.shared.registrationState
                GlassesModule.log("App foregrounded — current registration state: \(currentState)")
                let stateStr: String
                switch currentState {
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
                if stateStr != self.connectionState {
                    GlassesModule.log("State changed while backgrounded: \(self.connectionState) -> \(stateStr)")
                    self.connectionState = stateStr
                    self.sendEvent("onConnectionChanged", ["state": stateStr])
                }
                if self.immersiveMode {
                    GlassesModule.log("Foregrounded in immersive mode — stream should auto-resume")
                }
            }
#endif
        }

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
        GlassesModule.log("Stream stopped")
    }

    private func handleBackground() {
        if streaming {
            if immersiveMode {
                // In immersive mode, let the SDK handle .paused state naturally.
                // The Bluetooth connection stays alive and auto-resumes on foreground.
                GlassesModule.log("Background with immersive mode — keeping stream alive")
            } else {
                Task {
                    await self.stopStream()
                }
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
        feedbackSynth?.stopSpeaking(at: .immediate)
        feedbackSynth = nil
        feedbackDelegate = nil
        streaming = false
        initialized = false
        immersiveMode = false
    }
}

/// Delegate that fires a completion callback when TTS finishes
private class FeedbackTTSDelegate: NSObject, AVSpeechSynthesizerDelegate {
    private let onDone: () -> Void

    init(onDone: @escaping () -> Void) {
        self.onDone = onDone
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onDone()
    }
}
