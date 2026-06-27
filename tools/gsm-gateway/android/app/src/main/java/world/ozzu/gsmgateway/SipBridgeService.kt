package world.ozzu.gsmgateway

import android.app.*
import android.content.Context
import android.content.Intent
import android.media.*
import android.os.IBinder
import android.telephony.PhoneStateListener
import android.telephony.TelephonyManager
import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlin.concurrent.thread

class SipBridgeService : Service() {
    companion object {
        const val NOTIF_CHANNEL = "gsm_gateway"
        const val NOTIF_ID = 1001
        const val SAMPLE_RATE = 8000
        const val RTP_PAYLOAD_ULAW = 0
        const val SIP_PORT = 5060
    }

    private var bridging = false
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private var rtpSocket: DatagramSocket? = null
    private var sipSocket: DatagramSocket? = null
    private var captureThread: Thread? = null
    private var playbackThread: Thread? = null
    private var phoneListener: PhoneStateListener? = null
    private var lastCallState = TelephonyManager.CALL_STATE_IDLE
    private var incomingNumber: String? = null

    private var sipCallId: String? = null
    private var sipFromTag: String? = null
    private var sipToTag: String? = null
    private var sipViaBranch: String? = null
    private var remoteRtpPort: Int = 0
    private var localRtpPort: Int = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForegroundNotification()
        registerPhoneListener()
        Log.i("OzzuGSM", "SipBridgeService created — SBC mode, listening for calls")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    private fun startForegroundNotification() {
        val notification = Notification.Builder(this, NOTIF_CHANNEL)
            .setContentTitle("Ozzu GSM Gateway")
            .setContentText("Monitoring incoming calls")
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .build()
        startForeground(NOTIF_ID, notification)
    }

    @Suppress("deprecation")
    private fun registerPhoneListener() {
        val tm = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        phoneListener = object : PhoneStateListener() {
            override fun onCallStateChanged(state: Int, number: String?) {
                handleCallState(state, number)
            }
        }
        tm.listen(phoneListener, PhoneStateListener.LISTEN_CALL_STATE)
        Log.i("OzzuGSM", "PhoneStateListener registered")
    }

    private fun handleCallState(state: Int, number: String?) {
        when (state) {
            TelephonyManager.CALL_STATE_RINGING -> {
                incomingNumber = number
                Log.i("OzzuGSM", "RINGING — incoming call from: $number")

                if (!number.isNullOrEmpty()) {
                    thread { notifyBridge(number) }
                }

                if (GatewayApp.autoAnswer) {
                    thread {
                        Thread.sleep(1500)
                        answerCall()
                    }
                }
            }
            TelephonyManager.CALL_STATE_OFFHOOK -> {
                if (lastCallState == TelephonyManager.CALL_STATE_RINGING) {
                    Log.i("OzzuGSM", "OFFHOOK — call answered, starting SBC bridge for: $incomingNumber")
                    startBridge()
                } else {
                    Log.i("OzzuGSM", "OFFHOOK — outgoing call, ignoring")
                }
            }
            TelephonyManager.CALL_STATE_IDLE -> {
                if (bridging) {
                    Log.i("OzzuGSM", "IDLE — call ended, sending BYE + stopping bridge")
                    thread { sendSipBye() }
                    stopBridge()
                }
                incomingNumber = null
            }
        }
        lastCallState = state
    }

    @Suppress("MissingPermission")
    private fun answerCall() {
        try {
            val tm = getSystemService(Context.TELECOM_SERVICE) as android.telecom.TelecomManager
            tm.acceptRingingCall()
            Log.i("OzzuGSM", "Auto-answered via TelecomManager")
        } catch (e: Exception) {
            Log.e("OzzuGSM", "Auto-answer failed: ${e.message}")
        }
    }

    private fun startBridge() {
        if (bridging) return
        bridging = true

        updateNotification("Bridging call to Asterisk")

        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        am.isSpeakerphoneOn = true
        Log.i("OzzuGSM", "Audio routed to speakerphone for VOICE_CALL capture")

        thread(name = "sip-invite") {
            try {
                rtpSocket = DatagramSocket(0)
                localRtpPort = rtpSocket!!.localPort
                Log.i("OzzuGSM", "RTP socket bound to local port $localRtpPort")

                sipSocket = DatagramSocket()

                val asteriskAddr = InetAddress.getByName(GatewayApp.asteriskHost)
                remoteRtpPort = sendSipInvite(asteriskAddr)

                if (remoteRtpPort > 0) {
                    Log.i("OzzuGSM", "SIP INVITE accepted — Asterisk RTP on port $remoteRtpPort")
                    startCapture(asteriskAddr, remoteRtpPort)
                    startPlayback()
                    Log.i("OzzuGSM", "Audio bridge started — RTP to ${GatewayApp.asteriskHost}:$remoteRtpPort")
                } else {
                    Log.e("OzzuGSM", "SIP INVITE failed — no RTP port from Asterisk")
                    bridging = false
                }
            } catch (e: Exception) {
                Log.e("OzzuGSM", "Bridge start error: ${e.message}")
                bridging = false
            }
        }
    }

    private fun sendSipInvite(asteriskAddr: InetAddress): Int {
        sipCallId = UUID.randomUUID().toString()
        sipFromTag = UUID.randomUUID().toString().take(8)
        sipViaBranch = "z9hG4bK-${UUID.randomUUID().toString().take(12)}"

        sipSocket!!.connect(asteriskAddr, SIP_PORT)
        val localIp = sipSocket!!.localAddress.hostAddress
        val caller = incomingNumber ?: "unknown"
        val user = GatewayApp.sipUser
        val asteriskHost = GatewayApp.asteriskHost
        val sipLocalPort = sipSocket!!.localPort

        val CR = "\r\n"
        val sdp = "v=0${CR}" +
            "o=$user 0 0 IN IP4 $localIp${CR}" +
            "s=OzzuGSM${CR}" +
            "c=IN IP4 $localIp${CR}" +
            "t=0 0${CR}" +
            "m=audio $localRtpPort RTP/AVP 0${CR}" +
            "a=rtpmap:0 PCMU/8000${CR}" +
            "a=sendrecv${CR}" +
            "a=ptime:20${CR}"

        val finalInvite = "INVITE sip:incoming@$asteriskHost SIP/2.0${CR}" +
            "Via: SIP/2.0/UDP $localIp:$sipLocalPort;branch=$sipViaBranch;rport${CR}" +
            "Max-Forwards: 70${CR}" +
            "From: \"$caller\" <sip:$caller@$localIp>;tag=$sipFromTag${CR}" +
            "To: <sip:incoming@$asteriskHost>${CR}" +
            "Call-ID: $sipCallId${CR}" +
            "CSeq: 1 INVITE${CR}" +
            "Contact: <sip:$user@$localIp:$sipLocalPort>${CR}" +
            "Content-Type: application/sdp${CR}" +
            "Allow: INVITE,ACK,BYE,CANCEL${CR}" +
            "User-Agent: OzzuGSM-SBC/1.0${CR}" +
            "Content-Length: ${sdp.length}${CR}" +
            CR +
            sdp

        Log.i("OzzuGSM", "Sending SIP INVITE to $asteriskHost:$SIP_PORT (CallerID: $caller, RTP: $localRtpPort)")

        val sendBuf = finalInvite.toByteArray()
        sipSocket?.send(DatagramPacket(sendBuf, sendBuf.size, asteriskAddr, SIP_PORT))

        val recvBuf = ByteArray(4096)
        sipSocket?.soTimeout = 10000
        var rtpPort = 0

        repeat(10) {
            try {
                val pkt = DatagramPacket(recvBuf, recvBuf.size)
                sipSocket?.receive(pkt)
                val response = String(recvBuf, 0, pkt.length)
                val statusLine = response.lines().firstOrNull() ?: ""
                Log.i("OzzuGSM", "SIP response: $statusLine")

                if (statusLine.contains("100 ") || statusLine.contains("180 ")) {
                    return@repeat
                }

                if (statusLine.contains("200 ")) {
                    val toHeader = response.lines().find { it.startsWith("To:", ignoreCase = true) } ?: ""
                    val tagMatch = Regex("tag=([^;\\s]+)").find(toHeader)
                    sipToTag = tagMatch?.groupValues?.get(1)

                    val mLine = response.lines().find { it.startsWith("m=audio") }
                    if (mLine != null) {
                        rtpPort = mLine.split(" ")[1].toIntOrNull() ?: 0
                    }

                    sendSipAck(asteriskAddr)
                    return rtpPort
                }

                if (statusLine.contains("401 ") || statusLine.contains("407 ")) {
                    Log.e("OzzuGSM", "Asterisk requires auth — configure as trusted trunk")
                    return 0
                }
            } catch (e: Exception) {
                Log.e("OzzuGSM", "SIP receive timeout: ${e.message}")
                return 0
            }
        }
        return rtpPort
    }

    private fun sendSipAck(asteriskAddr: InetAddress) {
        val localIp = sipSocket?.localAddress?.hostAddress ?: return
        val sipLocalPort = sipSocket?.localPort ?: return
        val asteriskHost = GatewayApp.asteriskHost
        val caller = incomingNumber ?: "unknown"
        val toTag = if (sipToTag != null) ";tag=$sipToTag" else ""
        val CR = "\r\n"

        val ack = "ACK sip:incoming@$asteriskHost SIP/2.0${CR}" +
            "Via: SIP/2.0/UDP $localIp:$sipLocalPort;branch=${sipViaBranch}-ack;rport${CR}" +
            "Max-Forwards: 70${CR}" +
            "From: \"$caller\" <sip:$caller@$localIp>;tag=$sipFromTag${CR}" +
            "To: <sip:incoming@$asteriskHost>$toTag${CR}" +
            "Call-ID: $sipCallId${CR}" +
            "CSeq: 1 ACK${CR}" +
            "Content-Length: 0${CR}" +
            CR

        val buf = ack.toByteArray()
        sipSocket?.send(DatagramPacket(buf, buf.size, asteriskAddr, SIP_PORT))
        Log.i("OzzuGSM", "SIP ACK sent")
    }

    private fun sendSipBye() {
        if (sipCallId == null || sipSocket == null) return
        try {
            val asteriskAddr = InetAddress.getByName(GatewayApp.asteriskHost)
            val localIp = sipSocket?.localAddress?.hostAddress ?: return
            val sipLocalPort = sipSocket?.localPort ?: return
            val asteriskHost = GatewayApp.asteriskHost
            val caller = incomingNumber ?: "unknown"
            val toTag = if (sipToTag != null) ";tag=$sipToTag" else ""
            val byeBranch = "z9hG4bK-bye-${UUID.randomUUID().toString().take(8)}"
            val CR = "\r\n"

            val bye = "BYE sip:incoming@$asteriskHost SIP/2.0${CR}" +
                "Via: SIP/2.0/UDP $localIp:$sipLocalPort;branch=$byeBranch;rport${CR}" +
                "Max-Forwards: 70${CR}" +
                "From: \"$caller\" <sip:$caller@$localIp>;tag=$sipFromTag${CR}" +
                "To: <sip:incoming@$asteriskHost>$toTag${CR}" +
                "Call-ID: $sipCallId${CR}" +
                "CSeq: 2 BYE${CR}" +
                "Content-Length: 0${CR}" +
                CR

            val buf = bye.toByteArray()
            sipSocket?.send(DatagramPacket(buf, buf.size, asteriskAddr, SIP_PORT))
            Log.i("OzzuGSM", "SIP BYE sent")
        } catch (e: Exception) {
            Log.e("OzzuGSM", "SIP BYE error: ${e.message}")
        }
    }

    private fun startCapture(asteriskAddr: InetAddress, rtpPort: Int) {
        captureThread = thread(name = "rtp-capture") {
            try {
                val bufSize = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
                )
                val source = try {
                    val ar = AudioRecord(
                        MediaRecorder.AudioSource.VOICE_CALL, SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize
                    )
                    if (ar.state == AudioRecord.STATE_INITIALIZED) {
                        Log.i("OzzuGSM", "Using VOICE_CALL audio source")
                        ar
                    } else { ar.release(); null }
                } catch (e: Exception) { null }

                val voiceComm = if (source == null) try {
                    val ar = AudioRecord(
                        MediaRecorder.AudioSource.VOICE_COMMUNICATION, SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize
                    )
                    if (ar.state == AudioRecord.STATE_INITIALIZED) {
                        Log.i("OzzuGSM", "Using VOICE_COMMUNICATION audio source")
                        ar
                    } else { ar.release(); null }
                } catch (e: Exception) { null } else null

                audioRecord = source ?: voiceComm ?: AudioRecord(
                    MediaRecorder.AudioSource.MIC, SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize
                ).also { Log.i("OzzuGSM", "Falling back to MIC audio source (local side only)") }

                audioRecord?.startRecording()
                val buf = ByteArray(160)
                val pcmBuf = ShortArray(160)
                var seq = 0
                var ts = 0

                while (bridging) {
                    val read = audioRecord?.read(pcmBuf, 0, 160) ?: -1
                    if (read <= 0) continue

                    for (i in 0 until read) { buf[i] = pcm16ToUlaw(pcmBuf[i]) }

                    val rtpPacket = ByteArray(12 + read)
                    rtpPacket[0] = 0x80.toByte()
                    rtpPacket[1] = RTP_PAYLOAD_ULAW.toByte()
                    rtpPacket[2] = (seq shr 8).toByte()
                    rtpPacket[3] = seq.toByte()
                    rtpPacket[4] = (ts shr 24).toByte()
                    rtpPacket[5] = (ts shr 16).toByte()
                    rtpPacket[6] = (ts shr 8).toByte()
                    rtpPacket[7] = ts.toByte()
                    rtpPacket[8] = 0x4F; rtpPacket[9] = 0x5A; rtpPacket[10] = 0x5A; rtpPacket[11] = 0x55

                    System.arraycopy(buf, 0, rtpPacket, 12, read)
                    rtpSocket?.send(DatagramPacket(rtpPacket, rtpPacket.size, asteriskAddr, rtpPort))

                    seq = (seq + 1) and 0xFFFF
                    ts += read
                }
            } catch (e: Exception) {
                Log.e("OzzuGSM", "Capture error: ${e.message}")
            }
        }
    }

    private fun startPlayback() {
        playbackThread = thread(name = "rtp-playback") {
            try {
                val bufSize = AudioTrack.getMinBufferSize(
                    SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
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

                while (bridging) {
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
    }

    private fun stopBridge() {
        bridging = false
        try {
            if (audioRecord?.state == AudioRecord.STATE_INITIALIZED) audioRecord?.stop()
        } catch (_: Exception) {}
        audioRecord?.release()
        audioRecord = null
        try {
            if (audioTrack?.playState == AudioTrack.PLAYSTATE_PLAYING) audioTrack?.stop()
        } catch (_: Exception) {}
        audioTrack?.release()
        audioTrack = null
        rtpSocket?.close()
        rtpSocket = null
        sipSocket?.close()
        sipSocket = null
        sipCallId = null
        sipFromTag = null
        sipToTag = null
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.isSpeakerphoneOn = false
            am.mode = AudioManager.MODE_NORMAL
        } catch (_: Exception) {}
        updateNotification("Monitoring incoming calls")
        Log.i("OzzuGSM", "Audio bridge stopped")
    }

    @Suppress("deprecation")
    override fun onDestroy() {
        bridging = false
        val tm = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        phoneListener?.let { tm.listen(it, PhoneStateListener.LISTEN_NONE) }
        stopBridge()
        super.onDestroy()
        Log.i("OzzuGSM", "SipBridgeService destroyed")
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            NOTIF_CHANNEL, "GSM Gateway", NotificationManager.IMPORTANCE_LOW
        )
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(channel)
    }

    private fun updateNotification(text: String) {
        val notification = Notification.Builder(this, NOTIF_CHANNEL)
            .setContentTitle("Ozzu GSM Gateway")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .build()
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIF_ID, notification)
    }

    private fun notifyBridge(number: String) {
        try {
            val url = URL("${GatewayApp.bridgeUrl}/soc/calls/incoming")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer ${GatewayApp.bridgeToken}")
            conn.doOutput = true
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            val body = """{"phone_number":"$number","direction":"incoming","source":"cat-gsm-gateway"}"""
            conn.outputStream.write(body.toByteArray())
            conn.outputStream.flush()
            val code = conn.responseCode
            Log.i("OzzuGSM", "Bridge notified: $number → HTTP $code")
            conn.disconnect()
        } catch (e: Exception) {
            Log.e("OzzuGSM", "Bridge notify error: ${e.message}")
        }
    }

    private fun pcm16ToUlaw(sample: Short): Byte {
        val s = sample.toInt()
        val sign = if (s < 0) 0x80 else 0
        var magnitude = if (s < 0) -s else s
        magnitude = minOf(magnitude, 32635) + 0x84
        val exponent = when {
            magnitude <= 0xFF -> 0; magnitude <= 0x1FF -> 1
            magnitude <= 0x3FF -> 2; magnitude <= 0x7FF -> 3
            magnitude <= 0xFFF -> 4; magnitude <= 0x1FFF -> 5
            magnitude <= 0x3FFF -> 6; else -> 7
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
