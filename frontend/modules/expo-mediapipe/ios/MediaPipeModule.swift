import ExpoModulesCore
import UIKit
import MediaPipeTasksVision

public class MediaPipeModule: Module {
    private var handLandmarker: HandLandmarker?
    private var modelLoaded = false

    public func definition() -> ModuleDefinition {
        Name("ExpoMediaPipe")

        // Load model on first use
        AsyncFunction("initialize") { () -> Bool in
            guard !self.modelLoaded else { return true }

            let bundle = Bundle(for: MediaPipeModule.self)
            guard let modelPath = bundle.path(
                forResource: "hand_landmarker",
                ofType: "task",
                inDirectory: "MediaPipeModels.bundle"
            ) else {
                throw NSError(domain: "MediaPipe", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Model file not found in bundle"])
            }

            let options = HandLandmarkerOptions()
            options.baseOptions.modelAssetPath = modelPath
            options.runningMode = .image
            options.numHands = 2
            options.minHandDetectionConfidence = 0.5
            options.minHandPresenceConfidence = 0.5
            options.minTrackingConfidence = 0.5

            self.handLandmarker = try HandLandmarker(options: options)
            self.modelLoaded = true
            return true
        }

        // Detect hands from base64 JPEG
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
            self.modelLoaded = false
        }
    }
}
