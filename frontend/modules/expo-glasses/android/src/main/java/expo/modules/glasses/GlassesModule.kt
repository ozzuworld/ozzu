package expo.modules.glasses

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.Build
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

/**
 * GlassesModule — Expo native module wrapping Meta's Wearables DAT SDK (Android).
 *
 * When the actual DAT SDK is available (mwdat-core + mwdat-camera dependencies),
 * uncomment the SDK imports and implementation blocks. The module currently
 * provides the full API surface with stub implementations so the JS layer
 * and Glasses screen can be built and tested without the SDK present.
 *
 * SDK imports (uncomment when available):
 * import com.meta.wearable.Wearables
 * import com.meta.wearable.camera.StreamConfiguration
 * import com.meta.wearable.camera.StreamSession
 * import com.meta.wearable.camera.VideoFrame
 * import com.meta.wearable.device.AutoDeviceSelector
 */

class GlassesModule : Module() {
    companion object {
        private const val TAG = "ExpoGlasses"
        private const val JPEG_QUALITY = 60
        private const val DEFAULT_FRAME_RATE = 15
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var registrationJob: Job? = null
    private var devicesJob: Job? = null
    private var videoJob: Job? = null
    private var stateJob: Job? = null

    // SDK objects (uncomment with real SDK):
    // private var streamSession: StreamSession? = null

    @Volatile
    private var connectionState: String = "disconnected"
    @Volatile
    private var streaming: Boolean = false
    @Volatile
    private var initialized: Boolean = false

    override fun definition() = ModuleDefinition {
        Name("ExpoGlasses")

        Events(
            "onConnectionChanged",
            "onVideoFrame",
            "onPhotoCaptured",
            "onStreamStateChanged",
            "onError"
        )

        // ── Availability check ──

        Function("isAvailable") {
            // DAT SDK requires Android 12+ (API 31)
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
        }

        // ── Registration ──

        AsyncFunction("initialize") {
            if (initialized) return@AsyncFunction true

            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                sendEvent("onError", mapOf(
                    "code" to "UNSUPPORTED_DEVICE",
                    "message" to "DAT SDK requires Android 12+ (API 31)"
                ))
                return@AsyncFunction false
            }

            try {
                // TODO: Replace with actual SDK call when dependencies are available:
                // val activity = appContext.activityProvider?.currentActivity
                //     ?: throw Exception("No activity available")
                // Wearables.initialize(activity)
                //
                // // Collect registration state changes
                // registrationJob = scope.launch {
                //     Wearables.registrationState.collect { state ->
                //         connectionState = when (state) {
                //             is RegistrationState.Connected -> "connected"
                //             is RegistrationState.Connecting -> "connecting"
                //             is RegistrationState.Disconnected -> "disconnected"
                //             else -> "unavailable"
                //         }
                //         sendEvent("onConnectionChanged", mapOf(
                //             "state" to connectionState
                //         ))
                //     }
                // }

                initialized = true
                connectionState = "disconnected"
                sendEvent("onConnectionChanged", mapOf("state" to connectionState))
                Log.i(TAG, "Initialized (stub mode — SDK not yet linked)")
                true
            } catch (e: Exception) {
                Log.e(TAG, "Initialize failed: ${e.message}")
                sendEvent("onError", mapOf(
                    "code" to "INIT_FAILED",
                    "message" to (e.message ?: "Unknown error")
                ))
                false
            }
        }

        AsyncFunction("registerDevice") {
            if (!initialized) {
                sendEvent("onError", mapOf(
                    "code" to "NOT_INITIALIZED",
                    "message" to "Call initialize() first"
                ))
                return@AsyncFunction
            }

            try {
                connectionState = "connecting"
                sendEvent("onConnectionChanged", mapOf("state" to connectionState))

                // TODO: Replace with actual SDK call:
                // val activity = appContext.activityProvider?.currentActivity
                //     ?: throw Exception("No activity available")
                // Wearables.startRegistration(activity)

                Log.i(TAG, "registerDevice called (stub — opens Meta AI app registration)")
            } catch (e: Exception) {
                Log.e(TAG, "Registration failed: ${e.message}")
                connectionState = "disconnected"
                sendEvent("onConnectionChanged", mapOf(
                    "state" to connectionState,
                    "error" to (e.message ?: "Registration failed")
                ))
            }
        }

        AsyncFunction("unregisterDevice") {
            try {
                // TODO: Replace with actual SDK call:
                // val activity = appContext.activityProvider?.currentActivity
                //     ?: throw Exception("No activity available")
                // Wearables.startUnregistration(activity)

                connectionState = "disconnected"
                sendEvent("onConnectionChanged", mapOf("state" to connectionState))
                Log.i(TAG, "unregisterDevice called (stub)")
            } catch (e: Exception) {
                Log.e(TAG, "Unregistration failed: ${e.message}")
                sendEvent("onError", mapOf(
                    "code" to "UNREGISTER_FAILED",
                    "message" to (e.message ?: "Unregistration failed")
                ))
            }
        }

        Function("getConnectionState") {
            connectionState
        }

        // ── Video Streaming ──

        AsyncFunction("startVideoStream") { options: Map<String, Any> ->
            if (!initialized) {
                sendEvent("onError", mapOf(
                    "code" to "NOT_INITIALIZED",
                    "message" to "Call initialize() first"
                ))
                return@AsyncFunction
            }
            if (streaming) {
                Log.w(TAG, "Stream already active")
                return@AsyncFunction
            }

            val quality = (options["quality"] as? String) ?: "medium"
            val frameRate = (options["frameRate"] as? Double)?.toInt() ?: DEFAULT_FRAME_RATE

            try {
                // TODO: Replace with actual SDK call:
                // val config = StreamConfiguration.Builder()
                //     .setQuality(when (quality) {
                //         "low" -> StreamConfiguration.Quality.LOW
                //         "high" -> StreamConfiguration.Quality.HIGH
                //         else -> StreamConfiguration.Quality.MEDIUM
                //     })
                //     .setFrameRate(frameRate.coerceIn(2, 30))
                //     .build()
                //
                // streamSession = Wearables.startStreamSession(
                //     config, AutoDeviceSelector()
                // )
                //
                // // Collect video frames with backpressure handling
                // videoJob = scope.launch(Dispatchers.Default) {
                //     streamSession?.videoStream?.collectLatest { frame ->
                //         val base64 = frameToBase64Jpeg(frame)
                //         if (base64 != null) {
                //             sendEvent("onVideoFrame", mapOf(
                //                 "data" to base64,
                //                 "width" to frame.width,
                //                 "height" to frame.height,
                //                 "timestamp" to frame.timestampMs
                //             ))
                //         }
                //     }
                // }
                //
                // // Collect stream state changes
                // stateJob = scope.launch {
                //     streamSession?.state?.collect { state ->
                //         sendEvent("onStreamStateChanged", mapOf(
                //             "state" to state.toString()
                //         ))
                //     }
                // }

                streaming = true
                sendEvent("onStreamStateChanged", mapOf("state" to "started"))
                Log.i(TAG, "startVideoStream: quality=$quality, frameRate=$frameRate (stub)")
            } catch (e: Exception) {
                Log.e(TAG, "startVideoStream failed: ${e.message}")
                sendEvent("onError", mapOf(
                    "code" to "STREAM_FAILED",
                    "message" to (e.message ?: "Failed to start stream")
                ))
            }
        }

        AsyncFunction("stopVideoStream") {
            try {
                videoJob?.cancel()
                videoJob = null
                stateJob?.cancel()
                stateJob = null

                // TODO: Replace with actual SDK call:
                // streamSession?.close()
                // streamSession = null

                streaming = false
                sendEvent("onStreamStateChanged", mapOf("state" to "stopped"))
                Log.i(TAG, "stopVideoStream (stub)")
            } catch (e: Exception) {
                Log.e(TAG, "stopVideoStream failed: ${e.message}")
                sendEvent("onError", mapOf(
                    "code" to "STOP_FAILED",
                    "message" to (e.message ?: "Failed to stop stream")
                ))
            }
        }

        AsyncFunction("capturePhoto") {
            if (!streaming) {
                sendEvent("onError", mapOf(
                    "code" to "NO_STREAM",
                    "message" to "Start a video stream before capturing photos"
                ))
                return@AsyncFunction null as String?
            }

            try {
                // TODO: Replace with actual SDK call:
                // val result = streamSession?.capturePhoto()
                // if (result is DatResult.Success) {
                //     val photoData = result.value
                //     val bitmap = photoData.bitmap
                //     val baos = ByteArrayOutputStream()
                //     bitmap.compress(Bitmap.CompressFormat.JPEG, 85, baos)
                //     val base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
                //     sendEvent("onPhotoCaptured", mapOf(
                //         "data" to base64,
                //         "format" to "jpeg"
                //     ))
                //     return@AsyncFunction base64
                // }

                Log.i(TAG, "capturePhoto (stub — no real photo)")
                sendEvent("onError", mapOf(
                    "code" to "STUB_MODE",
                    "message" to "Photo capture unavailable in stub mode"
                ))
                null as String?
            } catch (e: Exception) {
                Log.e(TAG, "capturePhoto failed: ${e.message}")
                sendEvent("onError", mapOf(
                    "code" to "CAPTURE_FAILED",
                    "message" to (e.message ?: "Failed to capture photo")
                ))
                null as String?
            }
        }

        // ── Lifecycle ──

        OnActivityDestroys {
            cleanup()
        }
    }

    /**
     * Convert a DAT VideoFrame (I420 buffer) to a base64-encoded JPEG string.
     * Uses NV21 as intermediate format for YuvImage compatibility.
     */
    @Suppress("unused")
    private fun frameToBase64Jpeg(width: Int, height: Int, yuvData: ByteArray): String? {
        return try {
            val yuvImage = YuvImage(yuvData, ImageFormat.NV21, width, height, null)
            val baos = ByteArrayOutputStream()
            yuvImage.compressToJpeg(Rect(0, 0, width, height), JPEG_QUALITY, baos)
            Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) {
            Log.e(TAG, "frameToBase64Jpeg failed: ${e.message}")
            null
        }
    }

    private fun cleanup() {
        videoJob?.cancel()
        videoJob = null
        stateJob?.cancel()
        stateJob = null
        registrationJob?.cancel()
        registrationJob = null
        devicesJob?.cancel()
        devicesJob = null

        // streamSession?.close()
        // streamSession = null

        streaming = false
        initialized = false
        connectionState = "disconnected"
        scope.cancel()
    }
}
