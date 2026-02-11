package expo.modules.pcmplayer

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class PcmPlayerModule : Module() {
    private var audioTrack: AudioTrack? = null
    private var playQueue = LinkedBlockingQueue<ByteArray>()
    private var playThread: Thread? = null
    @Volatile private var playing = false

    private var audioRecord: AudioRecord? = null
    private var recordThread: Thread? = null
    @Volatile private var recording = false
    private var aec: AcousticEchoCanceler? = null

    override fun definition() = ModuleDefinition {
        Name("PcmPlayer")

        Events("onMicData")

        // ── Device type detection ──

        Function("getDeviceType") {
            val uiModeManager = appContext.reactContext?.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
            val mode = uiModeManager?.currentModeType ?: Configuration.UI_MODE_TYPE_NORMAL
            if (mode == Configuration.UI_MODE_TYPE_TELEVISION) "tv" else "tablet"
        }

        // ── Playback ──

        Function("startPlayback") {
            if (playing) return@Function null

            val sampleRate = 24000
            val bufferSize = AudioTrack.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )

            playQueue.clear()

            audioTrack = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(bufferSize * 4)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

            audioTrack?.play()
            playing = true

            playThread = Thread {
                while (playing) {
                    try {
                        val chunk = playQueue.poll(50, TimeUnit.MILLISECONDS)
                        if (chunk != null) {
                            audioTrack?.write(chunk, 0, chunk.size)
                        }
                    } catch (_: InterruptedException) {
                        break
                    }
                }
            }
            playThread?.start()
        }

        Function("writeAudio") { base64Data: String ->
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            playQueue.add(bytes)
        }

        Function("flushPlayback") {
            playQueue.clear()
        }

        Function("stopPlayback") {
            playing = false
            playQueue.clear()
            playThread?.interrupt()
            playThread = null
            audioTrack?.stop()
            audioTrack?.release()
            audioTrack = null
        }

        // ── Recording ──

        Function("startRecording") {
            if (recording) return@Function null

            val sampleRate = 16000 // Live API expects 16kHz input
            val bufferSize = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )

            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize * 2
            )

            // Attach acoustic echo canceler if available
            val sessionId = audioRecord?.audioSessionId ?: 0
            if (AcousticEchoCanceler.isAvailable()) {
                aec = AcousticEchoCanceler.create(sessionId)
                aec?.enabled = true
                Log.i("PcmPlayer", "AEC enabled, session=$sessionId")
            } else {
                Log.w("PcmPlayer", "AEC not available on this device")
            }

            audioRecord?.startRecording()
            recording = true

            recordThread = Thread {
                val buffer = ByteArray(bufferSize)
                while (recording) {
                    val read = audioRecord?.read(buffer, 0, buffer.size) ?: 0
                    if (read > 0) {
                        val b64 = Base64.encodeToString(
                            buffer.copyOf(read),
                            Base64.NO_WRAP
                        )
                        sendEvent("onMicData", mapOf("data" to b64))
                    }
                }
            }
            recordThread?.start()
        }

        Function("stopRecording") {
            recording = false
            recordThread?.interrupt()
            recordThread = null
            audioRecord?.stop()
            audioRecord?.release()
            audioRecord = null
            aec?.release()
            aec = null
        }
    }
}
