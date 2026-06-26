package world.ozzu.gsmgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telecom.TelecomManager
import android.telephony.TelephonyManager
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class CallReceiver : BroadcastReceiver() {
    companion object {
        private var lastState = TelephonyManager.CALL_STATE_IDLE
        private var incomingNumber: String? = null
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return

        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
        val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)

        when (state) {
            TelephonyManager.EXTRA_STATE_RINGING -> {
                incomingNumber = number
                Log.i("OzzuGSM", "Incoming call: $number")

                // Notify bridge
                if (number != null) {
                    thread { notifyBridge(number) }
                }

                // Auto-answer if enabled
                if (GatewayApp.autoAnswer && number != null) {
                    thread {
                        Thread.sleep(500) // Brief delay for ring to register
                        answerCall(context)
                    }
                }
            }
            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                if (lastState == TelephonyManager.CALL_STATE_RINGING) {
                    Log.i("OzzuGSM", "Call answered: $incomingNumber")
                    // Start SIP bridge service to forward audio
                    val serviceIntent = Intent(context, SipBridgeService::class.java).apply {
                        action = "start"
                    }
                    context.startForegroundService(serviceIntent)
                }
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                if (lastState == TelephonyManager.CALL_STATE_OFFHOOK) {
                    Log.i("OzzuGSM", "Call ended: $incomingNumber")
                    // Stop SIP bridge
                    val serviceIntent = Intent(context, SipBridgeService::class.java).apply {
                        action = "stop"
                    }
                    context.startService(serviceIntent)
                }
                incomingNumber = null
            }
        }

        lastState = when (state) {
            TelephonyManager.EXTRA_STATE_RINGING -> TelephonyManager.CALL_STATE_RINGING
            TelephonyManager.EXTRA_STATE_OFFHOOK -> TelephonyManager.CALL_STATE_OFFHOOK
            else -> TelephonyManager.CALL_STATE_IDLE
        }
    }

    @Suppress("MissingPermission")
    private fun answerCall(context: Context) {
        try {
            val tm = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
            tm.acceptRingingCall()
            Log.i("OzzuGSM", "Auto-answered via TelecomManager")
        } catch (e: Exception) {
            Log.e("OzzuGSM", "Auto-answer failed: ${e.message}")
        }
    }

    private fun notifyBridge(number: String) {
        try {
            val url = URL("${GatewayApp.bridgeUrl}/soc/calls/number")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer ${GatewayApp.bridgeToken}")
            conn.doOutput = true
            conn.connectTimeout = 5000
            conn.readTimeout = 5000

            val body = """{"phone_number":"$number","direction":"incoming","label":"cat-gsm-gateway"}"""
            conn.outputStream.write(body.toByteArray())
            conn.outputStream.flush()
            val code = conn.responseCode
            Log.i("OzzuGSM", "Bridge notified: $number → HTTP $code")
            conn.disconnect()
        } catch (e: Exception) {
            Log.e("OzzuGSM", "Bridge notify failed: ${e.message}")
        }
    }
}
