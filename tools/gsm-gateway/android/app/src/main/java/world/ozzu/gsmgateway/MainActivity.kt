package world.ozzu.gsmgateway

import android.Manifest
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.*
import android.app.Activity
import android.util.Log

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
        }

        val title = TextView(this).apply {
            text = "Ozzu GSM Gateway"
            textSize = 24f
        }
        layout.addView(title)

        val status = TextView(this).apply {
            text = "Configure bridge connection and tap Start"
            textSize = 14f
            setPadding(0, 16, 0, 32)
        }
        layout.addView(status)

        // Bridge URL
        val bridgeLabel = TextView(this).apply { text = "Bridge URL:" }
        layout.addView(bridgeLabel)
        val bridgeInput = EditText(this).apply {
            setText(GatewayApp.bridgeUrl)
            hint = "http://10.9.0.1:3333"
        }
        layout.addView(bridgeInput)

        // Bridge Token
        val tokenLabel = TextView(this).apply { text = "Bridge Token:" }
        layout.addView(tokenLabel)
        val tokenInput = EditText(this).apply {
            setText(GatewayApp.bridgeToken)
            hint = "your-bridge-api-key"
        }
        layout.addView(tokenInput)

        // Asterisk Host
        val astLabel = TextView(this).apply { text = "Asterisk Host:" }
        layout.addView(astLabel)
        val astInput = EditText(this).apply {
            setText(GatewayApp.asteriskHost)
            hint = "10.9.0.1"
        }
        layout.addView(astInput)

        // Auto-answer toggle
        val autoAnswerCheck = CheckBox(this).apply {
            text = "Auto-answer incoming calls"
            isChecked = GatewayApp.autoAnswer
        }
        layout.addView(autoAnswerCheck)

        // Save + Start
        val startBtn = Button(this).apply {
            text = "Save & Start Gateway"
            setOnClickListener {
                GatewayApp.prefs.edit()
                    .putString("bridge_url", bridgeInput.text.toString())
                    .putString("bridge_token", tokenInput.text.toString())
                    .putString("asterisk_host", astInput.text.toString())
                    .putBoolean("auto_answer", autoAnswerCheck.isChecked)
                    .apply()

                val intent = Intent(this@MainActivity, SipBridgeService::class.java).apply {
                    action = "start"
                }
                startForegroundService(intent)
                status.text = "Gateway running — bridging calls to ${astInput.text}"
            }
        }
        layout.addView(startBtn)

        // Stop
        val stopBtn = Button(this).apply {
            text = "Stop Gateway"
            setOnClickListener {
                val intent = Intent(this@MainActivity, SipBridgeService::class.java).apply {
                    action = "stop"
                }
                startService(intent)
                status.text = "Gateway stopped"
            }
        }
        layout.addView(stopBtn)

        // Request call screening role
        val screenBtn = Button(this).apply {
            text = "Set as Call Screener"
            setOnClickListener {
                val rm = getSystemService(RoleManager::class.java)
                if (rm.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING)) {
                    startActivityForResult(
                        rm.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING),
                        1001
                    )
                } else {
                    status.text = "Call screening role not available on this device"
                }
            }
        }
        layout.addView(screenBtn)

        setContentView(layout)
        requestPermissions()
    }

    private fun requestPermissions() {
        val needed = arrayOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.ANSWER_PHONE_CALLS,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_CONTACTS,
        ).filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }

        if (needed.isNotEmpty()) {
            requestPermissions(needed.toTypedArray(), 1000)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 1001) {
            Log.i("OzzuGSM", "Call screening role result: $resultCode")
        }
    }
}
