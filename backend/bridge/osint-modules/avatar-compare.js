// Avatar comparison module — perceptual hash matching
// Compares uploaded image against all avatars collected from other profiles
const db = require("../db");
const fs = require("fs");
let sharp;
try { sharp = require("sharp"); } catch { sharp = null; }

// Perceptual hash: resize to 8x8 grayscale, compute average, generate bit hash
async function computePHash(buffer) {
  if (!sharp) return null;
  try {
    const { data } = await sharp(buffer)
      .resize(8, 8, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Compute average pixel value
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const avg = sum / data.length;

    // Generate hash: 1 if pixel > average, 0 otherwise
    let hash = 0n;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > avg) hash |= (1n << BigInt(63 - i));
    }
    return hash;
  } catch {
    return null;
  }
}

// Hamming distance between two 64-bit hashes
function hammingDistance(a, b) {
  let xor = a ^ b;
  let dist = 0;
  while (xor > 0n) {
    dist += Number(xor & 1n);
    xor >>= 1n;
  }
  return dist;
}

// Similarity: 0-100% (64 bits, 0 distance = 100%)
function similarity(a, b) {
  const dist = hammingDistance(a, b);
  return Math.round(((64 - dist) / 64) * 100);
}

module.exports = {
  name: "avatar-compare",
  profileTypes: ["image"],

  async scan(profile, rateLimiter) {
    const findings = [];

    if (!sharp) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Avatar comparison unavailable — sharp not installed",
        rawData: { reason: "no_sharp" },
      });
      return findings;
    }

    // Get the uploaded image
    const image = await db.getOsintImageByProfile(profile.id);
    if (!image || !fs.existsSync(image.file_path)) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "No image file for avatar comparison",
        rawData: { reason: "no_image_file" },
      });
      return findings;
    }

    // Compute pHash of the uploaded image
    const uploadedBuffer = fs.readFileSync(image.file_path);
    const uploadedHash = await computePHash(uploadedBuffer);
    if (!uploadedHash) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "Could not compute image hash",
        rawData: { reason: "hash_failed" },
      });
      return findings;
    }

    // Collect avatar URLs from all findings across all profiles
    const allFindings = await db.getOsintFindings({ limit: 1000 });
    const avatarUrls = new Map(); // url → { profileId, source }

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

    // Also collect from entity graph (entity_type = 'image')
    const imageEntities = await db.getOsintEntities({ type: "image", limit: 200 });
    for (const e of imageEntities) {
      if (e.value?.startsWith("http") && !avatarUrls.has(e.value)) {
        avatarUrls.set(e.value, { profileId: e.profile_id, module: e.source_module, platform: "entity" });
      }
    }

    if (avatarUrls.size === 0) {
      findings.push({
        category: "metadata",
        severity: "info",
        title: "No avatars found to compare against",
        description: "Run scans on email/username profiles first to collect avatar images, then re-scan this image profile.",
        rawData: { reason: "no_avatars" },
      });
      return findings;
    }

    findings.push({
      category: "metadata",
      severity: "info",
      title: `Comparing against ${avatarUrls.size} collected avatar(s)`,
      rawData: { avatarCount: avatarUrls.size },
    });

    // Download and compare each avatar
    let matches = 0;
    const compared = [];

    for (const [url, meta] of avatarUrls) {
      const release = await rateLimiter.acquire();
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; OSINT-Scanner/1.0)" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) continue;

        const avatarBuffer = Buffer.from(await res.arrayBuffer());
        const avatarHash = await computePHash(avatarBuffer);
        if (!avatarHash) continue;

        const sim = similarity(uploadedHash, avatarHash);
        compared.push({ url, similarity: sim, ...meta });

        if (sim >= 85) {
          matches++;
          const prof = await db.getOsintProfile(meta.profileId);
          findings.push({
            category: "exposure",
            severity: "high",
            title: `High match (${sim}%) with avatar from ${prof?.label || `profile #${meta.profileId}`}`,
            description: `Perceptual hash similarity: ${sim}%\nSource: ${meta.platform}\nAvatar: ${url}\n\nThis strongly suggests the same photo or a derivative is used across profiles.`,
            sourceUrl: url,
            rawData: {
              similarity: sim, avatarUrl: url,
              matchedProfileId: meta.profileId,
              matchedProfileLabel: prof?.label,
              platform: meta.platform,
              pHashMatch: true,
            },
            remediation: "Using the same photo across platforms makes cross-platform identity linking trivial. Use unique images per platform.",
          });
        } else if (sim >= 60) {
          matches++;
          const prof = await db.getOsintProfile(meta.profileId);
          findings.push({
            category: "exposure",
            severity: "medium",
            title: `Possible match (${sim}%) with avatar from ${prof?.label || `profile #${meta.profileId}`}`,
            description: `Perceptual hash similarity: ${sim}%\nSource: ${meta.platform}\nAvatar: ${url}`,
            sourceUrl: url,
            rawData: {
              similarity: sim, avatarUrl: url,
              matchedProfileId: meta.profileId,
              matchedProfileLabel: prof?.label,
              platform: meta.platform,
              pHashMatch: true,
            },
          });
        }
      } catch {
        // Download or comparison failed — skip
      } finally {
        release();
      }
    }

    // Summary
    findings.push({
      category: "metadata",
      severity: matches > 0 ? "medium" : "info",
      title: `Avatar comparison: ${matches} match(es) from ${compared.length} compared`,
      description: matches > 0
        ? `Found ${matches} avatar(s) with >60% perceptual similarity to the uploaded image.`
        : `No matching avatars found among ${compared.length} compared images.`,
      rawData: {
        totalCompared: compared.length,
        totalMatches: matches,
        topMatches: compared.filter((c) => c.similarity >= 60).sort((a, b) => b.similarity - a.similarity).slice(0, 10),
      },
    });

    return findings;
  },
};
