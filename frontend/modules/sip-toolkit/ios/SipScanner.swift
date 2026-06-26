import Foundation

class SipScanner {
    let client: SipClient
    weak var module: SipToolkitModule?
    private(set) var cancelled = false

    init(client: SipClient, module: SipToolkitModule?) {
        self.client = client
        self.module = module
    }

    func cancel() { cancelled = true }

    // Scan an IP range for SIP devices by sending OPTIONS
    func scanRange(
        startIp: String, endIp: String,
        port: UInt16, transport: String, timeoutMs: Int,
        completion: @escaping ([[String: Any]]) -> Void
    ) {
        let ips = generateIpRange(from: startIp, to: endIp)
        let localIp = client.getLocalIp()
        let localPort = client.getLocalPort()
        let timeout = TimeInterval(timeoutMs) / 1000.0
        var results: [[String: Any]] = []
        let total = ips.count
        let group = DispatchGroup()
        let sem = DispatchSemaphore(value: 20) // max 20 concurrent probes

        let resultsLock = NSLock()

        for (idx, ip) in ips.enumerated() {
            if cancelled { break }
            group.enter()
            sem.wait()

            let request = SipRequest.options(
                target: ip, port: port,
                from: "scanner", localIp: localIp, localPort: localPort
            )

            client.send(request: request, to: ip, port: port, transport: transport, timeout: timeout) { [weak self] resp in
                defer {
                    sem.signal()
                    group.leave()
                }
                guard let self = self, !self.cancelled else { return }

                self.module?.emitProgress(phase: "scan", current: idx + 1, total: total, found: results.count)

                guard let resp = resp else { return }

                let allow = resp.allow?.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) } ?? []
                let agent = resp.userAgent ?? resp.server ?? "unknown"
                let fingerprint = self.fingerprint(agent: agent, allow: allow, statusCode: resp.statusCode)

                let device: [String: Any] = [
                    "ip": ip,
                    "port": Int(port),
                    "userAgent": resp.userAgent ?? "",
                    "server": resp.server ?? "",
                    "allow": allow,
                    "statusCode": resp.statusCode,
                    "fingerprint": fingerprint,
                ]
                resultsLock.lock()
                results.append(device)
                resultsLock.unlock()
                self.module?.emitDevice(device)
            }
        }

        group.notify(queue: .main) {
            completion(results)
        }
    }

    // Enumerate extensions on a target
    func enumerateExtensions(
        target: String, port: UInt16,
        startExt: Int, endExt: Int,
        method: String, transport: String, timeoutMs: Int,
        completion: @escaping ([[String: Any]]) -> Void
    ) {
        let localIp = client.getLocalIp()
        let localPort = client.getLocalPort()
        let timeout = TimeInterval(timeoutMs) / 1000.0
        var results: [[String: Any]] = []
        let total = endExt - startExt + 1
        let group = DispatchGroup()
        let sem = DispatchSemaphore(value: 10) // throttle to avoid lockout
        let resultsLock = NSLock()
        var count = 0

        for ext in startExt...endExt {
            if cancelled { break }
            group.enter()
            sem.wait()
            count += 1
            let extStr = String(ext)

            let request: SipRequest
            switch method.uppercased() {
            case "INVITE":
                request = SipRequest.invite(target: target, port: port, ext: extStr, localIp: localIp, localPort: localPort)
            case "OPTIONS":
                request = SipRequest.options(target: target, port: port, from: extStr, localIp: localIp, localPort: localPort)
            default:
                request = SipRequest.register(target: target, port: port, ext: extStr, localIp: localIp, localPort: localPort)
            }

            client.send(request: request, to: target, port: port, transport: transport, timeout: timeout) { [weak self] resp in
                defer {
                    sem.signal()
                    group.leave()
                }
                guard let self = self, !self.cancelled else { return }

                self.module?.emitProgress(phase: "enum", current: count, total: total, found: results.count)

                guard let resp = resp else { return }

                let status: String
                switch resp.statusCode {
                case 200:
                    status = "exists"
                case 401, 407:
                    status = "auth_required"
                case 403:
                    status = "forbidden"
                case 404, 480, 604:
                    status = "not_found"
                default:
                    status = resp.statusCode < 400 ? "exists" : "not_found"
                }

                // only report found extensions
                if status == "exists" || status == "auth_required" || status == "forbidden" {
                    let extResult: [String: Any] = [
                        "extension": extStr,
                        "status": status,
                        "statusCode": resp.statusCode,
                        "realm": resp.authRealm ?? "",
                        "userAgent": resp.userAgent ?? resp.server ?? "",
                    ]
                    resultsLock.lock()
                    results.append(extResult)
                    resultsLock.unlock()
                    self.module?.emitExtension(extResult)
                }
            }
        }

        group.notify(queue: .main) {
            completion(results)
        }
    }

    // Test SIP digest auth credentials
    func testCredentials(
        target: String, port: UInt16,
        ext: String, username: String, password: String,
        transport: String,
        completion: @escaping ([String: Any]) -> Void
    ) {
        let localIp = client.getLocalIp()
        let localPort = client.getLocalPort()

        // Step 1: send unauthenticated REGISTER to get the challenge
        let initial = SipRequest.register(
            target: target, port: port, ext: ext,
            localIp: localIp, localPort: localPort
        )

        client.send(request: initial, to: target, port: port, transport: transport, timeout: 5.0) { [weak self] resp in
            guard let self = self, let resp = resp else {
                completion(["extension": ext, "username": username, "success": false, "statusCode": 0, "message": "No response"])
                return
            }

            guard resp.statusCode == 401 || resp.statusCode == 407,
                  let realm = resp.authRealm,
                  let nonce = resp.authNonce else {
                let result: [String: Any] = [
                    "extension": ext,
                    "username": username,
                    "success": resp.statusCode == 200,
                    "statusCode": resp.statusCode,
                    "message": resp.statusCode == 200 ? "No auth required" : "Unexpected: \(resp.statusCode) \(resp.reasonPhrase)",
                ]
                completion(result)
                self.module?.emitAuth(result)
                return
            }

            // Step 2: respond to challenge with digest auth
            let uri = "sip:\(target):\(port)"
            let authReq = SipRequest.registerWithAuth(
                target: target, port: port, ext: ext,
                username: username, password: password,
                realm: realm, nonce: nonce, uri: uri,
                localIp: localIp, localPort: localPort
            )

            self.client.send(request: authReq, to: target, port: port, transport: transport, timeout: 5.0) { resp2 in
                let success = resp2?.statusCode == 200
                let result: [String: Any] = [
                    "extension": ext,
                    "username": username,
                    "success": success,
                    "statusCode": resp2?.statusCode ?? 0,
                    "message": success ? "Authenticated" : "Failed: \(resp2?.statusCode ?? 0) \(resp2?.reasonPhrase ?? "no response")",
                ]
                completion(result)
                self.module?.emitAuth(result)
            }
        }
    }

    // Fingerprint PBX from User-Agent/Server header + allowed methods
    private func fingerprint(agent: String, allow: [String], statusCode: Int) -> String {
        let a = agent.lowercased()
        if a.contains("asterisk") { return "Asterisk" }
        if a.contains("freeswitch") { return "FreeSWITCH" }
        if a.contains("cisco") || a.contains("cucm") || a.contains("callmanager") { return "Cisco CUCM" }
        if a.contains("avaya") { return "Avaya" }
        if a.contains("kamailio") { return "Kamailio" }
        if a.contains("opensips") { return "OpenSIPS" }
        if a.contains("3cx") { return "3CX" }
        if a.contains("grandstream") { return "Grandstream" }
        if a.contains("yealink") { return "Yealink" }
        if a.contains("polycom") || a.contains("poly") { return "Poly" }
        if a.contains("mitel") { return "Mitel" }
        if a.contains("audiocodes") { return "AudioCodes" }
        if a.contains("genesys") { return "Genesys" }
        if a.contains("broadsoft") || a.contains("broadworks") { return "BroadSoft" }
        if a.contains("microsoft") || a.contains("lync") || a.contains("skype") { return "Microsoft" }
        if a.contains("panasonic") { return "Panasonic" }
        if allow.contains("SUBSCRIBE") && allow.contains("NOTIFY") { return "PBX (presence-capable)" }
        return agent.isEmpty ? "Unknown" : agent.components(separatedBy: "/").first ?? agent
    }

    private func generateIpRange(from start: String, to end: String) -> [String] {
        let s = start.split(separator: ".").compactMap { UInt32($0) }
        let e = end.split(separator: ".").compactMap { UInt32($0) }
        guard s.count == 4, e.count == 4 else { return [] }

        let startNum = (s[0] << 24) | (s[1] << 16) | (s[2] << 8) | s[3]
        let endNum = (e[0] << 24) | (e[1] << 16) | (e[2] << 8) | e[3]
        guard endNum >= startNum, endNum - startNum < 65536 else { return [] } // max /16

        return (startNum...endNum).map { num in
            "\((num >> 24) & 0xFF).\((num >> 16) & 0xFF).\((num >> 8) & 0xFF).\(num & 0xFF)"
        }
    }
}
