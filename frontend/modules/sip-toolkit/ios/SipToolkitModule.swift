import ExpoModulesCore

public class SipToolkitModule: Module {
    private var client: SipClient?
    private var scanner: SipScanner?

    public func definition() -> ModuleDefinition {
        Name("SipToolkit")

        Events("onDeviceFound", "onExtensionFound", "onAuthResult", "onProgress", "onRawResponse", "onError")

        OnCreate {
            let c = SipClient()
            try? c.startUdpListener()
            self.client = c
        }

        AsyncFunction("scanRange") { (startIp: String, endIp: String, port: Int, transport: String, timeoutMs: Int, promise: Promise) in
            guard let client = self.client else {
                promise.reject("NO_CLIENT", "SIP client not initialized")
                return
            }
            self.scanner?.cancel()
            let sc = SipScanner(client: client, module: self)
            self.scanner = sc
            sc.scanRange(
                startIp: startIp, endIp: endIp,
                port: UInt16(port), transport: transport, timeoutMs: timeoutMs
            ) { results in
                promise.resolve(results)
            }
        }

        AsyncFunction("enumerateExtensions") { (target: String, port: Int, startExt: Int, endExt: Int, method: String, transport: String, timeoutMs: Int, promise: Promise) in
            guard let client = self.client else {
                promise.reject("NO_CLIENT", "SIP client not initialized")
                return
            }
            self.scanner?.cancel()
            let sc = SipScanner(client: client, module: self)
            self.scanner = sc
            sc.enumerateExtensions(
                target: target, port: UInt16(port),
                startExt: startExt, endExt: endExt,
                method: method, transport: transport, timeoutMs: timeoutMs
            ) { results in
                promise.resolve(results)
            }
        }

        AsyncFunction("testCredentials") { (target: String, port: Int, ext: String, username: String, password: String, transport: String, promise: Promise) in
            guard let client = self.client else {
                promise.reject("NO_CLIENT", "SIP client not initialized")
                return
            }
            self.scanner?.cancel()
            let sc = SipScanner(client: client, module: self)
            self.scanner = sc
            sc.testCredentials(
                target: target, port: UInt16(port),
                ext: ext, username: username, password: password,
                transport: transport
            ) { result in
                promise.resolve(result)
            }
        }

        AsyncFunction("sendRaw") { (target: String, port: Int, message: String, transport: String, timeoutMs: Int, promise: Promise) in
            guard let client = self.client else {
                promise.reject("NO_CLIENT", "SIP client not initialized")
                return
            }
            guard let data = message.data(using: .utf8) else {
                promise.reject("BAD_MSG", "Invalid message encoding")
                return
            }
            // parse as a raw SIP request (first line = method uri version)
            let lines = message.components(separatedBy: "\r\n").isEmpty
                ? message.components(separatedBy: "\n")
                : message.components(separatedBy: "\r\n")
            guard let firstLine = lines.first else {
                promise.reject("BAD_MSG", "Empty message")
                return
            }
            let parts = firstLine.split(separator: " ", maxSplits: 2)
            let method = parts.count > 0 ? String(parts[0]) : "OPTIONS"
            let uri = parts.count > 1 ? String(parts[1]) : "sip:\(target)"

            var headers: [(String, String)] = []
            for line in lines.dropFirst() {
                if line.isEmpty { break }
                if let idx = line.firstIndex(of: ":") {
                    headers.append((
                        String(line[..<idx]).trimmingCharacters(in: .whitespaces),
                        String(line[line.index(after: idx)...]).trimmingCharacters(in: .whitespaces)
                    ))
                }
            }

            var req = SipRequest(method: method, uri: uri, headers: headers)
            client.send(request: req, to: target, port: UInt16(port), transport: transport, timeout: TimeInterval(timeoutMs) / 1000.0) { resp in
                if let resp = resp {
                    var headerDict: [String: String] = [:]
                    for (k, v) in resp.headers { headerDict[k] = v }
                    promise.resolve([
                        "statusCode": resp.statusCode,
                        "headers": headerDict,
                        "body": resp.rawText,
                    ] as [String: Any])
                } else {
                    promise.resolve([
                        "statusCode": 0,
                        "headers": [:] as [String: String],
                        "body": "No response (timeout)",
                    ] as [String: Any])
                }
            }
        }

        Function("cancelScan") {
            self.scanner?.cancel()
            self.scanner = nil
        }
    }

    // Event emitters
    func emitDevice(_ device: [String: Any]) {
        sendEvent("onDeviceFound", device)
    }

    func emitExtension(_ ext: [String: Any]) {
        sendEvent("onExtensionFound", ext)
    }

    func emitAuth(_ result: [String: Any]) {
        sendEvent("onAuthResult", result)
    }

    func emitProgress(phase: String, current: Int, total: Int, found: Int) {
        sendEvent("onProgress", [
            "phase": phase,
            "current": current,
            "total": total,
            "found": found,
        ])
    }

    func emitError(_ msg: String) {
        sendEvent("onError", ["message": msg])
    }
}
