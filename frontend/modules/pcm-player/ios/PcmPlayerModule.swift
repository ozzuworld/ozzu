import ExpoModulesCore
import AVFoundation
import UIKit

public class PcmPlayerModule: Module {
    private var engine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var playing = false
    private var recording = false
    private var audioConverter: AVAudioConverter?

    private let playbackFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true
    )!
    private let recordOutputFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true
    )!

    public func definition() -> ModuleDefinition {
        Name("PcmPlayer")

        Events("onMicData")

        // ── Device type detection ──

        Function("getDeviceType") { () -> String in
            switch UIDevice.current.userInterfaceIdiom {
            case .tv:
                return "tv"
            case .phone:
                return "phone"
            default:
                return "tablet"
            }
        }

        // ── Playback ──

        Function("startPlayback") {
            guard !self.playing else { return }
            self.configureAudioSession()

            if self.engine == nil {
                self.engine = AVAudioEngine()
            }
            guard let engine = self.engine else { return }

            let player = AVAudioPlayerNode()
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: self.playbackFormat)

            if !engine.isRunning {
                try engine.start()
            }
            player.play()

            self.playerNode = player
            self.playing = true
        }

        Function("writeAudio") { (base64Data: String) in
            guard self.playing,
                  let player = self.playerNode,
                  let data = Data(base64Encoded: base64Data) else { return }

            let frameCount = UInt32(data.count / 2) // Int16 = 2 bytes per sample
            guard let buffer = AVAudioPCMBuffer(
                pcmFormat: self.playbackFormat, frameCapacity: frameCount
            ) else { return }
            buffer.frameLength = frameCount

            data.withUnsafeBytes { rawBuf in
                if let src = rawBuf.baseAddress {
                    memcpy(buffer.int16ChannelData![0], src, data.count)
                }
            }

            player.scheduleBuffer(buffer)
        }

        Function("flushPlayback") {
            guard let player = self.playerNode else { return }
            player.stop()
            if self.playing {
                player.play()
            }
        }

        Function("stopPlayback") {
            self.playing = false
            self.playerNode?.stop()
            if let engine = self.engine, let player = self.playerNode {
                engine.detach(player)
            }
            self.playerNode = nil
            self.stopEngineIfIdle()
        }

        // ── Recording ──

        Function("startRecording") {
            guard !self.recording else { return }
            self.configureAudioSession()

            if self.engine == nil {
                self.engine = AVAudioEngine()
            }
            guard let engine = self.engine else { return }

            let inputNode = engine.inputNode
            let hwFormat = inputNode.outputFormat(forBus: 0)

            self.audioConverter = AVAudioConverter(from: hwFormat, to: self.recordOutputFormat)

            inputNode.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { [weak self] buffer, _ in
                guard let self = self, self.recording,
                      let converter = self.audioConverter else { return }

                let ratio = 16000.0 / hwFormat.sampleRate
                let outputFrameCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio)
                guard outputFrameCapacity > 0,
                      let outputBuffer = AVAudioPCMBuffer(
                          pcmFormat: self.recordOutputFormat, frameCapacity: outputFrameCapacity
                      ) else { return }

                var error: NSError?
                var hasProvidedInput = false
                let status = converter.convert(to: outputBuffer, error: &error) { _, outStatus in
                    if hasProvidedInput {
                        outStatus.pointee = .noDataNow
                        return nil
                    }
                    hasProvidedInput = true
                    outStatus.pointee = .haveData
                    return buffer
                }

                guard status != .error, error == nil, outputBuffer.frameLength > 0 else { return }

                let byteCount = Int(outputBuffer.frameLength) * 2
                let data = Data(bytes: outputBuffer.int16ChannelData![0], count: byteCount)
                let b64 = data.base64EncodedString()
                self.sendEvent("onMicData", ["data": b64])
            }

            if !engine.isRunning {
                try engine.start()
            }
            self.recording = true
        }

        Function("stopRecording") {
            self.recording = false
            self.engine?.inputNode.removeTap(onBus: 0)
            self.audioConverter = nil
            self.stopEngineIfIdle()
        }
    }

    // ── Helpers ──

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
            .playAndRecord, mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetooth]
        )
        try? session.setPreferredSampleRate(24000)
        try? session.setActive(true)
    }

    private func stopEngineIfIdle() {
        if !playing && !recording {
            engine?.stop()
            engine = nil
        }
    }
}
