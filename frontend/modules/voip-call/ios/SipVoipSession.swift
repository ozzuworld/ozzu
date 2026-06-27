import Foundation
import AVFoundation
import Network

class SipVoipSession {
    private let server: String
    private let port: Int
    private let username: String
    private let password: String
    private let callUUID: UUID

    private var udpConnection: NWConnection?
    private var rtpConnection: NWConnection?
    private var localRtpPort: UInt16 = 0
    private var remoteRtpPort: UInt16 = 0
    private var sipCallId: String = ""
    private var sipTag: String = ""
    private var sipBranch: String = ""
    private var remoteTag: String = ""

    private var audioEngine: AVAudioEngine?
    private var inputNode: AVAudioInputNode?
    private var playerNode: AVAudioPlayerNode?
    private var rtpSequence: UInt16 = 0
    private var rtpTimestamp: UInt32 = 0
    private let rtpSSRC: UInt32 = UInt32.random(in: 1...UInt32.max)

    private var isRunning = false
    var onEnded: (() -> Void)?

    init(config: VoipCallModule.SipConfig, callUUID: UUID) {
        self.server = config.server
        self.port = config.port
        self.username = config.username
        self.password = config.password
        self.callUUID = callUUID
        self.sipCallId = "ozzu-\(UUID().uuidString.prefix(8))"
        self.sipTag = "tag-\(UUID().uuidString.prefix(8))"
        self.sipBranch = "z9hG4bK-\(UUID().uuidString.prefix(12))"
    }

    func start(completion: @escaping (Bool) -> Void) {
        isRunning = true

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { completion(false); return }

            do {
                self.localRtpPort = try self.findFreeUdpPort()
                try self.sendSipInvite { success in
                    if success {
                        self.startAudioBridge()
                        completion(true)
                    } else {
                        completion(false)
                    }
                }
            } catch {
                print("[VoIP] start error: \(error)")
                completion(false)
            }
        }
    }

    func stop() {
        guard isRunning else { return }
        isRunning = false
        sendSipBye()
        stopAudioBridge()
        udpConnection?.cancel()
        rtpConnection?.cancel()
    }

    func audioSessionActivated() {
        try? audioEngine?.start()
    }

    func audioSessionDeactivated() {
        audioEngine?.pause()
    }

    // MARK: - SIP Signaling

    private func sendSipInvite(completion: @escaping (Bool) -> Void) throws {
        let localIp = getLocalIp()
        let cr = "\r\n"

        let sdp = "v=0" + cr
            + "o=ozzu 1 1 IN IP4 \(localIp)" + cr
            + "s=Ozzu VoIP" + cr
            + "c=IN IP4 \(localIp)" + cr
            + "t=0 0" + cr
            + "m=audio \(localRtpPort) RTP/AVP 0 8" + cr
            + "a=rtpmap:0 PCMU/8000" + cr
            + "a=rtpmap:8 PCMA/8000" + cr
            + "a=sendrecv" + cr

        let invite = "INVITE sip:incoming@\(server) SIP/2.0" + cr
            + "Via: SIP/2.0/UDP \(localIp):\(localRtpPort);branch=\(sipBranch)" + cr
            + "From: <sip:\(username)@\(server)>;tag=\(sipTag)" + cr
            + "To: <sip:incoming@\(server)>" + cr
            + "Call-ID: \(sipCallId)" + cr
            + "CSeq: 1 INVITE" + cr
            + "Contact: <sip:\(username)@\(localIp):\(localRtpPort)>" + cr
            + "Content-Type: application/sdp" + cr
            + "Max-Forwards: 70" + cr
            + "User-Agent: Ozzu/1.0" + cr
            + "Content-Length: \(sdp.utf8.count)" + cr
            + cr + sdp

        let host = NWEndpoint.Host(server)
        let nwPort = NWEndpoint.Port(integerLiteral: UInt16(port))
        let conn = NWConnection(host: host, port: nwPort, using: .udp)

        conn.stateUpdateHandler = { state in
            if case .ready = state {
                conn.send(content: invite.data(using: .utf8), completion: .contentProcessed({ _ in }))

                self.receiveSipResponse(conn: conn) { response in
                    if let resp = response, resp.statusCode == 200 {
                        self.remoteRtpPort = self.extractRtpPort(from: resp.body)
                        self.remoteTag = self.extractTag(from: resp.headers["To"] ?? "")
                        self.sendSipAck(conn: conn)
                        completion(true)
                    } else {
                        completion(false)
                    }
                }
            }
        }
        conn.start(queue: .global(qos: .userInitiated))
        self.udpConnection = conn
    }

    private func receiveSipResponse(conn: NWConnection, completion: @escaping (SipVoipResponse?) -> Void) {
        var got200 = false
        func readNext() {
            conn.receiveMessage { data, _, _, error in
                guard let data = data, let str = String(data: data, encoding: .utf8) else {
                    if !got200 { completion(nil) }
                    return
                }
                let resp = SipVoipResponse.parse(str)
                if resp.statusCode >= 100 && resp.statusCode < 200 {
                    readNext()
                } else if resp.statusCode == 200 {
                    got200 = true
                    completion(resp)
                } else {
                    completion(nil)
                }
            }
        }
        readNext()
    }

    private func sendSipAck(conn: NWConnection) {
        let localIp = getLocalIp()
        let cr = "\r\n"
        let ack = "ACK sip:incoming@\(server) SIP/2.0" + cr
            + "Via: SIP/2.0/UDP \(localIp):\(localRtpPort);branch=z9hG4bK-\(UUID().uuidString.prefix(12))" + cr
            + "From: <sip:\(username)@\(server)>;tag=\(sipTag)" + cr
            + "To: <sip:incoming@\(server)>" + (remoteTag.isEmpty ? "" : ";tag=\(remoteTag)") + cr
            + "Call-ID: \(sipCallId)" + cr
            + "CSeq: 1 ACK" + cr
            + "Max-Forwards: 70" + cr
            + "Content-Length: 0" + cr + cr

        conn.send(content: ack.data(using: .utf8), completion: .idempotent)
    }

    private func sendSipBye() {
        guard let conn = udpConnection else { return }
        let localIp = getLocalIp()
        let cr = "\r\n"
        let bye = "BYE sip:incoming@\(server) SIP/2.0" + cr
            + "Via: SIP/2.0/UDP \(localIp):\(localRtpPort);branch=z9hG4bK-\(UUID().uuidString.prefix(12))" + cr
            + "From: <sip:\(username)@\(server)>;tag=\(sipTag)" + cr
            + "To: <sip:incoming@\(server)>" + (remoteTag.isEmpty ? "" : ";tag=\(remoteTag)") + cr
            + "Call-ID: \(sipCallId)" + cr
            + "CSeq: 2 BYE" + cr
            + "Max-Forwards: 70" + cr
            + "Content-Length: 0" + cr + cr

        conn.send(content: bye.data(using: .utf8), completion: .idempotent)
    }

    // MARK: - Audio Bridge (RTP)

    private func startAudioBridge() {
        guard remoteRtpPort > 0 else { return }

        let host = NWEndpoint.Host(server)
        let nwPort = NWEndpoint.Port(integerLiteral: remoteRtpPort)
        let conn = NWConnection(host: host, port: nwPort, using: .udp)
        conn.start(queue: .global(qos: .userInitiated))
        self.rtpConnection = conn

        startRtpReceive(conn: conn)
        startAudioCapture(conn: conn)
    }

    private func stopAudioBridge() {
        audioEngine?.stop()
        audioEngine = nil
        playerNode = nil
    }

    private func startAudioCapture(conn: NWConnection) {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 8000, channels: 1, interleaved: false)!

        let converter = AVAudioConverter(from: input.outputFormat(forBus: 0), to: format)

        input.installTap(onBus: 0, bufferSize: 160, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            guard let self = self, self.isRunning else { return }

            let convertedBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160)!
            var error: NSError?
            converter?.convert(to: convertedBuffer, error: &error) { _, status in
                status.pointee = .haveData
                return buffer
            }

            let pcmu = self.encodePCMU(buffer: convertedBuffer)
            let rtpPacket = self.buildRtpPacket(payload: pcmu)
            conn.send(content: rtpPacket, completion: .idempotent)
        }

        self.audioEngine = engine
        try? engine.start()
    }

    private func startRtpReceive(conn: NWConnection) {
        let player = AVAudioPlayerNode()
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 8000, channels: 1, interleaved: false)!

        if let engine = audioEngine {
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            player.play()
            self.playerNode = player
        }

        func readRtp() {
            guard self.isRunning else { return }
            conn.receiveMessage { [weak self] data, _, _, _ in
                guard let self = self, let data = data, data.count > 12 else {
                    readRtp()
                    return
                }
                let payload = data.subdata(in: 12..<data.count)
                let pcmBuffer = self.decodePCMU(data: payload)
                self.playerNode?.scheduleBuffer(pcmBuffer)
                readRtp()
            }
        }
        readRtp()
    }

    // MARK: - PCMU Codec (G.711 μ-law)

    private func encodePCMU(buffer: AVAudioPCMBuffer) -> Data {
        guard let floatData = buffer.floatChannelData?[0] else { return Data() }
        let frameCount = Int(buffer.frameLength)
        var encoded = Data(count: frameCount)

        for i in 0..<frameCount {
            let sample = Int16(max(-32768, min(32767, floatData[i] * 32768.0)))
            encoded[i] = linearToUlaw(sample)
        }
        return encoded
    }

    private func decodePCMU(data: Data) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 8000, channels: 1, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: UInt32(data.count))!
        buffer.frameLength = UInt32(data.count)

        let floatData = buffer.floatChannelData![0]
        for i in 0..<data.count {
            let linear = ulawToLinear(data[i])
            floatData[i] = Float(linear) / 32768.0
        }
        return buffer
    }

    private func linearToUlaw(_ sample: Int16) -> UInt8 {
        let BIAS: Int16 = 0x84
        let CLIP: Int16 = 32635
        let sign: Int16 = (sample >> 8) & 0x80
        var s = sample < 0 ? -sample : sample
        if s > CLIP { s = CLIP }
        s = s + BIAS

        let exponent = ulawCompressTable[Int((s >> 4) & 0xFF)]
        let mantissa = (s >> (exponent + 3)) & 0x0F
        let result = ~(sign | (exponent << 4) | mantissa)
        return UInt8(truncatingIfNeeded: result)
    }

    private func ulawToLinear(_ ulaw: UInt8) -> Int16 {
        let u = ~ulaw
        let sign: Int16 = Int16(u) & 0x80
        let exponent = (Int16(u) >> 4) & 0x07
        let mantissa = Int16(u) & 0x0F
        var sample = ((mantissa << (exponent + 3)) + (1 << (exponent + 3)) - 0x84)
        if sign != 0 { sample = -sample }
        return sample
    }

    private let ulawCompressTable: [Int16] = [
        0,0,1,1,2,2,2,2,3,3,3,3,3,3,3,3,
        4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
        5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
        5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
        6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
        6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
        6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
        6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
        7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
        7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
        7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
        7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
        7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
        7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
        7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
        7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7
    ]

    // MARK: - RTP Packet

    private func buildRtpPacket(payload: Data) -> Data {
        var packet = Data(count: 12 + payload.count)
        packet[0] = 0x80  // V=2, no padding, no extension, CC=0
        packet[1] = 0x00  // PT=0 (PCMU), no marker

        rtpSequence &+= 1
        packet[2] = UInt8(rtpSequence >> 8)
        packet[3] = UInt8(rtpSequence & 0xFF)

        rtpTimestamp &+= 160
        packet[4] = UInt8((rtpTimestamp >> 24) & 0xFF)
        packet[5] = UInt8((rtpTimestamp >> 16) & 0xFF)
        packet[6] = UInt8((rtpTimestamp >> 8) & 0xFF)
        packet[7] = UInt8(rtpTimestamp & 0xFF)

        packet[8] = UInt8((rtpSSRC >> 24) & 0xFF)
        packet[9] = UInt8((rtpSSRC >> 16) & 0xFF)
        packet[10] = UInt8((rtpSSRC >> 8) & 0xFF)
        packet[11] = UInt8(rtpSSRC & 0xFF)

        packet.replaceSubrange(12..<(12 + payload.count), with: payload)
        return packet
    }

    // MARK: - Helpers

    private func findFreeUdpPort() throws -> UInt16 {
        let params = NWParameters.udp
        let listener = try NWListener(using: params, on: .any)
        let semaphore = DispatchSemaphore(value: 0)
        var port: UInt16 = 0

        listener.stateUpdateHandler = { state in
            if case .ready = state, let p = listener.port {
                port = p.rawValue
                semaphore.signal()
            }
        }
        listener.start(queue: .global())
        semaphore.wait()
        listener.cancel()
        return port
    }

    private func getLocalIp() -> String {
        var address = "0.0.0.0"
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return address }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let iface = ptr.pointee
            let family = iface.ifa_addr.pointee.sa_family
            guard family == UInt8(AF_INET) else { continue }
            let name = String(cString: iface.ifa_name)
            guard name == "en0" || name == "utun" || name.hasPrefix("utun") else { continue }
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(iface.ifa_addr, socklen_t(iface.ifa_addr.pointee.sa_len),
                       &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST)
            address = String(cString: hostname)
            if name == "en0" { break }
        }
        return address
    }

    private func extractRtpPort(from sdp: String) -> UInt16 {
        for line in sdp.components(separatedBy: "\r\n") {
            if line.hasPrefix("m=audio ") {
                let parts = line.components(separatedBy: " ")
                if parts.count >= 2, let port = UInt16(parts[1]) {
                    return port
                }
            }
        }
        return 0
    }

    private func extractTag(from header: String) -> String {
        if let range = header.range(of: "tag=") {
            let start = range.upperBound
            let rest = String(header[start...])
            return rest.components(separatedBy: CharacterSet(charactersIn: ";> \r\n")).first ?? ""
        }
        return ""
    }
}

struct SipVoipResponse {
    let statusCode: Int
    let headers: [String: String]
    let body: String

    static func parse(_ raw: String) -> SipVoipResponse {
        let parts = raw.components(separatedBy: "\r\n\r\n")
        let headerSection = parts[0]
        let bodySection = parts.count > 1 ? parts[1] : ""

        let lines = headerSection.components(separatedBy: "\r\n")
        var statusCode = 0
        var headers: [String: String] = [:]

        for (i, line) in lines.enumerated() {
            if i == 0 {
                let comps = line.components(separatedBy: " ")
                if comps.count >= 2 { statusCode = Int(comps[1]) ?? 0 }
            } else if let colonIdx = line.firstIndex(of: ":") {
                let key = String(line[line.startIndex..<colonIdx]).trimmingCharacters(in: .whitespaces)
                let val = String(line[line.index(after: colonIdx)...]).trimmingCharacters(in: .whitespaces)
                headers[key] = val
            }
        }
        return SipVoipResponse(statusCode: statusCode, headers: headers, body: bodySection)
    }
}
