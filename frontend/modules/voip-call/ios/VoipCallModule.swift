import ExpoModulesCore
import CallKit
import AVFoundation
import PushKit

public class VoipCallModule: Module {
    private var delegate: VoipDelegate?
    private var callController: CXCallController?

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
            self.delegate = VoipDelegate(module: self)
        }

        OnDestroy {
            self.delegate?.teardown()
            self.delegate = nil
        }

        AsyncFunction("configure") { (config: [String: Any]) in
            guard let server = config["server"] as? String,
                  let username = config["username"] as? String,
                  let password = config["password"] as? String else {
                throw NSError(domain: "VoipCall", code: 1, userInfo: [NSLocalizedDescriptionKey: "server, username, password required"])
            }
            self.delegate?.sipConfig = SipConfig(
                server: server,
                port: config["port"] as? Int ?? 5060,
                wsPort: config["wsPort"] as? Int ?? 8088,
                username: username,
                password: password
            )
        }

        AsyncFunction("register") { () -> [String: Any] in
            guard let config = self.delegate?.sipConfig else {
                throw NSError(domain: "VoipCall", code: 2, userInfo: [NSLocalizedDescriptionKey: "Call configure() first"])
            }
            self.delegate?.connectWebSocket(config: config)
            self.delegate?.registerPushKit()
            return ["status": "registering", "server": config.server]
        }

        AsyncFunction("reportIncomingCall") { (callerNumber: String, callerName: String) -> String in
            guard let del = self.delegate else { return "" }
            let uuid = UUID()
            try await del.reportCall(uuid: uuid, callerNumber: callerNumber, callerName: callerName)
            return uuid.uuidString
        }

        AsyncFunction("endCall") { (uuidString: String) in
            guard let uuid = UUID(uuidString: uuidString) else { return }
            let action = CXEndCallAction(call: uuid)
            let tx = CXTransaction(action: action)
            try await self.callController?.request(tx)
        }

        AsyncFunction("getActiveCalls") { () -> [[String: Any]] in
            return self.delegate?.activeCalls.values.map { call in
                ["uuid": call.uuid.uuidString, "caller": call.callerNumber, "name": call.callerName, "answered": call.answered]
            } ?? []
        }

        Function("isRegistered") { () -> Bool in
            return self.delegate?.wsConnected ?? false
        }
    }
}

// MARK: - VoipDelegate (NSObject subclass for CXProviderDelegate + PKPushRegistryDelegate)

class VoipDelegate: NSObject, CXProviderDelegate, PKPushRegistryDelegate {
    struct CallInfo {
        let uuid: UUID
        let callerNumber: String
        let callerName: String
        var answered: Bool = false
    }

    weak var module: VoipCallModule?
    var sipConfig: VoipCallModule.SipConfig?
    var activeCalls: [UUID: CallInfo] = [:]

    private var provider: CXProvider?
    private var voipRegistry: PKPushRegistry?
    var sipSession: SipVoipSession?

    var wsTask: URLSessionWebSocketTask?
    private var wsSession: URLSession?
    var wsConnected = false
    private var wsReconnectTimer: Timer?

    init(module: VoipCallModule) {
        self.module = module
        super.init()
        configureCXProvider()
    }

    func teardown() {
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsReconnectTimer?.invalidate()
        provider?.invalidate()
    }

    // MARK: - CallKit Provider

    private func configureCXProvider() {
        let config = CXProviderConfiguration()
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportsVideo = false
        config.supportedHandleTypes = [.phoneNumber]

        let p = CXProvider(configuration: config)
        p.setDelegate(self, queue: .main)
        self.provider = p
    }

    func reportCall(uuid: UUID, callerNumber: String, callerName: String) async throws {
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
        module?.sendEvent("onIncomingCall", ["uuid": uuid.uuidString, "caller": callerNumber, "name": callerName])
    }

    // MARK: - PushKit VoIP Registration

    func registerPushKit() {
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.voipRegistry = registry
    }

    // MARK: - WebSocket to Bridge

    func connectWebSocket(config: VoipCallModule.SipConfig) {
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsReconnectTimer?.invalidate()

        let url = URL(string: "ws://\(config.server):3333/ws/voip")!
        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: url)
        self.wsSession = session
        self.wsTask = task

        task.resume()

        let auth = "{\"type\":\"auth\",\"username\":\"\(config.username)\",\"password\":\"\(config.password)\"}"
        task.send(.string(auth)) { [weak self] error in
            if let error = error {
                print("[VoIP] WS auth send error: \(error)")
                self?.wsConnected = false
                self?.module?.sendEvent("onRegistrationFailed", ["error": error.localizedDescription])
                self?.scheduleReconnect(config: config)
            } else {
                self?.wsConnected = true
                self?.module?.sendEvent("onRegistered", ["server": config.server])
                self?.wsReadLoop(config: config)
            }
        }
    }

    private func wsReadLoop(config: VoipCallModule.SipConfig) {
        wsTask?.receive { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleWsMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleWsMessage(text)
                    }
                @unknown default:
                    break
                }
                self.wsReadLoop(config: config)
            case .failure(let error):
                print("[VoIP] WS read error: \(error)")
                self.wsConnected = false
                self.module?.sendEvent("onRegistrationFailed", ["error": "WebSocket disconnected"])
                self.scheduleReconnect(config: config)
            }
        }
    }

    private func handleWsMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        if type == "incoming_call" {
            let caller = json["caller"] as? String ?? "Unknown"
            let name = json["caller_name"] as? String ?? ""
            Task {
                try? await self.reportCall(uuid: UUID(), callerNumber: caller, callerName: name)
            }
        }
    }

    private func scheduleReconnect(config: VoipCallModule.SipConfig) {
        wsReconnectTimer?.invalidate()
        DispatchQueue.main.async {
            self.wsReconnectTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: false) { [weak self] _ in
                self?.connectWebSocket(config: config)
            }
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

    // MARK: - CXProviderDelegate

    func providerDidReset(_ provider: CXProvider) {
        sipSession?.stop()
        sipSession = nil
        activeCalls.removeAll()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
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
            self?.module?.sendEvent("onCallEnded", ["uuid": action.callUUID.uuidString, "reason": "remote"])
        }
        self.sipSession = session

        session.start { success in
            if success {
                action.fulfill()
                self.module?.sendEvent("onCallAnswered", ["uuid": action.callUUID.uuidString])
            } else {
                action.fail()
                self.module?.sendEvent("onCallFailed", ["uuid": action.callUUID.uuidString, "error": "SIP session failed"])
            }
        }
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if let call = activeCalls[action.callUUID], call.answered {
            sipSession?.stop()
            sipSession = nil
        }
        activeCalls.removeValue(forKey: action.callUUID)
        deactivateAudioSession()
        module?.sendEvent("onCallEnded", ["uuid": action.callUUID.uuidString, "reason": "local"])
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        sipSession?.audioSessionActivated()
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        sipSession?.audioSessionDeactivated()
    }

    // MARK: - PKPushRegistryDelegate

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        module?.sendEvent("onPushToken", ["token": token])
        if let task = wsTask {
            let msg = "{\"type\":\"push_token\",\"token\":\"\(token)\"}"
            task.send(.string(msg)) { _ in }
        }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {}

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        let data = payload.dictionaryPayload
        let caller = data["caller"] as? String ?? "Unknown"
        let name = data["caller_name"] as? String ?? ""

        Task {
            try? await self.reportCall(uuid: UUID(), callerNumber: caller, callerName: name)
            completion()
        }
    }
}
