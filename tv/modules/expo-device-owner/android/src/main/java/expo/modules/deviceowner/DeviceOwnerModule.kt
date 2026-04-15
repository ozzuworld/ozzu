package expo.modules.deviceowner

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.InputStream
import java.net.URL

class DeviceOwnerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DeviceOwner")

    Function("isDeviceOwner") {
      val ctx = appContext.reactContext ?: return@Function false
      val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
      val componentName = ComponentName(ctx, DeviceAdminReceiver::class.java)
      dpm.isDeviceOwnerApp(ctx.packageName)
    }

    Function("getVersionCode") {
      val ctx = appContext.reactContext ?: return@Function 0
      try {
        val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        info.longVersionCode.toInt()
      } catch (e: PackageManager.NameNotFoundException) {
        0
      }
    }

    AsyncFunction("downloadAndInstall") { url: String ->
      val ctx = appContext.reactContext
        ?: throw Exception("React context not available")

      val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
      if (!dpm.isDeviceOwnerApp(ctx.packageName)) {
        throw Exception("App is not device owner — cannot silently install")
      }

      // Download APK to memory and stream into PackageInstaller
      val connection = URL(url).openConnection()
      connection.connectTimeout = 30_000
      connection.readTimeout = 120_000
      val inputStream: InputStream = connection.getInputStream()
      val apkBytes = inputStream.readBytes()
      inputStream.close()

      if (apkBytes.size < 100_000) {
        throw Exception("Downloaded APK too small (${apkBytes.size} bytes) — likely corrupt")
      }

      val installer = ctx.packageManager.packageInstaller
      val params = PackageInstaller.SessionParams(
        PackageInstaller.SessionParams.MODE_FULL_INSTALL
      )
      params.setSize(apkBytes.size.toLong())

      val sessionId = installer.createSession(params)
      val session = installer.openSession(sessionId)

      session.openWrite("ozzu-tv-update.apk", 0, apkBytes.size.toLong()).use { out ->
        out.write(apkBytes)
        session.fsync(out)
      }

      // Commit — silent install when device owner, no user prompt
      val intent = android.content.Intent(ctx, DeviceAdminReceiver::class.java)
      val pendingIntent = android.app.PendingIntent.getBroadcast(
        ctx, sessionId, intent,
        android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
      )
      session.commit(pendingIntent.intentSender)

      "Install initiated (${apkBytes.size} bytes)"
    }
  }
}
