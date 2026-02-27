// Reverse image search module for uploaded images
// Google Vision API (face detection, web detection, labels) + manual search URLs
const db = require("../db");
const fs = require("fs");

module.exports = {
  name: "reverse-image",
  profileTypes: ["image"],

  async scan(profile, rateLimiter) {
    const findings = [];

    const image = await db.getOsintImageByProfile(profile.id);
    if (!image || !fs.existsSync(image.file_path)) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "No image file found for reverse search",
        rawData: { reason: "no_image_file" },
      });
      return findings;
    }

    // Bridge URL for serving the image (accessible on VPN)
    const bridgeUrl = process.env.BRIDGE_PUBLIC_URL || "http://10.8.0.1:3333";
    const imageUrl = `${bridgeUrl}/osint/images/${profile.id}`;

    // 1. Generate manual search URLs (always available, no API key needed)
    const googleLens = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
    const yandex = `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(imageUrl)}`;
    const tineye = `https://tineye.com/search?url=${encodeURIComponent(imageUrl)}`;

    findings.push({
      category: "exposure",
      severity: "info",
      title: "Reverse image search URLs generated",
      description: `Google Lens: ${googleLens}\nYandex: ${yandex}\nTinEye: ${tineye}`,
      rawData: {
        searchUrls: { googleLens, yandex, tineye },
        imageUrl,
        note: "These URLs require the image to be publicly accessible. Open manually to check for matches.",
      },
    });

    // 2. Google Vision API (1000 free/month)
    const visionKey = process.env.GOOGLE_VISION_API_KEY;
    if (visionKey) {
      const release = await rateLimiter.acquire();
      try {
        // Read image and encode as base64 for Vision API (more reliable than URL-based)
        const imageBuffer = fs.readFileSync(image.file_path);
        const base64Image = imageBuffer.toString("base64");

        const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`;
        const body = {
          requests: [{
            image: { content: base64Image },
            features: [
              { type: "FACE_DETECTION", maxResults: 10 },
              { type: "WEB_DETECTION", maxResults: 15 },
              { type: "LABEL_DETECTION", maxResults: 10 },
              { type: "SAFE_SEARCH_DETECTION" },
            ],
          }],
        };

        const res = await fetch(visionUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });

        if (res.ok) {
          const data = await res.json();
          const response = data.responses?.[0];

          // Face detection
          if (response?.faceAnnotations?.length > 0) {
            const faces = response.faceAnnotations;
            findings.push({
              category: "exposure",
              severity: "medium",
              title: `${faces.length} face(s) detected in image`,
              description: `Google Vision detected ${faces.length} face(s).\nConfidence: ${faces.map((f) => `${(f.detectionConfidence * 100).toFixed(0)}%`).join(", ")}\n\nEmotions: ${faces.map((f) => {
                const emotions = [];
                if (f.joyLikelihood === "VERY_LIKELY" || f.joyLikelihood === "LIKELY") emotions.push("joy");
                if (f.sorrowLikelihood === "VERY_LIKELY" || f.sorrowLikelihood === "LIKELY") emotions.push("sorrow");
                if (f.angerLikelihood === "VERY_LIKELY" || f.angerLikelihood === "LIKELY") emotions.push("anger");
                if (f.surpriseLikelihood === "VERY_LIKELY" || f.surpriseLikelihood === "LIKELY") emotions.push("surprise");
                return emotions.length > 0 ? emotions.join(", ") : "neutral";
              }).join("; ")}`,
              rawData: {
                faceCount: faces.length,
                searchEngine: "google_vision",
                confidences: faces.map((f) => f.detectionConfidence),
                headwear: faces.some((f) => f.headwearLikelihood === "VERY_LIKELY" || f.headwearLikelihood === "LIKELY"),
              },
              remediation: "Photos with detectable faces can be matched via facial recognition services like PimEyes. Consider using an avatar instead.",
            });
          }

          // Web detection — where this image appears online
          if (response?.webDetection) {
            const web = response.webDetection;
            const fullMatches = web.fullMatchingImages || [];
            const partialMatches = web.partialMatchingImages || [];
            const matchCount = fullMatches.length + partialMatches.length;

            if (matchCount > 0) {
              const sites = [
                ...fullMatches.map((m) => m.url),
                ...partialMatches.map((m) => m.url),
              ].slice(0, 15);

              findings.push({
                category: "exposure",
                severity: "high",
                title: `Image appears on ${matchCount} site(s)`,
                description: `${fullMatches.length} exact + ${partialMatches.length} partial matches:\n${sites.map((s) => `  ${s}`).join("\n")}`,
                rawData: {
                  searchEngine: "google_vision", matchCount,
                  fullMatches: fullMatches.map((m) => m.url),
                  partialMatches: partialMatches.map((m) => m.url),
                },
                remediation: "Your image appears on multiple sites. Reusing the same photo across platforms enables cross-platform identification.",
              });
            }

            // Pages with matching images
            if (web.pagesWithMatchingImages?.length > 0) {
              const pages = web.pagesWithMatchingImages.slice(0, 10);
              findings.push({
                category: "exposure",
                severity: "medium",
                title: `Image found on ${pages.length} web page(s)`,
                description: pages.map((p) => `  ${p.pageTitle || "Untitled"}: ${p.url}`).join("\n"),
                rawData: {
                  pages: pages.map((p) => ({ title: p.pageTitle, url: p.url })),
                  searchEngine: "google_vision",
                },
              });
            }

            // Web entities — what Google thinks this represents
            if (web.webEntities?.length > 0) {
              const entities = web.webEntities.filter((e) => e.description && e.score > 0.3);
              if (entities.length > 0) {
                findings.push({
                  category: "metadata",
                  severity: "low",
                  title: `Image associated with ${entities.length} web entities`,
                  description: entities.map((e) => `  ${e.description} (${(e.score * 100).toFixed(0)}%)`).join("\n"),
                  rawData: { webEntities: entities, searchEngine: "google_vision" },
                });
              }
            }

            // Visually similar images
            if (web.visuallySimilarImages?.length > 0) {
              findings.push({
                category: "exposure",
                severity: "low",
                title: `${web.visuallySimilarImages.length} visually similar image(s) found`,
                description: web.visuallySimilarImages.slice(0, 5).map((v) => `  ${v.url}`).join("\n"),
                rawData: { similarImages: web.visuallySimilarImages.map((v) => v.url), searchEngine: "google_vision" },
              });
            }
          }

          // Label detection
          if (response?.labelAnnotations?.length > 0) {
            const labels = response.labelAnnotations;
            findings.push({
              category: "metadata",
              severity: "info",
              title: `Image classified: ${labels.slice(0, 3).map((l) => l.description).join(", ")}`,
              description: labels.map((l) => `  ${l.description} (${(l.score * 100).toFixed(0)}%)`).join("\n"),
              rawData: { labels: labels.map((l) => ({ label: l.description, score: l.score })), searchEngine: "google_vision" },
            });
          }

          // SafeSearch detection
          if (response?.safeSearchAnnotation) {
            const ss = response.safeSearchAnnotation;
            const flagged = Object.entries(ss).filter(([, v]) => v === "VERY_LIKELY" || v === "LIKELY");
            if (flagged.length > 0) {
              findings.push({
                category: "exposure",
                severity: "medium",
                title: `SafeSearch flags: ${flagged.map(([k]) => k).join(", ")}`,
                description: Object.entries(ss).map(([k, v]) => `  ${k}: ${v}`).join("\n"),
                rawData: { safeSearch: ss, searchEngine: "google_vision" },
              });
            }
          }
        } else {
          const errBody = await res.text().catch(() => "");
          findings.push({
            category: "metadata",
            severity: "info",
            title: "Google Vision API error",
            description: `HTTP ${res.status}: ${errBody.slice(0, 200)}`,
            rawData: { error: `HTTP ${res.status}`, searchEngine: "google_vision" },
          });
        }
      } catch (err) {
        findings.push({
          category: "metadata",
          severity: "info",
          title: "Google Vision API request failed",
          description: err.message,
          rawData: { error: err.message, searchEngine: "google_vision" },
        });
      } finally {
        release();
      }
    } else {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Google Vision reverse search skipped — no API key",
        description: "Set GOOGLE_VISION_API_KEY for automated face detection and web image matching (1000 free/month).",
        rawData: { reason: "no_google_vision_api_key" },
      });
    }

    return findings;
  },
};
