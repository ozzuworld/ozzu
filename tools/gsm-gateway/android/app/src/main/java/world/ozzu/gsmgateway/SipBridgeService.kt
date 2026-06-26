package world.ozzu.gsmgateway

import android.app.*
import android.content.Context
import android.content.Intent
import android.media.*
import android.os.IBinder
import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import kotlin.concurrent.thread

class SipBridgeService : Service() {
    companion object {
        const val NOTIF_CHANNEL = "gsm_gateway"
        const val NOTIF_ID = 1001
        const val RTP_PORT = 16384
        const val SAMPLE_RATE = 8000
        const val RTP_PAYLOAD_ULAW = 0
    }

    private var running = false
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private var rtpSocket: DatagramSocket? = null
    private var captureThread: Thread? = null
    private var playbackThread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: "start"
        when (action) {
            "start" -> startBridge()
            "stop" -> stopBridge()
        }
        return START_STICKY
    }

    private fun startBridge() {
        if (running) return
        running = true

        val notification = Notification.Builder(this, NOTIF_CHANNEL)
            .setContentTitle("Ozzu GSM Gateway")
            .setContentText("Bridging calls to Asterisk")
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .build()
        startForeground(NOTIF_ID, notification)

        // RTP socket
        rtpSocket = DatagramSocket(RTP_PORT)

        // Audio capture (call audio → RTP → Asterisk)
        captureThread = thread(name = "rtp-capture") {
            try {
                val bufSize = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT
                )
                // Try VOICE_CALL source first (captures both sides), fall back to MIC
                val source = try {
                    val ar = AudioRecord(
                        MediaRecorder.AudioSource.VOICE_CALL,
                        SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                        bufSize
                    )
                    if (ar.state == AudioRecord.STATE_INITIALIZED) {
                        Log.i("OzzuGSM", "Using VOICE_CALL audio source (captures both sides)")
                        ar
                    } else {
                        ar.release()
                        null
                    }
                } catch (e: Exception) { null }

                audioRecord = source ?: AudioRecord(
                    MediaRecorder.AudioSource.MIC,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufSize
                ).also {
                    Log.i("OzzuGSM", "Falling back to MIC audio source (local side only)")
                }

                audioRecord?.startRecording()
                val buf = ByteArray(160) // 20ms of G.711 ulaw = 160 bytes
                val pcmBuf = ShortArray(160)
                val asteriskAddr = InetAddress.getByName(GatewayApp.asteriskHost)
                var seq = 0
                var ts = 0

                while (running) {
                    val read = audioRecord?.read(pcmBuf, 0, 160) ?: -1
                    if (read <= 0) continue

                    // PCM 16-bit → G.711 µ-law
                    for (i in 0 until read) {
                        buf[i] = pcm16ToUlaw(pcmBuf[i])
                    }

                    // RTP header (12 bytes) + payload
                    val rtpPacket = ByteArray(12 + read)
                    rtpPacket[0] = 0x80.toByte() // V=2
                    rtpPacket[1] = RTP_PAYLOAD_ULAW.toByte()
                    rtpPacket[2] = (seq shr 8).toByte()
                    rtpPacket[3] = seq.toByte()
                    rtpPacket[4] = (ts shr 24).toByte()
                    rtpPacket[5] = (ts shr 16).toByte()
                    rtpPacket[6] = (ts shr 8).toByte()
                    rtpPacket[7] = ts.toByte()
                    // SSRC = 0x4F5A5A55 ("OZZU")
                    rtpPacket[8] = 0x4F; rtpPacket[9] = 0x5A; rtpPacket[10] = 0x5A; rtpPacket[11] = 0x55

                    System.arraycopy(buf, 0, rtpPacket, 12, read)
                    val packet = DatagramPacket(rtpPacket, rtpPacket.size, asteriskAddr, RTP_PORT)
                    rtpSocket?.send(packet)

                    seq = (seq + 1) and 0xFFFF
                    ts += read
                }
            } catch (e: Exception) {
                Log.e("OzzuGSM", "Capture error: ${e.message}")
            }
        }

        // Audio playback (Asterisk RTP → speaker/earpiece)
        playbackThread = thread(name = "rtp-playback") {
            try {
                val bufSize = AudioTrack.getMinBufferSize(
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_OUT_MONO,
                    AudioFormat.ENCODING_PCM_16BIT
                )
                audioTrack = AudioTrack.Builder()
                    .setAudioAttributes(AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                    .setAudioFormat(AudioFormat.Builder()
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build())
                    .setBufferSizeInBytes(bufSize)
                    .build()

                audioTrack?.play()
                val recvBuf = ByteArray(1500)
                val pcmOut = ShortArray(160)

                while (running) {
                    val packet = DatagramPacket(recvBuf, recvBuf.size)
                    rtpSocket?.receive(packet)

                    if (packet.length > 12) {
                        val payloadLen = packet.length - 12
                        for (i in 0 until minOf(payloadLen, 160)) {
                            pcmOut[i] = ulawToPcm16(recvBuf[12 + i])
                        }
                        audioTrack?.write(pcmOut, 0, minOf(payloadLen, 160))
                    }
                }
            } catch (e: Exception) {
                Log.e("OzzuGSM", "Playback error: ${e.message}")
            }
        }

        Log.i("OzzuGSM", "SIP bridge started")
    }

    private fun stopBridge() {
        running = false
        audioRecord?.stop()
        audioRecord?.release()
        audioTrack?.stop()
        audioTrack?.release()
        rtpSocket?.close()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        Log.i("OzzuGSM", "SIP bridge stopped")
    }

    override fun onDestroy() {
        stopBridge()
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            NOTIF_CHANNEL,
            "GSM Gateway",
            NotificationManager.IMPORTANCE_LOW
        )
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(channel)
    }

    // G.711 µ-law encoding/decoding
    private fun pcm16ToUlaw(sample: Short): Byte {
        val sign: Int
        var magnitude: Int
        val s = sample.toInt()
        sign = if (s < 0) 0x80 else 0
        magnitude = if (s < 0) -s else s
        magnitude = minOf(magnitude, 32635)
        magnitude += 0x84

        val exponent = when {
            magnitude <= 0xFF -> 0
            magnitude <= 0x1FF -> 1
            magnitude <= 0x3FF -> 2
            magnitude <= 0x7FF -> 3
            magnitude <= 0xFFF -> 4
            magnitude <= 0x1FFF -> 5
            magnitude <= 0x3FFF -> 6
            else -> 7
        }
        val mantissa = (magnitude shr (exponent + 3)) and 0x0F
        return (sign or (exponent shl 4) or mantissa).inv().toByte()
    }

    private fun ulawToPcm16(ulaw: Byte): Short {
        val u = (ulaw.toInt() and 0xFF).inv()
        val sign = u and 0x80
        val exponent = (u shr 4) and 0x07
        val mantissa = u and 0x0F
        var magnitude = ((mantissa shl 4) + 0x08) shl exponent
        magnitude -= 0x84
        return if (sign != 0) (-magnitude).toShort() else magnitude.toShort()
    }
}
