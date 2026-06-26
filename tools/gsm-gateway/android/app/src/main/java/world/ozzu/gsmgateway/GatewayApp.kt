package world.ozzu.gsmgateway

import android.app.Application
import android.content.SharedPreferences

class GatewayApp : Application() {
    companion object {
        lateinit var prefs: SharedPreferences
            private set

        val bridgeUrl: String get() = prefs.getString("bridge_url", "http://10.9.0.1:3333") ?: "http://10.9.0.1:3333"
        val bridgeToken: String get() = prefs.getString("bridge_token", "") ?: ""
        val asteriskHost: String get() = prefs.getString("asterisk_host", "10.9.0.1") ?: "10.9.0.1"
        val sipUser: String get() = prefs.getString("sip_user", "cat-gateway") ?: "cat-gateway"
        val sipPass: String get() = prefs.getString("sip_pass", "ozzu-gsm-2026") ?: "ozzu-gsm-2026"
        val autoAnswer: Boolean get() = prefs.getBoolean("auto_answer", true)
    }

    override fun onCreate() {
        super.onCreate()
        prefs = getSharedPreferences("gsm_gateway", MODE_PRIVATE)
    }
}
