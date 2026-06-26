import ExpoModulesCore
import Vision
import UIKit

public class CallImportModule: Module {
    public func definition() -> ModuleDefinition {
        Name("CallImport")

        AsyncFunction("extractNumbers") { (imageUri: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let image = self.loadImage(from: imageUri) else {
                    promise.reject("LOAD_FAIL", "Could not load image from \(imageUri)")
                    return
                }
                guard let cgImage = image.cgImage else {
                    promise.reject("CG_FAIL", "Could not get CGImage")
                    return
                }

                let request = VNRecognizeTextRequest { request, error in
                    if let error = error {
                        promise.reject("OCR_FAIL", error.localizedDescription)
                        return
                    }
                    guard let observations = request.results as? [VNRecognizedTextObservation] else {
                        promise.resolve([] as [[String: Any]])
                        return
                    }

                    var allText: [String] = []
                    for obs in observations {
                        if let top = obs.topCandidates(1).first {
                            allText.append(top.string)
                        }
                    }

                    let numbers = self.extractPhoneNumbers(from: allText)
                    promise.resolve(numbers)
                }

                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = false

                let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
                do {
                    try handler.perform([request])
                } catch {
                    promise.reject("VISION_FAIL", error.localizedDescription)
                }
            }
        }

        AsyncFunction("extractNumbersFromMultiple") { (imageUris: [String], promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                var allNumbers: [[String: Any]] = []
                var seen = Set<String>()

                for uri in imageUris {
                    guard let image = self.loadImage(from: uri),
                          let cgImage = image.cgImage else { continue }

                    let semaphore = DispatchSemaphore(value: 0)
                    let request = VNRecognizeTextRequest { request, _ in
                        defer { semaphore.signal() }
                        guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
                        var lines: [String] = []
                        for obs in observations {
                            if let top = obs.topCandidates(1).first {
                                lines.append(top.string)
                            }
                        }
                        let nums = self.extractPhoneNumbers(from: lines)
                        for n in nums {
                            if let num = n["number"] as? String, !seen.contains(num) {
                                seen.insert(num)
                                allNumbers.append(n)
                            }
                        }
                    }
                    request.recognitionLevel = .accurate
                    request.usesLanguageCorrection = false

                    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
                    try? handler.perform([request])
                    semaphore.wait()
                }

                promise.resolve(allNumbers)
            }
        }
    }

    private func loadImage(from uri: String) -> UIImage? {
        if uri.hasPrefix("file://") || uri.hasPrefix("/") {
            let path = uri.hasPrefix("file://") ? String(uri.dropFirst(7)) : uri
            return UIImage(contentsOfFile: path)
        }
        if let url = URL(string: uri), let data = try? Data(contentsOf: url) {
            return UIImage(data: data)
        }
        return nil
    }

    private func extractPhoneNumbers(from lines: [String]) -> [[String: Any]] {
        var results: [[String: Any]] = []
        var seen = Set<String>()

        let patterns: [NSRegularExpression] = [
            // +57 3XX XXX XXXX (Colombia mobile, various spacing)
            try! NSRegularExpression(pattern: #"\+?57[\s\-.]?3\d{2}[\s\-.]?\d{3}[\s\-.]?\d{4}"#),
            // +1 XXX XXX XXXX (US/Canada)
            try! NSRegularExpression(pattern: #"\+?1[\s\-.]?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}"#),
            // Generic international: +XX XXXXXXXXXX (8-15 digits after country code)
            try! NSRegularExpression(pattern: #"\+\d{1,3}[\s\-.]?\d{4,14}"#),
            // 10-digit local (no country code): 3XX XXX XXXX
            try! NSRegularExpression(pattern: #"\b3\d{2}[\s\-.]?\d{3}[\s\-.]?\d{4}\b"#),
            // General: any sequence of 7+ digits (possibly with separators)
            try! NSRegularExpression(pattern: #"\b\d[\d\s\-\.]{6,16}\d\b"#),
        ]

        let fullText = lines.joined(separator: "\n")

        for pattern in patterns {
            let matches = pattern.matches(in: fullText, range: NSRange(fullText.startIndex..., in: fullText))
            for match in matches {
                guard let range = Range(match.range, in: fullText) else { continue }
                let raw = String(fullText[range])
                let cleaned = raw.replacingOccurrences(of: "[^\\d+]", with: "", options: .regularExpression)

                guard cleaned.count >= 7 && cleaned.count <= 16 else { continue }
                // skip if it looks like a date/time (4 digits like 1234, 2026, etc.)
                if cleaned.count <= 8 && !cleaned.hasPrefix("+") && !cleaned.hasPrefix("3") { continue }

                let normalized: String
                if cleaned.hasPrefix("+") {
                    normalized = cleaned
                } else if cleaned.count == 10 && cleaned.hasPrefix("3") {
                    normalized = "+57" + cleaned // Colombian mobile
                } else if cleaned.count == 10 {
                    normalized = "+1" + cleaned // US assumption
                } else {
                    normalized = "+" + cleaned
                }

                if seen.contains(normalized) { continue }
                seen.insert(normalized)

                results.append([
                    "number": normalized,
                    "raw": raw,
                    "digits": cleaned.count,
                ])
            }
        }

        return results
    }
}
