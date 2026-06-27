import ExpoModulesCore
import CallKit
import AVFoundation
import PushKit

public class VoipCallModule: Module {
    private var provider: CXProvider?
    private var callController: CXCallController?
    private var voipRegistry: PKPushRegistry?
    private var sipSession: SipVoipSession?
    private var activeCalls: [UUID: CallInfo] = [:]
    private var sipConfig: SipConfig?
    private var bridgeWs: URLSessionWebSocketTask?
    private var wsReconnectTimer: Timer?
    private var sipRegistered = false

    struct CallInfo {
        let uuid: UUID
        let callerNumber: String
        let callerName: String
        var answered: Bool = false
    }

    struct SipConfig {
        let server: String
        let port: Int
        let wsPort: Int
        let username: String
        let password: String
    }

    public func definition() -> ModuleDefinition {
        Name("VoipCall")

        Events(
            "onIncomingCall",
            "onCallAnswered",
            "onCallEnded",
            "onCallFailed",
            "onRegistered",
            "onRegistrationFailed",
            "onPushToken"
        )

        OnCreate {
            self.callController = CXCallController()
            self.configureCXProvider()
        }

        OnDestroy {
            self.bridgeWs?.cancel(with: .goingAway, reason: nil)
            self.wsReconnectTimer?.invalidate()
            self.provider?.invalidate()
        }

        AsyncFunction("configure") { (config: [String: Any]) in
            guard let server = config["server"] as? String,
                  let username = config["username"] as? String,
                  let password = config["password"] as? String else {
                throw NSError(domain: "VoipCall", code: 1, userInfo: [NSLocalizedDescriptionKey: "server, username, password required"])
            }
            self.sipConfig = SipConfig(
                server: server,
                port: config["port"] as? Int ?? 5060,
                wsPort: config["wsPort"] as? Int ?? 8088,
                username: username,
                password: password
            )
        }

        AsyncFunction("register") { () -> [String: Any] in
            guard let config = self.sipConfig else {
                throw NSError(domain: "VoipCall", code: 2, userInfo: [NSLocalizedDescriptionKey: "Call configure() first"])
            }
            self.connectBridgeWebSocket(config: config)
            self.registerPushKit()
            return ["status": "registering", "server": config.server]
        }

        AsyncFunction("reportIncomingCall") { (callerNumber: String, callerName: String) -> String in
            let uuid = UUID()
            try await self.reportCall(uuid: uuid, callerNumber: callerNumber, callerName: callerName)
            return uuid.uuidString
        }

        AsyncFunction("endCall") { (uuidString: String) in
            guard let uuid = UUID(uuidString: uuidString) else { return }
            let action = CXEndCallAction(call: uuid)
            let tx = CXTransaction(action: action)
            try await self.callController?.request(tx)
        }

        AsyncFunction("getActiveCalls") { () -> [[String: Any]] in
            return self.activeCalls.values.map { call in
                ["uuid": call.uuid.uuidString, "caller": call.callerNumber, "name": call.callerName, "answered": call.answered]
            }
        }

        Function("isRegistered") { () -> Bool in
            return self.sipRegistered
        }
    }

    // MARK: - CallKit Provider

    private func configureCXProvider() {
        let config = CXProviderConfiguration()
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportsVideo = false
        config.supportedHandleTypes = [.phoneNumber]
        config.iconTemplateImageData = nil

        let p = CXProvider(configuration: config)
        p.setDelegate(self, queue: .main)
        self.provider = p
    }

    private func reportCall(uuid: UUID, callerNumber: String, callerName: String) async throws {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .phoneNumber, value: callerNumber)
        update.localizedCallerName = callerName.isEmpty ? callerNumber : callerName
        update.hasVideo = false
        update.supportsDTMF = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false

        activeCalls[uuid] = CallInfo(uuid: uuid, callerNumber: callerNumber, callerName: callerName)

        try await provider?.reportNewIncomingCall(with: uuid, update: update)
        sendEvent("onIncomingCall", ["uuid": uuid.uuidString, "caller": callerNumber, "name": callerName])
    }

    // MARK: - PushKit VoIP Registration

    private func registerPushKit() {
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.voipRegistry = registry
    }

    // MARK: - Bridge WebSocket (notification channel for incoming calls)

    private func connectBridgeWebSocket(config: SipConfig) {
        bridgeWs?.cancel(with: .goingAway, reason: nil)
        wsReconnectTimer?.invalidate()

        let url = URL(string: "ws://\(config.server):3333/ws/voip")!
        let ws = URLSession.shared.webSocketTask(with: url)
        self.bridgeWs = ws
        ws.resume()

        let auth = "{\"type\":\"auth\",\"username\":\"\(config.username)\",\"password\":\"\(config.password)\"}"
        ws.send(.string(auth)) { [weak self] error in
            if let error = error {
                print("[VoIP] bridge auth error: \(error)")
                self?.sendEvent("onRegistrationFailed", ["error": error.localizedDescription])
                self?.scheduleBridgeReconnect(config: config)
            } else {
                self?.sipRegistered = true
                self?.sendEvent("onRegistered", ["server": config.server])
                self?.bridgeReadLoop(config: config)
            }
        }
    }

    private func bridgeReadLoop(config: SipConfig) {
        bridgeWs?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                var text: String?
                switch message {
                case .string(let s): text = s
                case .data(let d): text = String(data: d, encoding: .utf8)
                @unknown default: break
                }
                if let text = text { self.handleBridgeMessage(text) }
                self.bridgeReadLoop(config: config)
            case .failure:
                self.sipRegistered = false
                self.sendEvent("onRegistrationFailed", ["error": "WebSocket disconnected"])
                self.scheduleBridgeReconnect(config: config)
            }
        }
    }

    private func handleBridgeMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        if type == "incoming_call" {
            let caller = json["caller"] as? String ?? "Unknown"
            let name = json["caller_name"] as? String ?? ""
            Task { try? await self.reportCall(uuid: UUID(), callerNumber: caller, callerName: name) }
        }
    }

    private func scheduleBridgeReconnect(config: SipConfig) {
        wsReconnectTimer?.invalidate()
        wsReconnectTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: false) { [weak self] _ in
            guard let self = self, let config = self.sipConfig else { return }
            self.connectBridgeWebSocket(config: config)
        }
    }

    // MARK: - Audio Session

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
        try? session.setActive(true)
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// MARK: - CXProviderDelegate

extension VoipCallModule: CXProviderDelegate {
    public func providerDidReset(_ provider: CXProvider) {
        sipSession?.stop()
        sipSession = nil
        activeCalls.removeAll()
    }

    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard var call = activeCalls[action.callUUID], let config = sipConfig else {
            action.fail()
            return
        }
        call.answered = true
        activeCalls[action.callUUID] = call

        configureAudioSession()

        let session = SipVoipSession(config: config, callUUID: action.callUUID)
        session.onEnded = { [weak self] in
            self?.provider?.reportCall(with: action.callUUID, endedAt: nil, reason: .remoteEnded)
            self?.activeCalls.removeValue(forKey: action.callUUID)
            self?.deactivateAudioSession()
            self?.sendEvent("onCallEnded", ["uuid": action.callUUID.uuidString, "reason": "remote"])
        }
        self.sipSession = session

        session.start { success in
            if success {
                action.fulfill()
                self.sendEvent("onCallAnswered", ["uuid": action.callUUID.uuidString])
            } else {
                action.fail()
                self.sendEvent("onCallFailed", ["uuid": action.callUUID.uuidString, "error": "SIP session failed"])
            }
        }
    }

    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if let call = activeCalls[action.callUUID], call.answered {
            sipSession?.stop()
            sipSession = nil
        }
        activeCalls.removeValue(forKey: action.callUUID)
        deactivateAudioSession()
        sendEvent("onCallEnded", ["uuid": action.callUUID.uuidString, "reason": "local"])
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        sipSession?.audioSessionActivated()
    }

    public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        sipSession?.audioSessionDeactivated()
    }
}

// MARK: - PKPushRegistryDelegate

extension VoipCallModule: PKPushRegistryDelegate {
    public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        sendEvent("onPushToken", ["token": token])
        if let ws = bridgeWs {
            let msg = "{\"type\":\"push_token\",\"token\":\"\(token)\"}"
            ws.send(.string(msg)) { _ in }
        }
    }

    public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {}

    public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        let data = payload.dictionaryPayload
        let caller = data["caller"] as? String ?? "Unknown"
        let name = data["caller_name"] as? String ?? ""

        Task {
            try? await self.reportCall(uuid: UUID(), callerNumber: caller, callerName: name)
            completion()
        }
    }
}
