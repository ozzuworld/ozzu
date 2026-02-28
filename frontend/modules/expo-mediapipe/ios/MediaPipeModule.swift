import ExpoModulesCore
import UIKit
import MediaPipeTasksVision

public class MediaPipeModule: Module {
    private var handLandmarker: HandLandmarker?
    private var handModelLoaded = false
    private var faceLandmarker: FaceLandmarker?
    private var faceModelLoaded = false
    private var poseLandmarker: PoseLandmarker?
    private var poseModelLoaded = false
    private var objectDetector: ObjectDetector?
    private var objectModelLoaded = false

    public func definition() -> ModuleDefinition {
        Name("ExpoMediaPipe")

        // ── Hand detection ──

        AsyncFunction("initialize") { () -> Bool in
            guard !self.handModelLoaded else { return true }

            let bundle = Bundle(for: MediaPipeModule.self)
            guard let modelPath = bundle.path(
                forResource: "hand_landmarker",
                ofType: "task",
                inDirectory: "MediaPipeModels.bundle"
            ) else {
                throw NSError(domain: "MediaPipe", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Hand model file not found in bundle"])
            }

            let options = HandLandmarkerOptions()
            options.baseOptions.modelAssetPath = modelPath
            options.runningMode = .image
            options.numHands = 2
            options.minHandDetectionConfidence = 0.5
            options.minHandPresenceConfidence = 0.5
            options.minTrackingConfidence = 0.5

            self.handLandmarker = try HandLandmarker(options: options)
            self.handModelLoaded = true
            return true
        }

        AsyncFunction("detectHands") { (base64: String) -> [[String: Any]] in
            guard let landmarker = self.handLandmarker else { return [] }
            guard let data = Data(base64Encoded: base64),
                  let uiImage = UIImage(data: data) else { return [] }

            let mpImage = try MPImage(uiImage: uiImage)
            let result = try landmarker.detect(image: mpImage)

            return result.landmarks.enumerated().map { (idx, landmarks) in
                let points = landmarks.map { lm in
                    ["x": lm.x, "y": lm.y, "z": lm.z] as [String: Any]
                }
                let handedness = result.handedness[idx].first?.categoryName ?? "unknown"
                let confidence = result.handedness[idx].first?.score ?? 0
                return [
                    "landmarks": points,
                    "handedness": handedness,
                    "confidence": confidence
                ] as [String: Any]
            }
        }

        AsyncFunction("dispose") { () -> Void in
            self.handLandmarker = nil
            self.handModelLoaded = false
        }

        // ── Face detection ──

        AsyncFunction("initializeFaces") { () -> Bool in
            guard !self.faceModelLoaded else { return true }

            let bundle = Bundle(for: MediaPipeModule.self)
            guard let modelPath = bundle.path(
                forResource: "face_landmarker",
                ofType: "task",
                inDirectory: "MediaPipeModels.bundle"
            ) else {
                throw NSError(domain: "MediaPipe", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Face model file not found in bundle"])
            }

            let options = FaceLandmarkerOptions()
            options.baseOptions.modelAssetPath = modelPath
            options.runningMode = .image
            options.numFaces = 3
            options.minFaceDetectionConfidence = 0.5
            options.minFacePresenceConfidence = 0.5
            options.minTrackingConfidence = 0.5
            options.outputFaceBlendshapes = true

            self.faceLandmarker = try FaceLandmarker(options: options)
            self.faceModelLoaded = true
            return true
        }

        AsyncFunction("detectFaces") { (base64: String) -> [[String: Any]] in
            guard let landmarker = self.faceLandmarker else { return [] }
            guard let data = Data(base64Encoded: base64),
                  let uiImage = UIImage(data: data) else { return [] }

            let mpImage = try MPImage(uiImage: uiImage)
            let result = try landmarker.detect(image: mpImage)

            return result.faceLandmarks.enumerated().map { (idx, landmarks) in
                // Compute bounding box from landmarks
                var minX: Float = 1.0, minY: Float = 1.0
                var maxX: Float = 0.0, maxY: Float = 0.0
                for lm in landmarks {
                    minX = min(minX, lm.x)
                    minY = min(minY, lm.y)
                    maxX = max(maxX, lm.x)
                    maxY = max(maxY, lm.y)
                }

                // Extract blendshapes if available
                var blendshapes: [String: Float] = [:]
                if let faceBlendshapes = result.faceBlendshapes,
                   idx < faceBlendshapes.count {
                    for category in faceBlendshapes[idx].categories {
                        if let name = category.categoryName {
                            blendshapes[name] = category.score
                        }
                    }
                }

                return [
                    "boundingBox": [
                        "x": minX, "y": minY,
                        "width": maxX - minX, "height": maxY - minY
                    ],
                    "landmarkCount": landmarks.count,
                    "blendshapes": blendshapes,
                    "confidence": idx < (result.faceBlendshapes?.count ?? 0) ? 0.9 : 0.7
                ] as [String: Any]
            }
        }

        AsyncFunction("disposeFaces") { () -> Void in
            self.faceLandmarker = nil
            self.faceModelLoaded = false
        }

        // ── Pose detection ──

        AsyncFunction("initializePose") { () -> Bool in
            guard !self.poseModelLoaded else { return true }

            let bundle = Bundle(for: MediaPipeModule.self)
            guard let modelPath = bundle.path(
                forResource: "pose_landmarker_lite",
                ofType: "task",
                inDirectory: "MediaPipeModels.bundle"
            ) else {
                throw NSError(domain: "MediaPipe", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "Pose model file not found in bundle"])
            }

            let options = PoseLandmarkerOptions()
            options.baseOptions.modelAssetPath = modelPath
            options.runningMode = .image
            options.numPoses = 1
            options.minPoseDetectionConfidence = 0.5
            options.minPosePresenceConfidence = 0.5
            options.minTrackingConfidence = 0.5

            self.poseLandmarker = try PoseLandmarker(options: options)
            self.poseModelLoaded = true
            return true
        }

        AsyncFunction("detectPose") { (base64: String) -> [[String: Any]] in
            guard let landmarker = self.poseLandmarker else { return [] }
            guard let data = Data(base64Encoded: base64),
                  let uiImage = UIImage(data: data) else { return [] }

            let mpImage = try MPImage(uiImage: uiImage)
            let result = try landmarker.detect(image: mpImage)

            return result.landmarks.map { landmarks in
                let points = landmarks.map { lm in
                    ["x": lm.x, "y": lm.y, "z": lm.z, "visibility": lm.visibility?.floatValue ?? 0] as [String: Any]
                }
                return ["landmarks": points] as [String: Any]
            }
        }

        AsyncFunction("disposePose") { () -> Void in
            self.poseLandmarker = nil
            self.poseModelLoaded = false
        }

        // ── Object detection ──

        AsyncFunction("initializeObjects") { () -> Bool in
            guard !self.objectModelLoaded else { return true }

            let bundle = Bundle(for: MediaPipeModule.self)
            guard let modelPath = bundle.path(
                forResource: "efficientdet_lite0",
                ofType: "tflite",
                inDirectory: "MediaPipeModels.bundle"
            ) else {
                throw NSError(domain: "MediaPipe", code: 4,
                    userInfo: [NSLocalizedDescriptionKey: "Object detector model not found in bundle"])
            }

            let options = ObjectDetectorOptions()
            options.baseOptions.modelAssetPath = modelPath
            options.runningMode = .image
            options.maxResults = 10
            options.scoreThreshold = 0.4

            self.objectDetector = try ObjectDetector(options: options)
            self.objectModelLoaded = true
            return true
        }

        AsyncFunction("detectObjects") { (base64: String) -> [[String: Any]] in
            guard let detector = self.objectDetector else { return [] }
            guard let data = Data(base64Encoded: base64),
                  let uiImage = UIImage(data: data) else { return [] }

            let imgW = Float(uiImage.size.width)
            let imgH = Float(uiImage.size.height)
            let mpImage = try MPImage(uiImage: uiImage)
            let result = try detector.detect(image: mpImage)

            return result.detections.compactMap { detection in
                guard let category = detection.categories.first,
                      let label = category.categoryName else { return nil }
                let box = detection.boundingBox
                return [
                    "label": label,
                    "score": category.score,
                    "x": Float(box.origin.x) / imgW,
                    "y": Float(box.origin.y) / imgH,
                    "width": Float(box.size.width) / imgW,
                    "height": Float(box.size.height) / imgH,
                ] as [String: Any]
            }
        }

        AsyncFunction("disposeObjects") { () -> Void in
            self.objectDetector = nil
            self.objectModelLoaded = false
        }
    }
}
