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
    private var listenerTokens: [AnyListenerToken] = []
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

        // ── Registration ──

        AsyncFunction("initialize") { () -> Bool in
#if canImport(MWDATCore)
            if self.initialized { return true }

            do {
                try Wearables.configure()

                // Listen for registration state changes via AsyncStream
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
                self.sendEvent("onError", [
                    "code": "INIT_FAILED",
                    "message": error.localizedDescription
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

            do {
                self.connectionState = "connecting"
                self.sendEvent("onConnectionChanged", ["state": self.connectionState])

                try await Wearables.shared.startRegistration()
            } catch {
                print("[ExpoGlasses] Registration failed: \(error)")
                self.connectionState = "disconnected"
                self.sendEvent("onConnectionChanged", [
                    "state": self.connectionState,
                    "error": error.localizedDescription
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
            } catch {
                print("[ExpoGlasses] Unregistration failed: \(error)")
                self.sendEvent("onError", [
                    "code": "UNREGISTER_FAILED",
                    "message": error.localizedDescription
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
            let session = StreamSession(
                streamSessionConfig: config,
                deviceSelector: deviceSelector
            )
            self.streamSession = session

            // Listen for state changes
            self.listenerTokens.append(
                await session.statePublisher.listen { [weak self] state in
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
            )

            // Listen for video frames
            self.listenerTokens.append(
                await session.videoFramePublisher.listen { [weak self] frame in
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
            )

            // Listen for photo captures
            self.listenerTokens.append(
                await session.photoDataPublisher.listen { [weak self] photo in
                    guard let self = self else { return }
                    let base64 = photo.data.base64EncodedString()
                    self.sendEvent("onPhotoCaptured", [
                        "data": base64,
                        "format": "jpeg"
                    ])
                }
            )

            // Listen for errors
            self.listenerTokens.append(
                await session.errorPublisher.listen { [weak self] error in
                    self?.sendEvent("onError", [
                        "code": "STREAM_ERROR",
                        "message": "\(error)"
                    ])
                }
            )

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

            await session.capturePhoto(format: .jpeg)
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
        listenerTokens.removeAll()
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
        listenerTokens.removeAll()
#endif
        streaming = false
        initialized = false
    }
}
