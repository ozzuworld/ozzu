import Foundation
import Network

class SipClient {
    private let queue = DispatchQueue(label: "ozzu.sip.client", qos: .userInitiated)
    private var localPort: UInt16 = 0
    private var localIp: String = "0.0.0.0"
    private var udpListener: NWListener?

    // pending responses keyed by remote endpoint string
    private var pendingCallbacks: [String: (SipResponse?) -> Void] = [:]
    private let lock = NSLock()

    init() {
        resolveLocalIp()
    }

    deinit {
        udpListener?.cancel()
    }

    func getLocalIp() -> String { localIp }
    func getLocalPort() -> UInt16 { localPort }

    func startUdpListener() throws {
        let params = NWParameters.udp
        params.allowLocalEndpointReuse = true
        let l = try NWListener(using: params, on: .any)
        l.stateUpdateHandler = { [weak self] state in
            if case .ready = state, let port = l.port {
                self?.localPort = port.rawValue
            }
        }
        l.newConnectionHandler = { [weak self] conn in
            self?.handleIncomingUdp(conn)
        }
        l.start(queue: queue)
        self.udpListener = l
        // wait briefly for port assignment
        Thread.sleep(forTimeInterval: 0.1)
        if let port = l.port { localPort = port.rawValue }
    }

    private func handleIncomingUdp(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receiveMessage { [weak self] data, _, _, error in
            guard let self = self, let data = data, let resp = SipResponse.parse(data) else {
                conn.cancel()
                return
            }
            var key: String? = nil
            if let ep = conn.currentPath?.remoteEndpoint, case .hostPort(let host, let port) = ep {
                key = "\(host):\(port)"
            }
            if let key = key {
                self.lock.lock()
                let cb = self.pendingCallbacks.removeValue(forKey: key)
                self.lock.unlock()
                cb?(resp)
            }
            conn.cancel()
        }
    }

    func sendUdp(
        request: SipRequest,
        to host: String,
        port: UInt16,
        timeout: TimeInterval,
        completion: @escaping (SipResponse?) -> Void
    ) {
        let endpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: port)!
        )
        let conn = NWConnection(to: endpoint, using: .udp)
        let key = "\(host):\(port)"

        lock.lock()
        pendingCallbacks[key] = completion
        lock.unlock()

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + timeout)
        timer.setEventHandler { [weak self] in
            timer.cancel()
            self?.lock.lock()
            let cb = self?.pendingCallbacks.removeValue(forKey: key)
            self?.lock.unlock()
            cb?(nil)
            conn.cancel()
        }
        timer.resume()

        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                conn.send(content: request.serialize(), completion: .contentProcessed { error in
                    if error != nil {
                        timer.cancel()
                        conn.cancel()
                        self.lock.lock()
                        let cb = self.pendingCallbacks.removeValue(forKey: key)
                        self.lock.unlock()
                        cb?(nil)
                    }
                })
                conn.receiveMessage { data, _, _, _ in
                    timer.cancel()
                    conn.cancel()
                    let resp = data.flatMap { SipResponse.parse($0) }
                    self.lock.lock()
                    let cb = self.pendingCallbacks.removeValue(forKey: key)
                    self.lock.unlock()
                    cb?(resp)
                }
            case .failed(_), .cancelled:
                timer.cancel()
                self.lock.lock()
                let cb = self.pendingCallbacks.removeValue(forKey: key)
                self.lock.unlock()
                cb?(nil)
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    func sendTcp(
        request: SipRequest,
        to host: String,
        port: UInt16,
        timeout: TimeInterval,
        completion: @escaping (SipResponse?) -> Void
    ) {
        let endpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: port)!
        )
        let conn = NWConnection(to: endpoint, using: .tcp)

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + timeout)
        timer.setEventHandler {
            timer.cancel()
            conn.cancel()
            completion(nil)
        }
        timer.resume()

        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                conn.send(content: request.serialize(), completion: .contentProcessed { error in
                    if error != nil {
                        timer.cancel()
                        conn.cancel()
                        completion(nil)
                        return
                    }
                    conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
                        timer.cancel()
                        conn.cancel()
                        let resp = data.flatMap { SipResponse.parse($0) }
                        completion(resp)
                    }
                })
            case .failed(_), .cancelled:
                timer.cancel()
                completion(nil)
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    func send(
        request: SipRequest,
        to host: String,
        port: UInt16,
        transport: String,
        timeout: TimeInterval,
        completion: @escaping (SipResponse?) -> Void
    ) {
        if transport == "tcp" {
            sendTcp(request: request, to: host, port: port, timeout: timeout, completion: completion)
        } else {
            sendUdp(request: request, to: host, port: port, timeout: timeout, completion: completion)
        }
    }

    private func resolveLocalIp() {
        var address = "0.0.0.0"
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard (flags & (IFF_UP | IFF_RUNNING)) == (IFF_UP | IFF_RUNNING) else { continue }
            guard ptr.pointee.ifa_addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: ptr.pointee.ifa_name)
            // prefer en0 (WiFi) or utun (WireGuard)
            guard name.hasPrefix("en") || name.hasPrefix("utun") else { continue }
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(
                ptr.pointee.ifa_addr, socklen_t(ptr.pointee.ifa_addr.pointee.sa_len),
                &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST
            )
            let ip = String(cString: hostname)
            if !ip.isEmpty && ip != "0.0.0.0" {
                if name.hasPrefix("en") { address = ip } // WiFi wins
                else if address == "0.0.0.0" { address = ip }
            }
        }
        localIp = address
    }
}
