// Face Recognition Engine — proper biometric face search
// Uses ArcFace embeddings + Qdrant vector DB instead of broken reverse image search
//
// Pipeline:
//   1. Upload photo → detect faces → generate 512-D ArcFace embeddings
//   2. Store target embedding in Qdrant
//   3. Collect candidate images from ALL sources (browser scrapers + APIs + enrichment)
//   4. Embed each candidate → cosine similarity → verified face matches

const fs = require("fs");
const faceSources = require("./face-sources");

const FACE_API = "http://127.0.0.1:5555";
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
    if (buf.length < 1000) return null;
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

// --- Full pipeline: collect from ALL sources + embed + compare ---

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

  // Step 3: Collect candidates from ALL sources (Yandex, Bing, Google, SerpApi, FaceCheck, Search4Faces)
  const { candidates: browserCandidates, sources } = await faceSources.collectAllCandidates(imagePath, profileId, []);

  // Extract identity guesses from scrapers
  const dimRe = /^\d+[×x]\d+$/;
  const genericWords = new Set(["человек", "person", "people", "man", "woman", "photo", "image", "picture"]);
  const identityGuesses = [];
  for (const c of browserCandidates) {
    if (c.type === "identity_guess" && c.label) {
      identityGuesses.push(c.label);
    }
  }
  const filteredGuesses = [...new Set(identityGuesses)]
    .filter(g => g && !dimRe.test(g) && !genericWords.has(g.toLowerCase()));

  // Step 3b: Enrichment pass — use identity guesses to find more images (Wikipedia, News)
  let enrichmentCandidates = [];
  if (filteredGuesses.length > 0) {
    console.log(`[face-engine] Identity guesses: ${filteredGuesses.join(", ")} — running enrichment`);
    const [wikiR, newsR] = await Promise.allSettled([
      faceSources.searchWikipedia(filteredGuesses),
      faceSources.searchGoogleNews(filteredGuesses),
    ]);
    if (wikiR.status === "fulfilled") enrichmentCandidates.push(...(wikiR.value || []));
    if (newsR.status === "fulfilled") enrichmentCandidates.push(...(newsR.value || []));
    console.log(`[face-engine] Enrichment: ${enrichmentCandidates.length} candidates (Wikipedia + News)`);
  }

  // Merge + deduplicate all candidates
  const allCandidates = [...browserCandidates, ...enrichmentCandidates];
  const seen = new Set();
  const uniqueCandidates = allCandidates
    .filter(c => c.imageUrl && c.imageUrl.startsWith("http"))
    .filter(c => { if (seen.has(c.imageUrl)) return false; seen.add(c.imageUrl); return true; });

  console.log(`[face-engine] Total unique image candidates: ${uniqueCandidates.length}`);

  // Step 4: Embed each candidate + compare biometrically
  const matches = [];
  let indexed = 1;
  let processed = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < uniqueCandidates.length; i += BATCH_SIZE) {
    const batch = uniqueCandidates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (candidate) => {
        processed++;
        const embedRes = await embedFromUrl(candidate.imageUrl);
        if (!embedRes?.faces?.length) return null;

        const candidateEmb = embedRes.faces[0].embedding;
        const sim = _cosineSim(targetEmbedding, candidateEmb);

        if (sim >= (opts.threshold || MATCH_THRESHOLD)) {
          // Index match into Qdrant
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

  matches.sort((a, b) => b.similarity - a.similarity);

  // Build source breakdown
  const sourceBreakdown = { ...sources };
  sourceBreakdown.wikipedia = enrichmentCandidates.filter(c => c.engine === "wikipedia").length;
  sourceBreakdown.google_news = enrichmentCandidates.filter(c => c.engine === "google_news").length;

  console.log(`[face-engine] Complete: ${matches.length} verified matches from ${processed} candidates (${indexed} indexed)`);

  return {
    matches,
    identityGuesses: filteredGuesses,
    totalProcessed: processed,
    totalIndexed: indexed,
    totalScraped: allCandidates.length,
    sources: sourceBreakdown,
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
