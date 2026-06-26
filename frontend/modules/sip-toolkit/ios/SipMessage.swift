import Foundation
import CommonCrypto

struct SipRequest {
    let method: String
    let uri: String
    var headers: [(String, String)] = []
    var body: String = ""

    static func options(target: String, port: UInt16, from: String, localIp: String, localPort: UInt16) -> SipRequest {
        let branch = "z9hG4bK-\(UUID().uuidString.prefix(12))"
        let callId = "\(UUID().uuidString.prefix(16))@\(localIp)"
        let tag = String(UUID().uuidString.prefix(8))
        var req = SipRequest(method: "OPTIONS", uri: "sip:\(target):\(port)")
        req.headers = [
            ("Via", "SIP/2.0/UDP \(localIp):\(localPort);branch=\(branch);rport"),
            ("From", "<sip:scanner@\(localIp)>;tag=\(tag)"),
            ("To", "<sip:\(target):\(port)>"),
            ("Call-ID", callId),
            ("CSeq", "1 OPTIONS"),
            ("Max-Forwards", "70"),
            ("User-Agent", "OzzuSOC/1.0"),
            ("Accept", "application/sdp"),
            ("Content-Length", "0"),
        ]
        return req
    }

    static func register(target: String, port: UInt16, ext: String, localIp: String, localPort: UInt16) -> SipRequest {
        let branch = "z9hG4bK-\(UUID().uuidString.prefix(12))"
        let callId = "\(UUID().uuidString.prefix(16))@\(localIp)"
        let tag = String(UUID().uuidString.prefix(8))
        var req = SipRequest(method: "REGISTER", uri: "sip:\(target):\(port)")
        req.headers = [
            ("Via", "SIP/2.0/UDP \(localIp):\(localPort);branch=\(branch);rport"),
            ("From", "<sip:\(ext)@\(target)>;tag=\(tag)"),
            ("To", "<sip:\(ext)@\(target)>"),
            ("Call-ID", callId),
            ("CSeq", "1 REGISTER"),
            ("Contact", "<sip:\(ext)@\(localIp):\(localPort)>"),
            ("Max-Forwards", "70"),
            ("User-Agent", "OzzuSOC/1.0"),
            ("Expires", "0"),
            ("Content-Length", "0"),
        ]
        return req
    }

    static func invite(target: String, port: UInt16, ext: String, localIp: String, localPort: UInt16) -> SipRequest {
        let branch = "z9hG4bK-\(UUID().uuidString.prefix(12))"
        let callId = "\(UUID().uuidString.prefix(16))@\(localIp)"
        let tag = String(UUID().uuidString.prefix(8))
        var req = SipRequest(method: "INVITE", uri: "sip:\(ext)@\(target):\(port)")
        req.headers = [
            ("Via", "SIP/2.0/UDP \(localIp):\(localPort);branch=\(branch);rport"),
            ("From", "<sip:scanner@\(localIp)>;tag=\(tag)"),
            ("To", "<sip:\(ext)@\(target)>"),
            ("Call-ID", callId),
            ("CSeq", "1 INVITE"),
            ("Contact", "<sip:scanner@\(localIp):\(localPort)>"),
            ("Max-Forwards", "70"),
            ("User-Agent", "OzzuSOC/1.0"),
            ("Content-Length", "0"),
        ]
        return req
    }

    static func registerWithAuth(
        target: String, port: UInt16, ext: String,
        username: String, password: String,
        realm: String, nonce: String, uri: String,
        localIp: String, localPort: UInt16
    ) -> SipRequest {
        let ha1 = md5("\(username):\(realm):\(password)")
        let ha2 = md5("REGISTER:\(uri)")
        let response = md5("\(ha1):\(nonce):\(ha2)")

        let branch = "z9hG4bK-\(UUID().uuidString.prefix(12))"
        let callId = "\(UUID().uuidString.prefix(16))@\(localIp)"
        let tag = String(UUID().uuidString.prefix(8))
        let authHeader = "Digest username=\"\(username)\", realm=\"\(realm)\", nonce=\"\(nonce)\", uri=\"\(uri)\", response=\"\(response)\", algorithm=MD5"

        var req = SipRequest(method: "REGISTER", uri: "sip:\(target):\(port)")
        req.headers = [
            ("Via", "SIP/2.0/UDP \(localIp):\(localPort);branch=\(branch);rport"),
            ("From", "<sip:\(ext)@\(target)>;tag=\(tag)"),
            ("To", "<sip:\(ext)@\(target)>"),
            ("Call-ID", callId),
            ("CSeq", "2 REGISTER"),
            ("Contact", "<sip:\(ext)@\(localIp):\(localPort)>"),
            ("Authorization", authHeader),
            ("Max-Forwards", "70"),
            ("User-Agent", "OzzuSOC/1.0"),
            ("Expires", "0"),
            ("Content-Length", "0"),
        ]
        return req
    }

    func serialize() -> Data {
        var lines = ["\(method) \(uri) SIP/2.0"]
        for (name, value) in headers {
            lines.append("\(name): \(value)")
        }
        lines.append("")
        if !body.isEmpty { lines.append(body) }
        let raw = lines.joined(separator: "\r\n") + "\r\n"
        return raw.data(using: .utf8) ?? Data()
    }

    private static func md5(_ input: String) -> String {
        let data = Data(input.utf8)
        var digest = [UInt8](repeating: 0, count: Int(CC_MD5_DIGEST_LENGTH))
        data.withUnsafeBytes {
            _ = CC_MD5($0.baseAddress, CC_LONG(data.count), &digest)
        }
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

struct SipResponse {
    let statusCode: Int
    let reasonPhrase: String
    let headers: [(String, String)]
    let body: String
    let rawText: String

    var userAgent: String? { headerValue("User-Agent") }
    var server: String? { headerValue("Server") }
    var allow: String? { headerValue("Allow") }
    var wwwAuthenticate: String? { headerValue("WWW-Authenticate") }

    func headerValue(_ name: String) -> String? {
        headers.first(where: { $0.0.caseInsensitiveCompare(name) == .orderedSame })?.1
    }

    var authRealm: String? {
        guard let auth = wwwAuthenticate else { return nil }
        return extractQuoted(auth, "realm")
    }

    var authNonce: String? {
        guard let auth = wwwAuthenticate else { return nil }
        return extractQuoted(auth, "nonce")
    }

    private func extractQuoted(_ header: String, _ key: String) -> String? {
        guard let range = header.range(of: "\(key)=\"", options: .caseInsensitive) else { return nil }
        let rest = header[range.upperBound...]
        guard let end = rest.firstIndex(of: "\"") else { return nil }
        return String(rest[..<end])
    }

    static func parse(_ data: Data) -> SipResponse? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        let lines = text.components(separatedBy: "\r\n")
        guard let statusLine = lines.first else { return nil }

        let parts = statusLine.split(separator: " ", maxSplits: 2)
        guard parts.count >= 2, parts[0].hasPrefix("SIP/") else { return nil }
        guard let code = Int(parts[1]) else { return nil }
        let reason = parts.count > 2 ? String(parts[2]) : ""

        var headers: [(String, String)] = []
        var bodyStart = false
        var bodyLines: [String] = []

        for line in lines.dropFirst() {
            if bodyStart {
                bodyLines.append(line)
                continue
            }
            if line.isEmpty {
                bodyStart = true
                continue
            }
            if let colonIdx = line.firstIndex(of: ":") {
                let name = String(line[..<colonIdx]).trimmingCharacters(in: .whitespaces)
                let value = String(line[line.index(after: colonIdx)...]).trimmingCharacters(in: .whitespaces)
                headers.append((name, value))
            }
        }

        return SipResponse(
            statusCode: code,
            reasonPhrase: reason,
            headers: headers,
            body: bodyLines.joined(separator: "\r\n"),
            rawText: text
        )
    }
}
