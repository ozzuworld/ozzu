// Reverse image search + EXIF extraction module
// Collects avatar/image URLs from previous scan findings, extracts EXIF metadata (GPS, camera, author),
// checks TinEye/Yandex/Google Vision for reverse image matches
const db = require("../db");
let exifr;
try { exifr = require("exifr"); } catch { exifr = null; }

module.exports = {
  name: "image-search",
  profileTypes: ["email", "username"],

  async scan(profile, rateLimiter) {
    const findings = [];

    // 1. Collect image URLs from previous findings for this profile
    const existingFindings = await db.getOsintFindings({ profileId: profile.id, limit: 200 });
    const imageUrls = new Set();

    for (const f of existingFindings) {
      if (!f.raw_data) continue;
      // Gravatar avatar
      if (f.raw_data.avatarUrl) imageUrls.add(f.raw_data.avatarUrl);
      // GitHub avatar
      if (f.raw_data.profileData?.avatar_url) imageUrls.add(f.raw_data.profileData.avatar_url);
      // Reddit avatar
      if (f.raw_data.profileData?.icon_img) {
        const cleanUrl = f.raw_data.profileData.icon_img.split("?")[0];
        if (cleanUrl.startsWith("http")) imageUrls.add(cleanUrl);
      }
      if (f.raw_data.profileData?.snoovatar_img) {
        const cleanUrl = f.raw_data.profileData.snoovatar_img.split("?")[0];
        if (cleanUrl.startsWith("http")) imageUrls.add(cleanUrl);
      }
    }

    if (imageUrls.size === 0) {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "No profile images found to reverse search",
        description: "Run other scans first (gravatar-lookup, social-deep) to collect avatar URLs, then re-run image search.",
        rawData: { reason: "no_image_urls", profileId: profile.id },
      });
      return findings;
    }

    findings.push({
      category: "exposure",
      severity: "info",
      title: `${imageUrls.size} profile image(s) collected for reverse search`,
      description: [...imageUrls].map((url) => `  ${url}`).join("\n"),
      rawData: { imageUrls: [...imageUrls] },
    });

    // 2. EXIF metadata extraction — GPS, camera model, author, creation date
    if (exifr) {
      for (const imageUrl of [...imageUrls].slice(0, 5)) {
        const release = await rateLimiter.acquire();
        try {
          const res = await fetch(imageUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; OSINT-Scanner/1.0)" },
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) continue;
          const buffer = Buffer.from(await res.arrayBuffer());

          const exif = await exifr.parse(buffer, {
            gps: true, exif: true, iptc: true, xmp: true, icc: false,
            translateValues: true, reviveValues: true,
          }).catch(() => null);

          if (!exif) continue;

          // GPS coordinates — critical location leak
          if (exif.latitude && exif.longitude) {
            findings.push({
              category: "exposure",
              severity: "critical",
              title: `GPS coordinates found in image metadata`,
              description: `Location: ${exif.latitude.toFixed(6)}, ${exif.longitude.toFixed(6)}\nImage: ${imageUrl}\nThis reveals the exact location where the photo was taken.`,
              sourceUrl: imageUrl,
              rawData: { imageUrl, latitude: exif.latitude, longitude: exif.longitude, altitude: exif.GPSAltitude },
              remediation: "Strip EXIF metadata from all profile photos before uploading. Most social platforms do this automatically, but some don't.",
            });
          }

          // Camera model — device fingerprint
          if (exif.Make || exif.Model) {
            findings.push({
              category: "exposure",
              severity: "medium",
              title: `Camera/device info found in image metadata`,
              description: `Make: ${exif.Make || "N/A"}\nModel: ${exif.Model || "N/A"}\nSoftware: ${exif.Software || "N/A"}\nImage: ${imageUrl}`,
              sourceUrl: imageUrl,
              rawData: { imageUrl, make: exif.Make, model: exif.Model, software: exif.Software },
              remediation: "Camera model and software version can identify the device used. Strip metadata before sharing photos.",
            });
          }

          // Author/copyright — real name leak
          const author = exif.Artist || exif.Copyright || exif.Creator || (exif.XPAuthor ? String(exif.XPAuthor) : null);
          if (author) {
            findings.push({
              category: "exposure",
              severity: "medium",
              title: `Author/copyright info found in image metadata`,
              description: `Author: ${author}\nImage: ${imageUrl}\nThis may reveal the photographer's real name.`,
              sourceUrl: imageUrl,
              rawData: { imageUrl, author, copyright: exif.Copyright },
              remediation: "Remove author metadata from photos before uploading to prevent real name exposure.",
            });
          }

          // Creation date — timeline info
          if (exif.DateTimeOriginal || exif.CreateDate) {
            const date = exif.DateTimeOriginal || exif.CreateDate;
            findings.push({
              category: "exposure",
              severity: "low",
              title: `Creation date found in image metadata`,
              description: `Date: ${date}\nImage: ${imageUrl}`,
              sourceUrl: imageUrl,
              rawData: { imageUrl, dateTimeOriginal: String(date) },
            });
          }
        } catch {
          // EXIF extraction failed — skip
        } finally {
          release();
        }
      }
    } else {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "EXIF extraction skipped — exifr package not available",
        description: "Install exifr package for image metadata extraction: npm install exifr",
        rawData: { reason: "no_exifr_package" },
      });
    }

    // 3. TinEye API (free non-commercial)
    for (const imageUrl of [...imageUrls].slice(0, 3)) {
      const release = await rateLimiter.acquire();
      try {
        // TinEye search URL — redirect to results (no direct API without key)
        const tineye = `https://tineye.com/search?url=${encodeURIComponent(imageUrl)}`;
        findings.push({
          category: "exposure",
          severity: "info",
          title: `TinEye reverse search available`,
          description: `Check manually for image matches: ${tineye}`,
          sourceUrl: tineye,
          rawData: { imageUrl, searchEngine: "tineye", manualUrl: tineye },
          remediation: "If your profile photo appears on unexpected sites, it may be used for impersonation. Use unique photos per platform.",
        });
      } finally {
        release();
      }
    }

    // 4. Google Vision API (1000 free/mo) — face detection, web entity detection
    const visionKey = process.env.GOOGLE_VISION_API_KEY;
    if (visionKey) {
      for (const imageUrl of [...imageUrls].slice(0, 2)) {
        const release = await rateLimiter.acquire();
        try {
          const visionUrl = `https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`;
          const body = {
            requests: [{
              image: { source: { imageUri: imageUrl } },
              features: [
                { type: "FACE_DETECTION", maxResults: 5 },
                { type: "WEB_DETECTION", maxResults: 10 },
                { type: "LABEL_DETECTION", maxResults: 5 },
              ],
            }],
          };

          const res = await fetch(visionUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
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
                title: `${faces.length} face(s) detected in profile image`,
                description: `Google Vision detected ${faces.length} face(s) in the image. Confidence: ${faces.map((f) => `${(f.detectionConfidence * 100).toFixed(0)}%`).join(", ")}. Facial recognition services can match this against other photos.`,
                rawData: { imageUrl, faces: faces.length, searchEngine: "google_vision", confidences: faces.map((f) => f.detectionConfidence) },
                remediation: "Using a real photo as your profile picture makes you identifiable via facial recognition. Consider using an avatar.",
              });
            }

            // Web detection — where this image appears
            if (response?.webDetection) {
              const web = response.webDetection;
              const matchCount = (web.fullMatchingImages?.length || 0) + (web.partialMatchingImages?.length || 0);

              if (matchCount > 0) {
                const sites = [
                  ...(web.fullMatchingImages || []).map((m) => m.url),
                  ...(web.partialMatchingImages || []).map((m) => m.url),
                ].slice(0, 10);

                findings.push({
                  category: "exposure",
                  severity: "high",
                  title: `Profile image appears on ${matchCount} other site(s)`,
                  description: `Found ${web.fullMatchingImages?.length || 0} exact and ${web.partialMatchingImages?.length || 0} partial matches:\n${sites.map((s) => `  ${s}`).join("\n")}`,
                  rawData: {
                    imageUrl, searchEngine: "google_vision", matchCount,
                    fullMatches: web.fullMatchingImages?.map((m) => m.url),
                    partialMatches: web.partialMatchingImages?.map((m) => m.url),
                    webEntities: web.webEntities?.slice(0, 5),
                  },
                  remediation: "Your profile image appears on multiple sites. Reusing the same photo across platforms makes cross-platform identification easy.",
                });
              }

              // Web entities — what Google thinks this image represents
              if (web.webEntities?.length > 0) {
                const entities = web.webEntities.filter((e) => e.description && e.score > 0.5);
                if (entities.length > 0) {
                  findings.push({
                    category: "exposure",
                    severity: "low",
                    title: `Image associated with ${entities.length} web entities`,
                    description: entities.map((e) => `  ${e.description} (${(e.score * 100).toFixed(0)}%)`).join("\n"),
                    rawData: { imageUrl, webEntities: entities, searchEngine: "google_vision" },
                  });
                }
              }
            }
          }
        } catch (_) {
          // Vision API error — skip
        } finally {
          release();
        }
      }
    } else {
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Google Vision reverse search skipped — no API key",
        description: "Set GOOGLE_VISION_API_KEY for automated face detection and web image matching (1000 free/month).",
        rawData: { reason: "no_google_vision_api_key" },
      });
    }

    // 5. Yandex reverse image — construct search URL
    for (const imageUrl of [...imageUrls].slice(0, 2)) {
      const yandexUrl = `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(imageUrl)}`;
      findings.push({
        category: "exposure",
        severity: "info",
        title: "Yandex reverse image search available",
        description: `Yandex often finds matches that Google misses, especially for non-US content: ${yandexUrl}`,
        sourceUrl: yandexUrl,
        rawData: { imageUrl, searchEngine: "yandex", manualUrl: yandexUrl },
      });
    }

    return findings;
  },
};
