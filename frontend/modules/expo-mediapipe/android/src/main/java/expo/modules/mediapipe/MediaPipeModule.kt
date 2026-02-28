package expo.modules.mediapipe

import android.graphics.BitmapFactory
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker
import com.google.mediapipe.tasks.vision.objectdetector.ObjectDetector
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.framework.image.BitmapImageBuilder
import kotlinx.coroutines.*

class MediaPipeModule : Module() {
    private var handLandmarker: HandLandmarker? = null
    private var handModelLoaded = false
    private var faceLandmarker: FaceLandmarker? = null
    private var faceModelLoaded = false
    private var poseLandmarker: PoseLandmarker? = null
    private var poseModelLoaded = false
    private var objectDetector: ObjectDetector? = null
    private var objectModelLoaded = false
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    override fun definition() = ModuleDefinition {
        Name("ExpoMediaPipe")

        // ── Hand detection ──

        AsyncFunction("initialize") { promise: Promise ->
            if (handModelLoaded) {
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
                    handModelLoaded = true
                    promise.resolve(true)
                } catch (e: Exception) {
                    promise.reject("ERR_INIT", "Failed to initialize hand detection: ${e.message}", e)
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
            handModelLoaded = false
            promise.resolve(null)
        }

        // ── Face detection ──

        AsyncFunction("initializeFaces") { promise: Promise ->
            if (faceModelLoaded) {
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
                        .setModelAssetPath("face_landmarker.task")
                        .build()

                    val options = FaceLandmarker.FaceLandmarkerOptions.builder()
                        .setBaseOptions(baseOptions)
                        .setRunningMode(RunningMode.IMAGE)
                        .setNumFaces(3)
                        .setMinFaceDetectionConfidence(0.5f)
                        .setMinFacePresenceConfidence(0.5f)
                        .setMinTrackingConfidence(0.5f)
                        .setOutputFaceBlendshapes(true)
                        .build()

                    faceLandmarker = FaceLandmarker.createFromOptions(context, options)
                    faceModelLoaded = true
                    promise.resolve(true)
                } catch (e: Exception) {
                    promise.reject("ERR_INIT_FACE", "Failed to initialize face detection: ${e.message}", e)
                }
            }
        }

        AsyncFunction("detectFaces") { base64: String, promise: Promise ->
            val landmarker = faceLandmarker
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

                    val faces = result.faceLandmarks().mapIndexed { idx, landmarks ->
                        // Compute bounding box from landmarks
                        var minX = 1.0f; var minY = 1.0f
                        var maxX = 0.0f; var maxY = 0.0f
                        for (lm in landmarks) {
                            if (lm.x() < minX) minX = lm.x()
                            if (lm.y() < minY) minY = lm.y()
                            if (lm.x() > maxX) maxX = lm.x()
                            if (lm.y() > maxY) maxY = lm.y()
                        }

                        // Extract blendshapes
                        val blendshapes = mutableMapOf<String, Float>()
                        result.faceBlendshapes().ifPresent { fbs ->
                            if (idx < fbs.size) {
                                for (cat in fbs[idx]) {
                                    cat.categoryName()?.let { name ->
                                        blendshapes[name] = cat.score()
                                    }
                                }
                            }
                        }

                        mapOf(
                            "boundingBox" to mapOf(
                                "x" to minX, "y" to minY,
                                "width" to (maxX - minX), "height" to (maxY - minY)
                            ),
                            "landmarkCount" to landmarks.size,
                            "blendshapes" to blendshapes,
                            "confidence" to if (blendshapes.isNotEmpty()) 0.9f else 0.7f
                        )
                    }

                    bitmap.recycle()
                    promise.resolve(faces)
                } catch (e: Exception) {
                    promise.resolve(emptyList<Map<String, Any>>())
                }
            }
        }

        AsyncFunction("disposeFaces") { promise: Promise ->
            faceLandmarker?.close()
            faceLandmarker = null
            faceModelLoaded = false
            promise.resolve(null)
        }

        // ── Pose detection ──

        AsyncFunction("initializePose") { promise: Promise ->
            if (poseModelLoaded) {
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
                        .setModelAssetPath("pose_landmarker_lite.task")
                        .build()

                    val options = PoseLandmarker.PoseLandmarkerOptions.builder()
                        .setBaseOptions(baseOptions)
                        .setRunningMode(RunningMode.IMAGE)
                        .setNumPoses(1)
                        .setMinPoseDetectionConfidence(0.5f)
                        .setMinPosePresenceConfidence(0.5f)
                        .setMinTrackingConfidence(0.5f)
                        .build()

                    poseLandmarker = PoseLandmarker.createFromOptions(context, options)
                    poseModelLoaded = true
                    promise.resolve(true)
                } catch (e: Exception) {
                    promise.reject("ERR_INIT_POSE", "Failed to initialize pose detection: ${e.message}", e)
                }
            }
        }

        AsyncFunction("detectPose") { base64: String, promise: Promise ->
            val landmarker = poseLandmarker
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

                    val poses = result.landmarks().map { landmarks ->
                        val points = landmarks.map { lm ->
                            mapOf(
                                "x" to lm.x(),
                                "y" to lm.y(),
                                "z" to lm.z(),
                                "visibility" to (lm.visibility().orElse(0f))
                            )
                        }
                        mapOf("landmarks" to points)
                    }

                    bitmap.recycle()
                    promise.resolve(poses)
                } catch (e: Exception) {
                    promise.resolve(emptyList<Map<String, Any>>())
                }
            }
        }

        AsyncFunction("disposePose") { promise: Promise ->
            poseLandmarker?.close()
            poseLandmarker = null
            poseModelLoaded = false
            promise.resolve(null)
        }

        // ── Object detection ──

        AsyncFunction("initializeObjects") { promise: Promise ->
            if (objectModelLoaded) {
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
                        .setModelAssetPath("efficientdet_lite0.tflite")
                        .build()

                    val options = ObjectDetector.ObjectDetectorOptions.builder()
                        .setBaseOptions(baseOptions)
                        .setRunningMode(RunningMode.IMAGE)
                        .setMaxResults(10)
                        .setScoreThreshold(0.4f)
                        .build()

                    objectDetector = ObjectDetector.createFromOptions(context, options)
                    objectModelLoaded = true
                    promise.resolve(true)
                } catch (e: Exception) {
                    promise.reject("ERR_INIT_OBJ", "Failed to initialize object detection: ${e.message}", e)
                }
            }
        }

        AsyncFunction("detectObjects") { base64: String, promise: Promise ->
            val detector = objectDetector
            if (detector == null) {
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

                    val imgW = bitmap.width.toFloat()
                    val imgH = bitmap.height.toFloat()
                    val mpImage = BitmapImageBuilder(bitmap).build()
                    val result = detector.detect(mpImage)

                    val objects = result.detections().mapNotNull { detection ->
                        val category = detection.categories().firstOrNull() ?: return@mapNotNull null
                        val label = category.categoryName() ?: return@mapNotNull null
                        val box = detection.boundingBox()
                        mapOf(
                            "label" to label,
                            "score" to category.score(),
                            "x" to (box.left / imgW),
                            "y" to (box.top / imgH),
                            "width" to ((box.right - box.left) / imgW),
                            "height" to ((box.bottom - box.top) / imgH)
                        )
                    }

                    bitmap.recycle()
                    promise.resolve(objects)
                } catch (e: Exception) {
                    promise.resolve(emptyList<Map<String, Any>>())
                }
            }
        }

        AsyncFunction("disposeObjects") { promise: Promise ->
            objectDetector?.close()
            objectDetector = null
            objectModelLoaded = false
            promise.resolve(null)
        }

        OnDestroy {
            handLandmarker?.close()
            handLandmarker = null
            handModelLoaded = false
            faceLandmarker?.close()
            faceLandmarker = null
            faceModelLoaded = false
            poseLandmarker?.close()
            poseLandmarker = null
            poseModelLoaded = false
            objectDetector?.close()
            objectDetector = null
            objectModelLoaded = false
            scope.cancel()
        }
    }
}
