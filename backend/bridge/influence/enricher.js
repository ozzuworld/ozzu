/**
 * OSINT Enricher — NLP + face matching + relationship inference
 *
 * Takes normalized observations and enriches them with:
 * - Face matching via Qdrant (51M+ vectors) for cross-platform identity resolution
 * - Claude NLP for entity extraction, sentiment, relationship inference
 * - Auto-linking observations to KG subjects
 *
 * Pipeline stage: COLLECT → NORMALIZE → [ENRICH] → STORE
 *
 * Directive: dir_1775980363354
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { FormData } = require("node:buffer") ? global : {};

const FACE_SERVICE_URL = process.env.FACE_SERVICE_URL || "http://localhost:5555";
const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:3333";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const PHOTO_DIR = path.join(__dirname, "..", "..", "..", "data", "kg-photos");

// ── Face Matching ──

/**
 * Two-tier face matching:
 * 1. First search kg_faces (small, fast) — known KG subjects
 * 2. If no match and deepSearch=true, search faces (51M, slow)
 * 3. After any collection, index the face into kg_faces
 *
 * @param {string} photoPath - local path to screenshot/avatar image
 * @param {object} opts - { threshold: 0.4, topK: 10, deepSearch: false }
 * @returns {Promise<{matches: Array, facesDetected: number, embedding: Array|null, collection: string}>}
 */
async function matchFace(photoPath, opts = {}) {
  const threshold = opts.threshold || 0.4;
  const topK = opts.topK || 10;

  if (!fs.existsSync(photoPath)) {
    return { matches: [], facesDetected: 0, error: "Photo not found" };
  }

  try {
    // Step 1: Detect face and get embedding
    const imageBuffer = fs.readFileSync(photoPath);
    const base64Image = imageBuffer.toString("base64");

    const detectBody = new URLSearchParams();
    detectBody.append("base64_image", base64Image);

    const detectResp = await fetch(`${FACE_SERVICE_URL}/detect-and-embed`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: detectBody.toString(),
      signal: AbortSignal.timeout(30000),
    });

    if (!detectResp.ok) {
      return { matches: [], facesDetected: 0, error: `Face detect error: ${detectResp.status}` };
    }

    const detected = await detectResp.json();
    if (!detected.faces || detected.faces.length === 0) {
      return { matches: [], facesDetected: 0, error: detected.error || "No face detected" };
    }

    const embedding = detected.faces[0].embedding;
    console.log(`[enricher] Face detected (${detected.faces.length} faces), searching kg_faces...`);

    // Step 2: Search kg_faces first (fast — small collection of known subjects)
    let matches = await searchCollection("kg_faces", embedding, topK, threshold);

    if (matches.length > 0) {
      console.log(`[enricher] kg_faces match: ${matches.length} results (top: ${matches[0].name} @ ${(matches[0].score * 100).toFixed(1)}%)`);
      return { matches, facesDetected: 1, embedding, collection: "kg_faces" };
    }

    // Step 3: Optionally search the full 51M faces collection (slow)
    if (opts.deepSearch) {
      console.log(`[enricher] No kg_faces match, deep searching 51M faces...`);
      matches = await searchCollection("faces", embedding, topK, threshold);
      if (matches.length > 0) {
        console.log(`[enricher] Deep search match: ${matches.length} results`);
        return { matches, facesDetected: 1, embedding, collection: "faces" };
      }
    }

    console.log(`[enricher] No face match found`);
    return { matches: [], facesDetected: 1, embedding, collection: null };
  } catch (err) {
    console.error(`[enricher] Face match failed:`, err.message);
    return { matches: [], facesDetected: 0, error: err.message };
  }
}

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";

/**
 * Search a specific Qdrant collection by embedding vector.
 * Calls Qdrant directly (not through face service) so we can target any collection.
 */
async function searchCollection(collection, embedding, topK, threshold) {
  try {
    const resp = await fetch(`${QDRANT_URL}/collections/${collection}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector: embedding,
        limit: topK,
        score_threshold: threshold,
        with_payload: true,
      }),
      signal: AbortSignal.timeout(collection === "faces" ? 120000 : 10000),
    });

    if (!resp.ok) return [];

    const result = await resp.json();
    return (result.result || []).map((m) => ({
      score: m.score,
      profile: m.payload?.profile || null,
      name: m.payload?.name || m.payload?.label || null,
      dataset: m.payload?.dataset || null,
      subjectId: m.payload?.subject_id || null,
      id: m.id,
    }));
  } catch (err) {
    console.error(`[enricher] Search ${collection} failed:`, err.message);
    return [];
  }
}

/**
 * Index a face embedding into kg_faces for future fast matching.
 * Called after collecting a profile photo for a KG subject.
 *
 * @param {number} subjectId - KG subject ID
 * @param {string} name - display name
 * @param {Array} embedding - 512-dim face embedding
 * @param {object} metadata - extra payload
 */
async function indexFaceForSubject(subjectId, name, embedding, metadata = {}) {
  try {
    const formBody = new URLSearchParams();
    formBody.append("embedding", JSON.stringify(embedding));
    formBody.append("label", name || `subject_${subjectId}`);
    formBody.append("profile", String(subjectId));
    formBody.append("metadata", JSON.stringify({ subject_id: subjectId, ...metadata }));

    // Use the index endpoint but target kg_faces collection
    // We'll call Qdrant directly for this
    const { QdrantClient } = await import("@qdrant/js-client-rest").catch(() => ({}));

    // Fallback: call bridge to store via API
    const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "identity",
        key: "face_embedding_indexed",
        value: JSON.stringify({ collection: "kg_faces", name, indexed_at: new Date().toISOString() }),
        source: "enricher:face",
        confidence: 90,
      }),
    });

    // Index directly into Qdrant via HTTP API
    const qdrantResp = await fetch("http://localhost:6333/collections/kg_faces/points?wait=true", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [{
          id: subjectId * 1000 + Math.floor(Math.random() * 1000), // unique point ID
          vector: embedding,
          payload: {
            subject_id: subjectId,
            name: name,
            platform: metadata.platform || null,
            indexed_at: new Date().toISOString(),
          },
        }],
      }),
    });

    if (qdrantResp.ok) {
      console.log(`[enricher] Indexed face for subject ${subjectId} (${name}) into kg_faces`);
    } else {
      console.error(`[enricher] Failed to index face:`, await qdrantResp.text());
    }
  } catch (err) {
    console.error(`[enricher] Failed to index face:`, err.message);
  }
}

/**
 * Detect all faces in a screenshot (e.g. group photo).
 * Returns embeddings + bounding boxes for each face.
 */
async function detectFaces(photoPath) {
  if (!fs.existsSync(photoPath)) {
    return { faces: [], error: "Photo not found" };
  }

  try {
    const imageBuffer = fs.readFileSync(photoPath);
    const base64Image = imageBuffer.toString("base64");

    const formBody = new URLSearchParams();
    formBody.append("base64_image", base64Image);

    const resp = await fetch(`${FACE_SERVICE_URL}/detect-and-embed`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody.toString(),
    });

    const result = await resp.json();
    console.log(`[enricher] Detected ${result.faces?.length || 0} faces in photo`);
    return result;
  } catch (err) {
    console.error(`[enricher] Face detection failed:`, err.message);
    return { faces: [], error: err.message };
  }
}

/**
 * Match all faces in a photo against the DB.
 * Used for group photos — returns matches per face.
 */
async function matchAllFaces(photoPath, opts = {}) {
  const detected = await detectFaces(photoPath);
  if (!detected.faces || detected.faces.length === 0) {
    return { results: [], facesDetected: 0, error: detected.error || "No faces detected" };
  }

  const results = [];
  for (const face of detected.faces) {
    if (!face.embedding) continue;

    const formBody = new URLSearchParams();
    formBody.append("embedding", JSON.stringify(face.embedding));
    formBody.append("top_k", String(opts.topK || 5));
    formBody.append("threshold", String(opts.threshold || 0.4));

    try {
      const resp = await fetch(`${FACE_SERVICE_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: formBody.toString(),
      });
      const result = await resp.json();

      results.push({
        bbox: face.bbox,
        matches: (result.matches || []).map((m) => ({
          score: m.score,
          profile: m.payload?.profile || null,
          name: m.payload?.name || m.payload?.label || null,
        })),
      });
    } catch (err) {
      results.push({ bbox: face.bbox, matches: [], error: err.message });
    }
  }

  return { results, facesDetected: detected.faces.length };
}

// ── Claude NLP Enrichment ──

/**
 * Use Claude to extract structured intelligence from normalized profile/post data.
 * Returns entities, relationships, sentiment, and inferred facts.
 */
async function nlpEnrich(normalizedData, context = {}) {
  // Try to get API key from env or from the bridge's config
  let apiKey = ANTHROPIC_API_KEY;
  if (!apiKey) {
    try {
      const envFile = path.join(__dirname, "..", "..", "..", "private", "influence-ops-credentials.env");
      if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, "utf8");
        const match = envContent.match(/ANTHROPIC_API_KEY=(.+)/);
        if (match) apiKey = match[1].trim();
      }
    } catch {}
  }

  if (!apiKey) {
    console.log("[enricher] No Anthropic API key — skipping NLP enrichment");
    return { entities: [], relationships: [], sentiment: null, inferred_facts: [], error: "No API key" };
  }

  const prompt = buildEnrichmentPrompt(normalizedData, context);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { entities: [], relationships: [], sentiment: null, inferred_facts: [], error: `Claude API: ${resp.status}` };
    }

    const result = await resp.json();
    const text = result.content?.[0]?.text || "";

    // Parse JSON from Claude's response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { entities: [], relationships: [], sentiment: null, inferred_facts: [], raw: text };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`[enricher] NLP: ${parsed.entities?.length || 0} entities, ${parsed.relationships?.length || 0} relationships, sentiment=${parsed.sentiment}`);
    return parsed;
  } catch (err) {
    console.error(`[enricher] NLP enrichment failed:`, err.message);
    return { entities: [], relationships: [], sentiment: null, inferred_facts: [], error: err.message };
  }
}

function buildEnrichmentPrompt(data, context) {
  const subjectName = context.subjectName || "unknown";
  const platform = data.platform || "unknown";

  return `You are an OSINT intelligence analyst. Extract structured intelligence from this ${platform} data about/related to "${subjectName}".

DATA:
${JSON.stringify(data, null, 2)}

Return a JSON object with:
{
  "entities": [
    {"name": "...", "type": "person|org|location|event|product", "role": "mentioned|author|employer|colleague|..."}
  ],
  "relationships": [
    {"from": "...", "to": "...", "type": "works_at|knows|follows|mentions|affiliated|...","confidence": 0-100}
  ],
  "sentiment": "positive|negative|neutral",
  "inferred_facts": [
    {"category": "employment|location|education|interest|skill|social", "key": "...", "value": "...", "confidence": 0-100}
  ],
  "topics": ["..."],
  "summary": "1-sentence intelligence summary"
}

Rules:
- Only extract what is clearly stated or strongly implied
- Set confidence 50-70 for inferred, 80-100 for explicit
- For profiles: focus on employment, location, skills, connections
- For posts: focus on topics, sentiment, entities mentioned
- Return ONLY the JSON, no explanation`;
}

// ── Orchestrator ──

/**
 * Enrich a normalized observation with face matching + NLP.
 *
 * @param {object} normalized - output from normalizer
 * @param {object} opts - { subjectId, subjectName, photoPath, skipNLP, skipFace }
 * @returns {{ faceMatch: object|null, nlp: object|null, enrichedAt: string }}
 */
async function enrich(normalized, opts = {}) {
  const results = {
    faceMatch: null,
    nlp: null,
    enrichedAt: new Date().toISOString(),
  };

  // Face matching
  if (!opts.skipFace && opts.photoPath) {
    results.faceMatch = await matchFace(opts.photoPath, {
      threshold: opts.faceThreshold || 0.4,
      topK: opts.faceTopK || 10,
    });
  }

  // NLP enrichment
  if (!opts.skipNLP) {
    results.nlp = await nlpEnrich(normalized, {
      subjectName: opts.subjectName || null,
    });
  }

  return results;
}

/**
 * Full enrichment pipeline for a collected profile:
 * 1. Match face against Qdrant
 * 2. Run NLP extraction
 * 3. Store enrichment results as KG facts/observations
 *
 * @param {number} subjectId - KG subject ID
 * @param {object} normalized - normalized profile data
 * @param {string|null} photoFilename - filename in PHOTO_DIR
 */
async function enrichAndStore(subjectId, normalized, photoFilename) {
  // Prefer avatar crop over full screenshot for face matching
  let photoPath = null;
  if (photoFilename) {
    const avatarFilename = photoFilename.replace(".png", "_avatar.png");
    const avatarPath = path.join(PHOTO_DIR, avatarFilename);
    const fullPath = path.join(PHOTO_DIR, photoFilename);
    photoPath = fs.existsSync(avatarPath) ? avatarPath : fullPath;
  }

  // Get subject name for NLP context
  let subjectName = normalized.display_name || normalized.name || null;
  if (!subjectName) {
    try {
      const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}`);
      const subject = await resp.json();
      subjectName = subject.name;
    } catch {}
  }

  const enrichment = await enrich(normalized, {
    subjectId,
    subjectName,
    photoPath,
  });

  // Store face match results
  if (enrichment.faceMatch) {
    if (enrichment.faceMatch.matches.length > 0) {
      const topMatch = enrichment.faceMatch.matches[0];
      await storeFact(subjectId, {
        category: "identity",
        key: "face_match_top",
        value: JSON.stringify({
          score: topMatch.score,
          matched_name: topMatch.name,
          matched_profile: topMatch.profile,
          total_matches: enrichment.faceMatch.matches.length,
          collection: enrichment.faceMatch.collection,
        }),
        source: "enricher:face",
        confidence: Math.round(topMatch.score * 100),
      });
      console.log(`[enricher] Face match stored: top=${topMatch.name} (${(topMatch.score * 100).toFixed(1)}%)`);
    }

    // Index this face into kg_faces for future fast matching
    if (enrichment.faceMatch.embedding && enrichment.faceMatch.facesDetected > 0) {
      const displayName = normalized.display_name || normalized.name || null;
      await indexFaceForSubject(subjectId, displayName, enrichment.faceMatch.embedding, {
        platform: normalized.platform,
      });
    }
  }

  // Store NLP results
  if (enrichment.nlp && !enrichment.nlp.error) {
    // Store inferred facts
    for (const fact of enrichment.nlp.inferred_facts || []) {
      await storeFact(subjectId, {
        category: fact.category,
        key: fact.key,
        value: fact.value,
        source: "enricher:nlp",
        confidence: fact.confidence || 50,
      });
    }

    // Store sentiment as observation metadata
    if (enrichment.nlp.sentiment) {
      await storeObservation(subjectId, {
        platform: normalized.platform,
        observation_type: "activity",
        content: JSON.stringify({
          type: "nlp_enrichment",
          sentiment: enrichment.nlp.sentiment,
          topics: enrichment.nlp.topics,
          summary: enrichment.nlp.summary,
          entities: enrichment.nlp.entities,
          relationships: enrichment.nlp.relationships,
        }),
      });
    }

    console.log(`[enricher] NLP stored: ${enrichment.nlp.inferred_facts?.length || 0} facts, sentiment=${enrichment.nlp.sentiment}`);
  }

  return enrichment;
}

// ── KG API Helpers ──

async function storeFact(subjectId, fact) {
  try {
    const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fact),
    });
    return resp.json();
  } catch (err) {
    console.error(`[enricher] Failed to store fact:`, err.message);
    return null;
  }
}

async function storeObservation(subjectId, obs) {
  try {
    const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(obs),
    });
    return resp.json();
  } catch (err) {
    console.error(`[enricher] Failed to store observation:`, err.message);
    return null;
  }
}

module.exports = {
  enrich,
  enrichAndStore,
  matchFace,
  detectFaces,
  matchAllFaces,
  indexFaceForSubject,
  searchCollection,
  nlpEnrich,
  PHOTO_DIR,
};
