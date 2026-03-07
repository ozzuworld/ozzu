// Face matching module — ArcFace deep learning face comparison via face-recognition container
// Compares faces across profiles using 512-D embeddings (cosine similarity)
// Complements avatar-compare.js (perceptual hash) with actual facial recognition
const db = require("../db");
const fs = require("fs");

const FACE_API = "http://127.0.0.1:5555";
const MATCH_THRESHOLD = 0.4;   // ArcFace cosine similarity (container default)
const HIGH_THRESHOLD = 0.6;    // High confidence face match
const DOWNLOAD_TIMEOUT = 8000;

async function fetchFaceEmbedding(imageBuffer) {
  const base64 = imageBuffer.toString("base64");
  const form = new URLSearchParams();
  form.append("base64_image", base64);
  const res = await fetch(`${FACE_API}/embed`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.faces && data.faces.length > 0 ? data.faces[0] : null;
}

async function compareFaces(buffer1, buffer2) {
  const form = new URLSearchParams();
  form.append("base64_image1", buffer1.toString("base64"));
  form.append("base64_image2", buffer2.toString("base64"));
  const res = await fetch(`${FACE_API}/compare`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  return await res.json();
}

async function downloadImage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OSINT-Scanner/1.0)" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

// Check if face-recognition service is available
async function isServiceUp() {
  try {
    const res = await fetch(`${FACE_API}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = {
  name: "face-match",
  profileTypes: ["image"],

  async scan(profile, rateLimiter, { db: dbRef }) {
    const findings = [];

    // Check service availability
    if (!(await isServiceUp())) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Face recognition service unavailable",
        rawData: { reason: "service_down", endpoint: FACE_API },
      });
      return findings;
    }

    // Get the uploaded image for this profile
    const image = await dbRef.getOsintImageByProfile(profile.id);
    if (!image || !fs.existsSync(image.file_path)) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "No image file for face matching",
        rawData: { reason: "no_image_file" },
      });
      return findings;
    }

    // Extract face embedding from the uploaded image
    const uploadedBuffer = fs.readFileSync(image.file_path);
    const uploadedFace = await fetchFaceEmbedding(uploadedBuffer);
    if (!uploadedFace) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "No face detected in uploaded image",
        description: "The face recognition model could not detect a face in this image. Try a clearer photo with a visible face.",
        rawData: { reason: "no_face_detected" },
      });
      return findings;
    }

    findings.push({
      category: "metadata",
      severity: "info",
      title: "Face detected — starting cross-profile comparison",
      rawData: {
        faceDetected: true,
        detScore: uploadedFace.det_score,
        bbox: uploadedFace.bbox,
        embeddingDim: uploadedFace.embedding?.length || 0,
      },
    });

    // Store the embedding as entity metadata for future cross-profile matching
    // (correlator will pick this up via extraction rule)

    // Collect avatar URLs from all findings across other profiles
    const allFindings = await dbRef.getOsintFindings({ limit: 1000 });
    const avatarUrls = new Map(); // url -> { profileId, module, platform }

    for (const f of allFindings) {
      if (!f.raw_data || f.profile_id === profile.id) continue;
      const urls = [];
      if (f.raw_data.avatarUrl) urls.push(f.raw_data.avatarUrl);
      if (f.raw_data.profileData?.avatar_url) urls.push(f.raw_data.profileData.avatar_url);
      if (f.raw_data.profileData?.icon_img) {
        const clean = f.raw_data.profileData.icon_img.split("?")[0];
        if (clean.startsWith("http")) urls.push(clean);
      }
      if (f.raw_data.thumbnailUrl) urls.push(f.raw_data.thumbnailUrl);
      for (const url of urls) {
        if (!avatarUrls.has(url)) {
          avatarUrls.set(url, { profileId: f.profile_id, module: f.module, platform: f.raw_data.platform || f.module });
        }
      }
    }

    // Also check image entities
    const imageEntities = await dbRef.getOsintEntities({ type: "image", limit: 200 });
    for (const e of imageEntities) {
      if (e.value?.startsWith("http") && !avatarUrls.has(e.value)) {
        avatarUrls.set(e.value, { profileId: e.profile_id, module: e.source_module, platform: "entity" });
      }
    }

    if (avatarUrls.size === 0) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "No avatars found for face comparison",
        description: "Scan email/username profiles first to collect avatar images, then re-scan this image.",
        rawData: { reason: "no_avatars" },
      });
      return findings;
    }

    // Compare face against each avatar
    let faceMatches = 0;
    let facesDetected = 0;
    let compared = 0;
    const matchResults = [];

    for (const [url, meta] of avatarUrls) {
      const release = await rateLimiter.acquire();
      try {
        const avatarBuffer = await downloadImage(url);
        if (!avatarBuffer) continue;

        const result = await compareFaces(uploadedBuffer, avatarBuffer);
        if (!result || result.error) continue;

        compared++;
        if (result.similarity > 0) facesDetected++;

        matchResults.push({
          url,
          similarity: result.similarity,
          isMatch: result.is_match,
          ...meta,
        });

        if (result.similarity >= HIGH_THRESHOLD) {
          faceMatches++;
          const prof = await dbRef.getOsintProfile(meta.profileId);
          findings.push({
            category: "identity",
            severity: "high",
            title: `Face match (${Math.round(result.similarity * 100)}%) with ${prof?.label || `profile #${meta.profileId}`}`,
            description: `ArcFace cosine similarity: ${result.similarity.toFixed(4)}\nSource: ${meta.platform}\nAvatar: ${url}\n\nThis is a strong facial match indicating the same person appears in both images.`,
            sourceUrl: url,
            rawData: {
              similarity: result.similarity,
              isMatch: true,
              avatarUrl: url,
              matchedProfileId: meta.profileId,
              matchedProfileLabel: prof?.label,
              platform: meta.platform,
              faceMatch: true,
              embedding: uploadedFace.embedding,
            },
            remediation: "The same face appearing across multiple platforms enables identity correlation. Use different photos or no photo where possible.",
          });
        } else if (result.similarity >= MATCH_THRESHOLD) {
          faceMatches++;
          const prof = await dbRef.getOsintProfile(meta.profileId);
          findings.push({
            category: "identity",
            severity: "medium",
            title: `Possible face match (${Math.round(result.similarity * 100)}%) with ${prof?.label || `profile #${meta.profileId}`}`,
            description: `ArcFace cosine similarity: ${result.similarity.toFixed(4)}\nSource: ${meta.platform}\nAvatar: ${url}\n\nModerate facial similarity — could be the same person or a similar-looking individual.`,
            sourceUrl: url,
            rawData: {
              similarity: result.similarity,
              isMatch: true,
              avatarUrl: url,
              matchedProfileId: meta.profileId,
              matchedProfileLabel: prof?.label,
              platform: meta.platform,
              faceMatch: true,
              embedding: uploadedFace.embedding,
            },
          });
        }
      } catch {
        // Download or comparison failed — skip
      } finally {
        release();
      }
    }

    // Summary finding
    findings.push({
      category: "metadata",
      severity: faceMatches > 0 ? "medium" : "info",
      title: `Face matching: ${faceMatches} match(es) from ${compared} compared (${facesDetected} faces detected)`,
      description: faceMatches > 0
        ? `Found ${faceMatches} face(s) matching the uploaded image across ${compared} avatars using ArcFace deep learning.`
        : `No matching faces found among ${compared} compared avatars.`,
      rawData: {
        totalCompared: compared,
        totalFacesDetected: facesDetected,
        totalMatches: faceMatches,
        topMatches: matchResults
          .filter((r) => r.similarity >= MATCH_THRESHOLD)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 10),
        embeddingStored: true,
        uploadedEmbedding: uploadedFace.embedding,
      },
    });

    return findings;
  },
};
