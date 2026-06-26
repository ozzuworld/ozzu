import ExpoModulesCore
import Network

public class SocksRelayModule: Module {
    private var server: Socks5Server?

    public func definition() -> ModuleDefinition {
        Name("SocksRelay")

        Events("onStateChange", "onClientConnect", "onError")

        AsyncFunction("startRelay") { (port: UInt16, promise: Promise) in
            if self.server != nil {
                self.server?.stop()
            }
            let srv = Socks5Server(port: port, module: self)
            do {
                try srv.start()
                self.server = srv
                promise.resolve(true)
            } catch {
                promise.reject("START_FAILED", error.localizedDescription)
            }
        }

        Function("stopRelay") {
            self.server?.stop()
            self.server = nil
        }

        Function("isRunning") { () -> Bool in
            return self.server?.running ?? false
        }

        Function("getStats") { () -> [String: Any] in
            let srv = self.server
            return [
                "clientCount": srv?.activeClients ?? 0,
                "totalConnections": srv?.totalConnections ?? 0,
                "port": Int(srv?.port ?? 0),
            ]
        }
    }

    func emitState() {
        let srv = server
        sendEvent("onStateChange", [
            "running": srv?.running ?? false,
            "clientCount": srv?.activeClients ?? 0,
            "port": Int(srv?.port ?? 0),
        ])
    }

    func emitClient(remote: String, target: String, targetPort: UInt16) {
        sendEvent("onClientConnect", [
            "remoteAddr": remote,
            "targetAddr": target,
            "targetPort": Int(targetPort),
        ])
    }

    func emitError(_ msg: String) {
        sendEvent("onError", ["message": msg])
    }
}

// SOCKS5 proxy server using Network.framework
class Socks5Server {
    let port: UInt16
    private weak var module: SocksRelayModule?
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "ozzu.socks5", qos: .userInitiated)
    private var connections: [UUID: ClientConnection] = [:]
    private let lock = NSLock()

    private(set) var running = false
    private(set) var totalConnections = 0

    var activeClients: Int {
        lock.lock()
        defer { lock.unlock() }
        return connections.count
    }

    init(port: UInt16, module: SocksRelayModule) {
        self.port = port
        self.module = module
    }

    func start() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        l.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                self.running = true
                self.module?.emitState()
            case .failed(let err):
                self.running = false
                self.module?.emitError("Listener failed: \(err)")
                self.module?.emitState()
            case .cancelled:
                self.running = false
                self.module?.emitState()
            default:
                break
            }
        }
        l.newConnectionHandler = { [weak self] conn in
            self?.handleNewConnection(conn)
        }
        l.start(queue: queue)
        self.listener = l
    }

    func stop() {
        listener?.cancel()
        listener = nil
        running = false
        lock.lock()
        let conns = connections.values
        lock.unlock()
        for c in conns { c.cancel() }
        lock.lock()
        connections.removeAll()
        lock.unlock()
        module?.emitState()
    }

    private func handleNewConnection(_ conn: NWConnection) {
        let id = UUID()
        let client = ClientConnection(id: id, inbound: conn, server: self)
        lock.lock()
        connections[id] = client
        totalConnections += 1
        lock.unlock()
        module?.emitState()
        client.start(on: queue)
    }

    func removeConnection(_ id: UUID) {
        lock.lock()
        connections.removeValue(forKey: id)
        lock.unlock()
        module?.emitState()
    }

    func notifyClient(remote: String, target: String, targetPort: UInt16) {
        module?.emitClient(remote: remote, target: target, targetPort: targetPort)
    }
}

// Handles one SOCKS5 client session
private class ClientConnection {
    let id: UUID
    let inbound: NWConnection
    weak var server: Socks5Server?
    var outbound: NWConnection?
    var remoteAddr: String = "?"

    init(id: UUID, inbound: NWConnection, server: Socks5Server) {
        self.id = id
        self.inbound = inbound
        self.server = server
    }

    func start(on queue: DispatchQueue) {
        if let endpoint = inbound.currentPath?.remoteEndpoint,
           case .hostPort(let host, _) = endpoint {
            remoteAddr = "\(host)"
        }
        inbound.start(queue: queue)
        readGreeting()
    }

    func cancel() {
        inbound.cancel()
        outbound?.cancel()
    }

    // SOCKS5 §4: client greeting
    private func readGreeting() {
        inbound.receive(minimumIncompleteLength: 2, maximumLength: 257) { [weak self] data, _, _, error in
            guard let self = self, let data = data, data.count >= 2 else {
                self?.teardown(); return
            }
            let ver = data[0]
            if ver != 0x05 { self.teardown(); return }
            // Reply: no auth required
            let reply = Data([0x05, 0x00])
            self.inbound.send(content: reply, completion: .contentProcessed { err in
                if err != nil { self.teardown(); return }
                self.readRequest()
            })
        }
    }

    // SOCKS5 §5: client request
    private func readRequest() {
        inbound.receive(minimumIncompleteLength: 4, maximumLength: 512) { [weak self] data, _, _, error in
            guard let self = self, let data = data, data.count >= 4 else {
                self?.teardown(); return
            }
            let ver = data[0]
            let cmd = data[1]
            let atyp = data[3]

            if ver != 0x05 || cmd != 0x01 { // only CONNECT
                self.sendReply(0x07) // command not supported
                return
            }

            var targetHost: String?
            var targetPort: UInt16 = 0
            var consumed = 4

            switch atyp {
            case 0x01: // IPv4
                if data.count < 10 { self.teardown(); return }
                let ip = "\(data[4]).\(data[5]).\(data[6]).\(data[7])"
                targetHost = ip
                targetPort = UInt16(data[8]) << 8 | UInt16(data[9])
                consumed = 10
            case 0x03: // Domain
                let len = Int(data[4])
                if data.count < 5 + len + 2 { self.teardown(); return }
                targetHost = String(data: data[5..<(5+len)], encoding: .utf8)
                let portIdx = 5 + len
                targetPort = UInt16(data[portIdx]) << 8 | UInt16(data[portIdx+1])
                consumed = portIdx + 2
            case 0x04: // IPv6
                if data.count < 22 { self.teardown(); return }
                var parts: [String] = []
                for i in stride(from: 4, to: 20, by: 2) {
                    parts.append(String(format: "%02x%02x", data[i], data[i+1]))
                }
                targetHost = parts.joined(separator: ":")
                targetPort = UInt16(data[20]) << 8 | UInt16(data[21])
                consumed = 22
            default:
                self.sendReply(0x08) // address type not supported
                return
            }

            guard let host = targetHost else { self.sendReply(0x01); return }

            self.server?.notifyClient(remote: self.remoteAddr, target: host, targetPort: targetPort)
            self.connectToTarget(host: host, port: targetPort)
        }
    }

    private func connectToTarget(host: String, port: UInt16) {
        let endpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: port)!
        )
        let conn = NWConnection(to: endpoint, using: .tcp)
        self.outbound = conn

        conn.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                self.sendReply(0x00) // success
                self.startRelay()
            case .failed(_):
                self.sendReply(0x05) // connection refused
            case .cancelled:
                self.teardown()
            default:
                break
            }
        }
        conn.start(queue: DispatchQueue(label: "ozzu.socks5.out.\(id)", qos: .userInitiated))
    }

    private func sendReply(_ status: UInt8) {
        // SOCKS5 reply: ver=5, rep=status, rsv=0, atyp=1, bind_addr=0.0.0.0:0
        let reply = Data([0x05, status, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        inbound.send(content: reply, completion: .contentProcessed { [weak self] _ in
            if status != 0x00 { self?.teardown() }
        })
    }

    private func startRelay() {
        relay(from: inbound, to: outbound)
        relay(from: outbound, to: inbound)
    }

    private func relay(from src: NWConnection?, to dst: NWConnection?) {
        src?.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            if let data = data, !data.isEmpty {
                dst?.send(content: data, completion: .contentProcessed { err in
                    if err != nil { self?.teardown(); return }
                    self?.relay(from: src, to: dst)
                })
            } else if isComplete || error != nil {
                self?.teardown()
            } else {
                self?.relay(from: src, to: dst)
            }
        }
    }

    private func teardown() {
        inbound.cancel()
        outbound?.cancel()
        server?.removeConnection(id)
    }
}
