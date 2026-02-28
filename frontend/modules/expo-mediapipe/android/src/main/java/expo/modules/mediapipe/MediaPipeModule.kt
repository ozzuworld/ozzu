package expo.modules.mediapipe

import android.graphics.BitmapFactory
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.framework.image.BitmapImageBuilder
import kotlinx.coroutines.*

class MediaPipeModule : Module() {
    private var handLandmarker: HandLandmarker? = null
    private var modelLoaded = false
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    override fun definition() = ModuleDefinition {
        Name("ExpoMediaPipe")

        AsyncFunction("initialize") { promise: Promise ->
            if (modelLoaded) {
                promise.resolve(true)
                return@AsyncFunction
            }

            scope.launch {
                try {
                    val context = appContext.reactContext ?: run {
                        promise.reject("ERR_NO_CONTEXT", "React context not available", null)
                        return@launch
                    }

                    val baseOptions = BaseOptions.builder()
                        .setModelAssetPath("hand_landmarker.task")
                        .build()

                    val options = HandLandmarker.HandLandmarkerOptions.builder()
                        .setBaseOptions(baseOptions)
                        .setRunningMode(RunningMode.IMAGE)
                        .setNumHands(2)
                        .setMinHandDetectionConfidence(0.5f)
                        .setMinHandPresenceConfidence(0.5f)
                        .setMinTrackingConfidence(0.5f)
                        .build()

                    handLandmarker = HandLandmarker.createFromOptions(context, options)
                    modelLoaded = true
                    promise.resolve(true)
                } catch (e: Exception) {
                    promise.reject("ERR_INIT", "Failed to initialize MediaPipe: ${e.message}", e)
                }
            }
        }

        AsyncFunction("detectHands") { base64: String, promise: Promise ->
            val landmarker = handLandmarker
            if (landmarker == null) {
                promise.resolve(emptyList<Map<String, Any>>())
                return@AsyncFunction
            }

            scope.launch {
                try {
                    val bytes = Base64.decode(base64, Base64.DEFAULT)
                    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    if (bitmap == null) {
                        promise.resolve(emptyList<Map<String, Any>>())
                        return@launch
                    }

                    val mpImage = BitmapImageBuilder(bitmap).build()
                    val result = landmarker.detect(mpImage)

                    val hands = result.landmarks().mapIndexed { idx, landmarks ->
                        val points = landmarks.map { lm ->
                            mapOf("x" to lm.x(), "y" to lm.y(), "z" to lm.z())
                        }
                        val handedness = result.handednesses().getOrNull(idx)
                            ?.firstOrNull()?.categoryName() ?: "unknown"
                        val confidence = result.handednesses().getOrNull(idx)
                            ?.firstOrNull()?.score() ?: 0f

                        mapOf(
                            "landmarks" to points,
                            "handedness" to handedness,
                            "confidence" to confidence
                        )
                    }

                    bitmap.recycle()
                    promise.resolve(hands)
                } catch (e: Exception) {
                    promise.resolve(emptyList<Map<String, Any>>())
                }
            }
        }

        AsyncFunction("dispose") { promise: Promise ->
            handLandmarker?.close()
            handLandmarker = null
            modelLoaded = false
            promise.resolve(null)
        }

        OnDestroy {
            handLandmarker?.close()
            handLandmarker = null
            modelLoaded = false
            scope.cancel()
        }
    }
}
