package world.ozzu.gsmgateway

import android.telecom.Call
import android.telecom.CallScreeningService
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class OzzuCallScreeningService : CallScreeningService() {

    override fun onScreenCall(callDetails: Call.Details) {
        val number = callDetails.handle?.schemeSpecificPart ?: "unknown"
        val direction = if (callDetails.callDirection == Call.Details.DIRECTION_INCOMING) "incoming" else "outgoing"

        Log.i("OzzuGSM", "Call screening: $number ($direction)")

        // Notify bridge immediately
        thread {
            notifyBridge(number, direction)
        }

        if (direction == "incoming" && GatewayApp.autoAnswer) {
            // Allow the call through (auto-answer happens in SipBridgeService)
            val response = CallResponse.Builder()
                .setDisallowCall(false)
                .setSkipCallLog(false)
                .setSkipNotification(false)
                .setSilenceCall(false)
                .build()
            respondToCall(callDetails, response)
        } else {
            val response = CallResponse.Builder()
                .setDisallowCall(false)
                .build()
            respondToCall(callDetails, response)
        }
    }

    private fun notifyBridge(number: String, direction: String) {
        try {
            val url = URL("${GatewayApp.bridgeUrl}/soc/calls/number")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer ${GatewayApp.bridgeToken}")
            conn.doOutput = true
            conn.connectTimeout = 5000
            conn.readTimeout = 5000

            val body = """{"phone_number":"$number","direction":"$direction","label":"cat-gsm-gateway"}"""
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
