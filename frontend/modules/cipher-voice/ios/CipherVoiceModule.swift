import ExpoModulesCore
import Speech
import AVFoundation
import UIKit

public class CipherVoiceModule: Module {
    // STT
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var audioEngine: AVAudioEngine?
    private var listening = false
    private var sttSilenceTimer: Timer?

    // TTS
    private var synthesizer: AVSpeechSynthesizer?
    private var ttsDelegate: TTSDelegate?
    private var selectedVoiceId: String = "com.apple.voice.premium.en-US.Evan"
    private var speaking = false

    // TTS audio capture: captures synthesized audio as PCM for relay to bridge
    private var captureSynthesizer: AVSpeechSynthesizer?

    public func definition() -> ModuleDefinition {
        Name("CipherVoice")

        Events(
            "onSttResult",
            "onSttError",
            "onTtsStarted",
            "onTtsAudio",
            "onTtsDone",
            "onTtsError"
        )

        // True only on iPhone — not tablet or TV
        Function("isAvailable") { () -> Bool in
            guard UIDevice.current.userInterfaceIdiom == .phone else { return false }
            guard SFSpeechRecognizer.authorizationStatus() != .denied else { return false }
            return true
        }

        // Request speech recognition + mic permissions
        AsyncFunction("requestPermissions") { (promise: Promise) in
            SFSpeechRecognizer.requestAuthorization { status in
                switch status {
                case .authorized:
                    AVAudioSession.sharedInstance().requestRecordPermission { granted in
                        promise.resolve(granted)
                    }
                default:
                    promise.resolve(false)
                }
            }
        }

        // Start on-device STT from mic
        AsyncFunction("startListening") { (promise: Promise) in
            guard !self.listening else {
                promise.resolve(true)
                return
            }

            // Check authorization
            guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
                self.sendEvent("onSttError", ["error": "Speech recognition not authorized"])
                promise.resolve(false)
                return
            }

            do {
                try self.startSTT()
                promise.resolve(true)
            } catch {
                self.sendEvent("onSttError", ["error": error.localizedDescription])
                promise.resolve(false)
            }
        }

        Function("stopListening") {
            self.stopSTT()
        }

        // Speak text via on-device TTS and capture audio for relay
        AsyncFunction("speak") { (text: String, promise: Promise) in
            guard !text.isEmpty else {
                promise.resolve(false)
                return
            }
            self.speakText(text)
            promise.resolve(true)
        }

        // Interrupt TTS mid-speech
        Function("interrupt") {
            self.interruptTTS()
        }

        // Set TTS voice identifier
        Function("setVoice") { (voiceId: String) in
            self.selectedVoiceId = voiceId
        }

        // List available premium/enhanced voices
        Function("getAvailableVoices") { () -> [[String: String]] in
            return AVSpeechSynthesisVoice.speechVoices()
                .filter { voice in
                    guard voice.language.starts(with: "en") else { return false }
                    if #available(iOS 16.0, *) {
                        return voice.quality != .default
                    }
                    return true
                }
                .map { voice in
                    var quality = "enhanced"
                    if #available(iOS 16.0, *) {
                        quality = voice.quality == .premium ? "premium" : "enhanced"
                    }
                    return [
                        "id": voice.identifier,
                        "name": voice.name,
                        "language": voice.language,
                        "quality": quality
                    ]
                }
        }
    }

    // MARK: - STT (SFSpeechRecognizer — on-device)

    private func startSTT() throws {
        stopSTT() // Clean up any existing session

        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
        recognizer.supportsOnDeviceRecognition = true
        self.speechRecognizer = recognizer

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true // Force on-device (A18 Pro Neural Engine)
        request.shouldReportPartialResults = true
        if #available(iOS 16.0, *) {
            request.addsPunctuation = true
        }
        // Custom vocabulary hints for ozzu-specific terms
        if #available(iOS 17.0, *) {
            request.customizedLanguageModel = nil // Could add custom LM later
        }
        self.recognitionRequest = request

        // Configure audio session for recording
        // Deactivate first to reset any TTS-held session, then reconfigure for STT
        let session = AVAudioSession.sharedInstance()
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        // Set up audio engine
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let hwFormat = inputNode.outputFormat(forBus: 0)

        // Guard against input node not ready (sampleRate 0 causes crash in installTap)
        guard hwFormat.sampleRate > 0 else {
            throw NSError(domain: "CipherVoice", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "Audio input not available (sampleRate=0)"])
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        engine.prepare()
        try engine.start()
        self.audioEngine = engine

        // Start recognition task
        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }

            if let result = result {
                let text = result.bestTranscription.formattedString
                let isFinal = result.isFinal
                self.sendEvent("onSttResult", [
                    "text": text,
                    "isFinal": isFinal
                ])

                if isFinal {
                    self.sttSilenceTimer?.invalidate()
                    self.sttSilenceTimer = nil
                    self.stopSTT()
                } else {
                    // On-device recognition may never produce isFinal=true.
                    // Reset a 1.5s silence timer — when no new partials arrive,
                    // call endAudio() to force the recognizer to finalize.
                    self.sttSilenceTimer?.invalidate()
                    DispatchQueue.main.async {
                        self.sttSilenceTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
                            self?.recognitionRequest?.endAudio()
                        }
                    }
                }
            }

            if let error = error as NSError? {
                // Error code 1110 = "No speech detected" — silence timeout
                // Must clean up so startListening() can be called again
                if error.code == 1110 {
                    self.stopSTT()
                    self.sendEvent("onSttError", ["error": "silence_timeout"])
                    return
                }
                // Error code 216 = request cancelled (we called stopSTT) — ignore
                if error.code == 216 {
                    return
                }
                self.sendEvent("onSttError", ["error": error.localizedDescription])
                self.stopSTT()
            }
        }

        self.listening = true
    }

    private func stopSTT() {
        listening = false
        sttSilenceTimer?.invalidate()
        sttSilenceTimer = nil
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        speechRecognizer = nil
    }

    // MARK: - TTS (AVSpeechSynthesizer — on-device with audio capture)

    private func speakText(_ text: String) {
        interruptTTS() // Stop any current speech

        let synth = AVSpeechSynthesizer()
        let delegate = TTSDelegate(module: self)
        synth.delegate = delegate
        self.synthesizer = synth
        self.ttsDelegate = delegate
        self.speaking = true

        let utterance = AVSpeechUtterance(string: text)

        // Voice fallback chain: selected (Evan) → Aaron premium → Evan enhanced → system default
        let fallbackIds = [
            selectedVoiceId,
            "com.apple.voice.premium.en-US.Aaron",
            "com.apple.voice.enhanced.en-US.Evan",
            "com.apple.voice.compact.en-US.Evan"
        ]
        utterance.voice = fallbackIds.lazy
            .compactMap { AVSpeechSynthesisVoice(identifier: $0) }
            .first ?? AVSpeechSynthesisVoice(language: "en-US")

        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.pitchMultiplier = 1.0
        utterance.volume = 1.0

        // Speak through device speaker (audible locally on iPhone)
        synth.speak(utterance)
        sendEvent("onTtsStarted", [:])

        // Capture TTS audio as PCM for relay to bridge → tablets
        // Uses write(_:toBufferCallback:) to get raw audio data
        let captSynth = AVSpeechSynthesizer()
        self.captureSynthesizer = captSynth

        let captureUtterance = AVSpeechUtterance(string: text)
        captureUtterance.voice = utterance.voice
        captureUtterance.rate = utterance.rate
        captureUtterance.pitchMultiplier = utterance.pitchMultiplier
        captureUtterance.volume = utterance.volume

        captSynth.write(captureUtterance) { [weak self] buffer in
            guard let self = self, self.speaking else { return }
            guard let pcmBuffer = buffer as? AVAudioPCMBuffer,
                  pcmBuffer.frameLength > 0 else { return }

            // Convert to 24kHz Int16 mono to match bridge audio format
            let targetFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!
            if let convertedData = self.convertBuffer(pcmBuffer, to: targetFormat) {
                let base64 = convertedData.base64EncodedString()
                self.sendEvent("onTtsAudio", ["data": base64])
            }
        }
    }

    private func interruptTTS() {
        if speaking {
            synthesizer?.stopSpeaking(at: .immediate)
            captureSynthesizer?.stopSpeaking(at: .immediate)
        }
        speaking = false
        synthesizer = nil
        ttsDelegate = nil
        captureSynthesizer = nil
    }

    // Convert AVAudioPCMBuffer to target format (24kHz Int16 mono)
    private func convertBuffer(_ source: AVAudioPCMBuffer, to targetFormat: AVAudioFormat) -> Data? {
        guard let converter = AVAudioConverter(from: source.format, to: targetFormat) else { return nil }

        let ratio = targetFormat.sampleRate / source.format.sampleRate
        let outputFrameCapacity = AVAudioFrameCount(Double(source.frameLength) * ratio) + 1
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputFrameCapacity) else { return nil }

        var error: NSError?
        var hasProvidedInput = false
        let status = converter.convert(to: outputBuffer, error: &error) { _, outStatus in
            if hasProvidedInput {
                outStatus.pointee = .noDataNow
                return nil
            }
            hasProvidedInput = true
            outStatus.pointee = .haveData
            return source
        }

        guard status != .error, error == nil, outputBuffer.frameLength > 0 else { return nil }

        let byteCount = Int(outputBuffer.frameLength) * 2 // Int16 = 2 bytes
        return Data(bytes: outputBuffer.int16ChannelData![0], count: byteCount)
    }

    // MARK: - TTS Delegate

    private class TTSDelegate: NSObject, AVSpeechSynthesizerDelegate {
        weak var module: CipherVoiceModule?

        init(module: CipherVoiceModule) {
            self.module = module
        }

        func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
            guard let module = self.module else { return }
            module.speaking = false
            module.captureSynthesizer?.stopSpeaking(at: .immediate)
            module.captureSynthesizer = nil
            module.sendEvent("onTtsDone", [:])
        }

        func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
            guard let module = self.module else { return }
            module.speaking = false
            module.captureSynthesizer?.stopSpeaking(at: .immediate)
            module.captureSynthesizer = nil
            module.sendEvent("onTtsDone", [:])
        }
    }
}
