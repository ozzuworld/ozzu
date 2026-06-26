package world.ozzu.gsmgateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Log.i("OzzuGSM", "Boot completed — starting gateway service")
            val serviceIntent = Intent(context, SipBridgeService::class.java).apply {
                action = "start"
            }
            context.startForegroundService(serviceIntent)
        }
    }
}
