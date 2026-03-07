// Face Recognition Engine — proper biometric face search
// Uses ArcFace embeddings + Qdrant vector DB instead of broken reverse image search
//
// Pipeline:
//   1. Upload photo → detect faces → generate 512-D ArcFace embeddings
//   2. Store target embedding in Qdrant
//   3. Search: scrape images from web/social → embed each → compare in Qdrant
//   4. Return verified face matches with similarity scores

const fs = require("fs");
const path = require("path");

const FACE_API = "http://127.0.0.1:5555";
const BROWSER_API = "http://127.0.0.1:3334";
const MATCH_THRESHOLD = 0.4;

// --- Face API helpers ---

async function faceFetch(endpoint, formData, timeout = 20000) {
  try {
    const res = await fetch(`${FACE_API}${endpoint}`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function browserFetch(endpoint, body, timeout = 25000) {
  try {
    const res = await fetch(`${BROWSER_API}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// --- Core: embed a face from file or URL ---

async function embedFromFile(imagePath) {
  const buf = fs.readFileSync(imagePath);
  const form = new FormData();
  form.append("base64_image", buf.toString("base64"));
  return faceFetch("/embed", form);
}

async function embedFromUrl(imageUrl) {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return null; // too small, probably error page
    const form = new FormData();
    form.append("base64_image", buf.toString("base64"));
    return faceFetch("/embed", form);
  } catch {
    return null;
  }
}

// --- Core: index a face into Qdrant ---

async function indexFace(imagePath, metadata = {}) {
  const buf = fs.readFileSync(imagePath);
  const form = new FormData();
  form.append("base64_image", buf.toString("base64"));
  if (metadata.profile_id) form.append("profile_id", metadata.profile_id);
  if (metadata.source_url) form.append("source_url", metadata.source_url);
  if (metadata.source_platform) form.append("source_platform", metadata.source_platform);
  if (metadata.label) form.append("label", metadata.label);
  if (metadata.face_id) form.append("face_id", metadata.face_id);
  return faceFetch("/index", form);
}

async function indexFaceFromUrl(imageUrl, metadata = {}) {
  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return null;
    const form = new FormData();
    form.append("base64_image", buf.toString("base64"));
    if (metadata.profile_id) form.append("profile_id", metadata.profile_id);
    if (metadata.source_url) form.append("source_url", metadata.source_url);
    if (metadata.source_platform) form.append("source_platform", metadata.source_platform);
    if (metadata.label) form.append("label", metadata.label);
    if (metadata.face_id) form.append("face_id", metadata.face_id);
    return faceFetch("/index", form);
  } catch {
    return null;
  }
}

// --- Core: search Qdrant for matching faces ---

async function searchFaces(imagePath, opts = {}) {
  const buf = fs.readFileSync(imagePath);
  const form = new FormData();
  form.append("base64_image", buf.toString("base64"));
  form.append("top_k", String(opts.topK || 50));
  form.append("threshold", String(opts.threshold || MATCH_THRESHOLD));
  if (opts.excludeProfile) form.append("exclude_profile", opts.excludeProfile);
  return faceFetch("/search", form, 30000);
}

// --- Web scraping: collect candidate images from search engines ---

async function scrapeImageUrls(imagePath, profileId) {
  const urls = [];
  const sessionId = `face-eng-${Date.now()}`;

  // Create browser sessions
  await browserFetch("/session/new", { session_id: sessionId });
  await browserFetch("/session/new", { session_id: `${sessionId}-yx` });

  try {
    // --- Yandex (works from datacenter IPs) ---
    const yandexUrls = await _scrapeYandexFaceUrls(`${sessionId}-yx`, imagePath, profileId);
    urls.push(...yandexUrls);
    console.log(`[face-engine] Yandex scraped ${yandexUrls.length} candidate image URLs`);

    // --- Google (may CAPTCHA from datacenter, but try) ---
    const googleUrls = await _scrapeGoogleImageUrls(sessionId, imagePath, profileId);
    urls.push(...googleUrls);
    console.log(`[face-engine] Google scraped ${googleUrls.length} candidate image URLs`);
  } finally {
    await browserFetch("/session/close", { session_id: sessionId }).catch(() => {});
    await browserFetch("/session/close", { session_id: `${sessionId}-yx` }).catch(() => {});
  }

  // Deduplicate
  const seen = new Set();
  return urls.filter(u => {
    if (seen.has(u.imageUrl)) return false;
    seen.add(u.imageUrl);
    return true;
  });
}

async function _scrapeYandexFaceUrls(sessionId, imagePath, profileId) {
  const results = [];
  try {
    // Navigate to Yandex Images
    const nav = await browserFetch("/navigate", {
      url: "https://yandex.com/images/",
      session_id: sessionId,
    }, 30000);
    if (!nav?.ok) return results;
    await _wait(2000);

    // Click camera button
    await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const btn = document.querySelector('.input__cbir-button, .HeaderDesktopForm-VisualSearch, [class*="CbirButton"]');
        if (btn) { btn.click(); return "ok"; }
        return "not_found";
      })()`,
    });
    await _wait(2000);

    // Upload file
    const buf = fs.readFileSync(imagePath);
    const upload = await browserFetch("/upload-file", {
      session_id: sessionId,
      base64: buf.toString("base64"),
      filename: path.basename(imagePath),
      mime_type: "image/jpeg",
    }, 30000);

    if (!upload?.ok) {
      // URL fallback
      const bridgeUrl = process.env.BRIDGE_PUBLIC_URL || "https://home.ozzu.world/bridge";
      const imageUrl = `${bridgeUrl}/osint/images/${profileId}`;
      await browserFetch("/navigate", {
        url: `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(imageUrl)}`,
        session_id: sessionId,
      }, 30000);
    }
    await _wait(6000);

    // Extract ALL image URLs from results (not text — we want images to embed)
    const extract = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const results = [];
        // People faces Yandex identifies
        document.querySelectorAll('.CbirPeople-Item, .CbirFaces-Item').forEach(el => {
          const img = el.querySelector('img');
          const name = el.querySelector('.CbirPeople-ItemName, .CbirFaces-ItemName')?.textContent?.trim();
          const link = el.querySelector('a')?.href;
          if (img?.src) results.push({ imageUrl: img.src, sourceUrl: link || '', label: name || '', type: 'face' });
        });
        // Sites with matching images — get the actual image thumbnails
        document.querySelectorAll('.CbirSites-Item').forEach(el => {
          const img = el.querySelector('img');
          const link = el.querySelector('a')?.href;
          const title = el.querySelector('.CbirSites-ItemTitle')?.textContent?.trim();
          if (img?.src) results.push({ imageUrl: img.src, sourceUrl: link || '', label: title || '', type: 'site' });
        });
        // Similar images
        document.querySelectorAll('.CbirOtherSizes-Item img, .similar__thumb img, .CbirRelated-Item img').forEach(img => {
          const parent = img.closest('a');
          if (img.src) results.push({ imageUrl: img.src, sourceUrl: parent?.href || '', label: '', type: 'similar' });
        });
        // Identity guess text
        document.querySelectorAll('.CbirObjectResponse-Title, .Tags-Wrapper .Tags-Item, .CbirTags-Item').forEach(el => {
          const text = el.textContent?.trim();
          if (text && text.length > 1) results.push({ label: text, type: 'identity_guess' });
        });
        return JSON.stringify(results.slice(0, 100));
      })()`,
    }, 15000);

    if (extract?.result) {
      try {
        const parsed = JSON.parse(extract.result);
        for (const r of parsed) {
          if (r.imageUrl) {
            results.push({
              imageUrl: r.imageUrl.startsWith("//") ? `https:${r.imageUrl}` : r.imageUrl,
              sourceUrl: r.sourceUrl || "",
              label: r.label || "",
              engine: "yandex",
              type: r.type || "unknown",
            });
          }
        }
      } catch {}
    }
  } catch (err) {
    console.error("[face-engine] Yandex scrape error:", err.message);
  }
  return results;
}

async function _scrapeGoogleImageUrls(sessionId, imagePath, profileId) {
  const results = [];
  try {
    const nav = await browserFetch("/navigate", {
      url: "https://www.google.com/imghp",
      session_id: sessionId,
    }, 30000);
    if (!nav?.ok) return results;
    await _wait(2000);

    // Click camera button
    const cam = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const btn = document.querySelector('[aria-label="Search by image"], .nDcEnd, .Gdd5U, .tdmBEe');
        if (btn) { btn.click(); return "ok"; }
        return "not_found";
      })()`,
    });
    if (!cam?.result?.includes("ok")) return results;
    await _wait(2000);

    // Upload file
    const buf = fs.readFileSync(imagePath);
    const upload = await browserFetch("/upload-file", {
      session_id: sessionId,
      base64: buf.toString("base64"),
      filename: path.basename(imagePath),
      mime_type: "image/jpeg",
    }, 30000);
    if (!upload?.ok) return results;
    await _wait(6000);

    // Check for CAPTCHA
    const captchaCheck = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `document.title.includes('sorry') || document.title.includes('captcha') || document.querySelector('#captcha-form') ? 'captcha' : 'ok'`,
    });
    if (captchaCheck?.result === "captcha") {
      console.log("[face-engine] Google CAPTCHA detected, skipping");
      return results;
    }

    // Extract image URLs from results
    const extract = await browserFetch("/evaluate", {
      session_id: sessionId,
      script: `(() => {
        const results = [];
        // Best guess
        const guess = document.querySelector('.fKDtNb, #topstuff a, .rg_anbg')?.textContent?.trim();
        if (guess) results.push({ label: guess, type: 'identity_guess' });
        // Image thumbnails
        document.querySelectorAll('img[data-src], img.rg_i, img.YQ4gaf, .isv-r img').forEach(img => {
          const src = img.getAttribute('data-src') || img.src;
          if (src && src.startsWith('http') && !src.includes('google.com/images')) {
            const parent = img.closest('a');
            results.push({ imageUrl: src, sourceUrl: parent?.href || '', type: 'image' });
          }
        });
        // Page results
        document.querySelectorAll('#search .g a[href^="http"], #rso a[href^="http"]').forEach(a => {
          if (!a.href.includes('google.com')) {
            const img = a.querySelector('img');
            results.push({ sourceUrl: a.href, imageUrl: img?.src || '', label: a.textContent?.trim()?.substring(0, 200) || '', type: 'page' });
          }
        });
        return JSON.stringify(results.slice(0, 60));
      })()`,
    }, 15000);

    if (extract?.result) {
      try {
        const parsed = JSON.parse(extract.result);
        for (const r of parsed) {
          if (r.imageUrl) {
            results.push({
              imageUrl: r.imageUrl,
              sourceUrl: r.sourceUrl || "",
              label: r.label || "",
              engine: "google",
              type: r.type || "unknown",
            });
          }
        }
      } catch {}
    }
  } catch (err) {
    console.error("[face-engine] Google scrape error:", err.message);
  }
  return results;
}

// --- Full pipeline: scrape + embed + compare ---

async function runFaceSearch(imagePath, profileId, opts = {}) {
  console.log(`[face-engine] Starting face search for profile ${profileId}`);

  // Step 1: Embed the target face and index it
  const indexResult = await indexFace(imagePath, {
    profile_id: String(profileId),
    label: opts.label || "",
    source_platform: "upload",
    face_id: `target-${profileId}`,
  });
  if (!indexResult || indexResult.indexed === 0) {
    return { error: "No face detected in uploaded image", matches: [], indexed: 0, scraped: 0 };
  }
  console.log(`[face-engine] Target face indexed (det_score: ${indexResult.det_score})`);

  // Step 2: Get target embedding for comparison
  const embedResult = await embedFromFile(imagePath);
  if (!embedResult?.faces?.length) {
    return { error: "Could not generate target embedding", matches: [], indexed: 1, scraped: 0 };
  }
  const targetEmbedding = embedResult.faces[0].embedding;

  // Step 3: Scrape candidate images from search engines
  const candidates = await scrapeImageUrls(imagePath, profileId);
  console.log(`[face-engine] Scraped ${candidates.length} candidate images total`);

  // Step 4: For each candidate image, detect face + compare embedding
  const matches = [];
  let indexed = 1; // target already indexed
  let processed = 0;
  const identityGuesses = [];

  // Collect identity guesses from scraper metadata
  for (const c of candidates) {
    if (c.type === "identity_guess" && c.label) {
      identityGuesses.push(c.label);
    }
  }

  // Process candidates with faces in parallel batches
  const imageCandidates = candidates.filter(c => c.imageUrl && c.imageUrl.startsWith("http"));
  const BATCH_SIZE = 5;

  for (let i = 0; i < imageCandidates.length; i += BATCH_SIZE) {
    const batch = imageCandidates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (candidate) => {
        processed++;
        const embedRes = await embedFromUrl(candidate.imageUrl);
        if (!embedRes?.faces?.length) return null;

        const candidateEmb = embedRes.faces[0].embedding;
        const sim = _cosineSim(targetEmbedding, candidateEmb);

        if (sim >= (opts.threshold || MATCH_THRESHOLD)) {
          // Index this match into Qdrant for future searches
          const faceId = `match-${profileId}-${processed}`;
          try {
            const form = new FormData();
            form.append("embeddings", JSON.stringify([{
              embedding: candidateEmb,
              face_id: faceId,
              profile_id: String(profileId),
              source_url: candidate.sourceUrl || candidate.imageUrl,
              source_platform: candidate.engine || "",
              label: candidate.label || "",
              det_score: embedRes.faces[0].det_score,
            }]));
            await faceFetch("/batch-index", form);
            indexed++;
          } catch {}

          return {
            similarity: Math.round(sim * 10000) / 10000,
            sourceUrl: candidate.sourceUrl || "",
            imageUrl: candidate.imageUrl,
            engine: candidate.engine || "",
            label: candidate.label || "",
            type: candidate.type || "",
            faceId,
          };
        }
        return null;
      })
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value) {
        matches.push(result.value);
      }
    }
  }

  // Sort by similarity descending
  matches.sort((a, b) => b.similarity - a.similarity);

  // Filter identity guesses
  const dimRe = /^\d+[×x]\d+$/;
  const genericWords = new Set(["человек", "person", "people", "man", "woman", "photo", "image", "picture"]);
  const filteredGuesses = [...new Set(identityGuesses)]
    .filter(g => g && !dimRe.test(g) && !genericWords.has(g.toLowerCase()));

  console.log(`[face-engine] Search complete: ${matches.length} verified matches from ${processed} candidates (${indexed} total indexed)`);

  return {
    matches,
    identityGuesses: filteredGuesses,
    totalProcessed: processed,
    totalIndexed: indexed,
    totalScraped: candidates.length,
    engines: {
      yandex: candidates.filter(c => c.engine === "yandex").length,
      google: candidates.filter(c => c.engine === "google").length,
    },
  };
}

// --- Utility ---

function _cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function _wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getStats() {
  try {
    const res = await fetch(`${FACE_API}/stats`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

module.exports = {
  embedFromFile,
  embedFromUrl,
  indexFace,
  indexFaceFromUrl,
  searchFaces,
  runFaceSearch,
  getStats,
  MATCH_THRESHOLD,
};
