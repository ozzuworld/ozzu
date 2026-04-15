package expo.modules.deviceowner

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent

/**
 * Minimal DeviceAdminReceiver — required for `dpm set-device-owner`.
 * No custom logic needed; the system uses this as the anchor for device owner privileges.
 */
class DeviceAdminReceiver : DeviceAdminReceiver() {
  override fun onEnabled(context: Context, intent: Intent) {}
  override fun onDisabled(context: Context, intent: Intent) {}
}
