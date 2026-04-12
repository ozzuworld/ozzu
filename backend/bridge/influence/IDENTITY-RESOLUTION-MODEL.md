# Cross-Platform Identity Resolution Model

## The Core Problem

Given a seed (name + email), sherlock/maigret discover 50-300 potential accounts across platforms.
The raw false positive rate from username enumeration is **~44%** (accounts exist but belong to
different people) plus **~32%** detection errors (accounts don't actually exist). Only ~24% of
raw hits are true positives belonging to the target. (Source: Sherlock deep-dive analysis, 2024.)

This model defines how to score, weight, and threshold the signals that separate the target's
real accounts from coincidental username collisions.

---

## 1. Signal Taxonomy

### Tier 1: Deterministic Anchors (binary — match or don't)

These signals alone can **confirm** identity with near-certainty.

| Signal | Description | Weight | Notes |
|--------|-------------|--------|-------|
| **Email anchor** | Same email appears on multiple profiles | Deterministic | Strongest single signal. Checked via password-reset hint matching (e.g., `h***@g****.com`), contact sync, or profile-visible email |
| **Phone anchor** | Same phone number linked to accounts | Deterministic | Contact sync on IG/Telegram reveals phone-to-handle links. TextVerified numbers are known. |
| **Cross-link** | Profile A links to Profile B explicitly | Deterministic | Bio contains link to other platform. Maigret's recursive search catches these. |
| **OAuth/SSO trace** | Account created via Google SSO from known email | Deterministic | Detectable if platform shows "signed up with Google" or similar |

**Implementation**: Parse maigret/sherlock output. For each discovered account, check if the
profile page contains any of the seed emails/phones or links to other known accounts. One
deterministic anchor = confirmed match, no further scoring needed.

### Tier 2: Strong Probabilistic Signals (high individual weight)

| Signal | Description | How to Score | m probability | u probability |
|--------|-------------|-------------|---------------|---------------|
| **Face match** | Profile photo matches seed person's face | Cosine similarity via Qdrant (512-dim embeddings) | 0.92 (same person reuses photos) | 0.0001 (random face match at threshold 0.6) |
| **Display name match** | Full name matches seed name | Jaro-Winkler or Levenshtein similarity | 0.85 (people use real names) | 0.001 (frequency-dependent: "John Smith" = higher u) |
| **Username pattern** | Username follows same pattern as known accounts | Edit distance + pattern extraction (see below) | 0.59 (59% reuse same username) | 0.01 (common patterns: firstlast, first.last) |
| **Bio semantic match** | Bio mentions same employer/school/location/interests | Claude Haiku semantic comparison | 0.70 | 0.02 |

### Tier 3: Moderate Probabilistic Signals (supporting evidence)

| Signal | Description | How to Score | m probability | u probability |
|--------|-------------|-------------|---------------|---------------|
| **Location consistency** | Profile location matches seed location | Exact match, city-level fuzzy, country-level | 0.75 | 0.05 (varies by location granularity) |
| **Temporal pattern** | Posting times cluster in same timezone/hours | Build 168-dim vector (24h x 7d), cosine similarity | 0.60 | 0.15 |
| **Account age consistency** | Creation dates within plausible range | Check if join dates are within a few years | 0.80 | 0.30 |
| **Mutual connections** | Shared followers/friends with other confirmed accounts | Count overlap / Jaccard index | 0.50 | 0.05 |
| **Writing style** | Stylometric similarity (char n-grams, punctuation, emoji usage) | TF-IDF on char 3-grams, cosine similarity | 0.55 | 0.10 |

### Tier 4: Weak Signals (tiebreakers only)

| Signal | Description | m probability | u probability |
|--------|-------------|---------------|---------------|
| **Gender consistency** | Inferred gender matches across profiles | 0.95 | 0.50 |
| **Interest overlap** | Followed pages/groups overlap | 0.40 | 0.10 |
| **Platform ecosystem** | Uses same platform cluster (all Meta, all Google) | 0.30 | 0.20 |
| **Profile completeness** | Active vs. abandoned account | 0.60 | 0.40 |

---

## 2. Scoring Formula (Fellegi-Sunter Adapted)

The Fellegi-Sunter model computes a match weight as a sum of log-likelihood ratios:

```
Match_Weight = log2(lambda / (1 - lambda)) + SUM_i[ log2(m_i / u_i) ]
```

Where:
- `lambda` = prior probability any two records match (set to proportion of true matches in candidate pool)
- `m_i` = P(observation_i | records match) — probability of seeing this agreement if same person
- `u_i` = P(observation_i | records don't match) — probability of seeing this agreement by chance

### Converting to Probability

```
P(match | observations) = 2^Match_Weight / (1 + 2^Match_Weight)
```

### Reference Table

| Match Weight | Probability | Classification |
|-------------|-------------|----------------|
| >= 10 | >= 0.999 | **CONFIRMED** |
| 7 - 9.99 | 0.99 - 0.999 | **PROBABLE** |
| 4 - 6.99 | 0.94 - 0.99 | **POSSIBLE** |
| 0 - 3.99 | 0.50 - 0.94 | **UNLIKELY** (needs manual review) |
| < 0 | < 0.50 | **REJECTED** |

### Practical Match Weight Contributions

Using the m/u probabilities from above:

| Signal | Match (log2 m/u) | Non-match (log2 (1-m)/(1-u)) |
|--------|-------------------|-------------------------------|
| Face match (cosine > 0.6) | +13.2 | -3.5 |
| Display name exact match | +9.7 | -1.9 |
| Display name (common name like "John Smith") | +6.0 | -1.5 |
| Username exact match | +5.9 | -0.01 |
| Bio mentions same employer | +5.1 | -0.5 |
| Location exact city match | +3.9 | -0.4 |
| Mutual connections (Jaccard > 0.1) | +3.3 | -0.07 |
| Temporal pattern (cosine > 0.8) | +2.0 | -0.2 |
| Writing style (cosine > 0.7) | +2.5 | -0.15 |
| Gender consistent | +0.9 | -0.7 |

**Note on frequency-adjusted weights**: Rare values provide stronger evidence. A match on
username "xK4zuM4_2099" is worth far more than a match on "john_smith". Implement frequency
adjustment: `weight_adjusted = base_weight + log2(1 / frequency_in_population)`.

---

## 3. Implementation Architecture

### Phase 1: Discovery (already built)

```
Seed (name + email)
    |
    v
[sherlock / maigret] ---> raw_candidates[] (50-300 hits)
    |
    v
[De-duplicate + filter detection errors] ---> valid_candidates[] (30-150)
```

Maigret already handles error detection (CloudFlare stubs, 404s, censorship pages).
After filtering, each candidate has: `{platform, username, profile_url, status}`.

### Phase 2: Collection (enrich each candidate)

For each `valid_candidate`, collect via ADB/Redroid scraping or API:

```javascript
const SIGNALS_TO_COLLECT = {
  // From profile page (single scrape)
  display_name: null,      // text field
  username: null,           // text field
  bio: null,                // text field
  location: null,           // text field
  profile_photo: null,      // screenshot -> face embedding
  join_date: null,          // text field
  follower_count: null,     // number
  following_count: null,    // number
  website_links: [],        // urls in bio
  verified: false,          // blue check

  // From recent posts (scroll + scrape, ~20 posts)
  recent_post_timestamps: [],  // for temporal pattern
  recent_post_texts: [],       // for writing style + NLP

  // From connections (expensive — only for POSSIBLE candidates)
  followers_sample: [],        // first N followers for overlap check
  following_sample: [],        // first N following for overlap check
};
```

### Phase 3: Signal Scoring

```javascript
function scoreCandidate(seed, candidate, collectedData) {
  const weights = [];

  // --- Tier 1: Deterministic ---
  if (hasDeterministicAnchor(seed, collectedData)) {
    return { classification: 'CONFIRMED', confidence: 1.0, weight: Infinity };
  }

  // --- Tier 2: Strong signals ---

  // Face match
  if (collectedData.profile_photo_embedding) {
    const faceSim = cosineSimilarity(seed.face_embedding, collectedData.profile_photo_embedding);
    if (faceSim > 0.6) {
      weights.push({ signal: 'face_match', weight: 13.2, value: faceSim });
    } else if (faceSim > 0.4) {
      weights.push({ signal: 'face_weak', weight: 3.0, value: faceSim });
    } else {
      weights.push({ signal: 'face_nomatch', weight: -3.5, value: faceSim });
    }
  }

  // Display name
  const nameSim = jaroWinkler(seed.name, collectedData.display_name);
  if (nameSim > 0.95) {
    const nameFreq = getNameFrequency(collectedData.display_name);
    const baseWeight = 9.7;
    const freqAdjust = Math.log2(1 / Math.max(nameFreq, 0.0001));
    weights.push({ signal: 'name_exact', weight: Math.min(baseWeight, baseWeight + freqAdjust), value: nameSim });
  } else if (nameSim > 0.80) {
    weights.push({ signal: 'name_fuzzy', weight: 4.0, value: nameSim });
  } else {
    weights.push({ signal: 'name_nomatch', weight: -1.9, value: nameSim });
  }

  // Username pattern
  const usernameSim = usernamePatternScore(seed.known_usernames, collectedData.username);
  if (usernameSim > 0.8) {
    weights.push({ signal: 'username_match', weight: 5.9, value: usernameSim });
  } else if (usernameSim > 0.5) {
    weights.push({ signal: 'username_similar', weight: 2.0, value: usernameSim });
  }

  // Bio semantic
  if (collectedData.bio && seed.known_bios.length > 0) {
    // Use Claude Haiku for semantic comparison
    const bioScore = await compareBiosSemantic(seed.known_bios, collectedData.bio);
    if (bioScore > 0.7) {
      weights.push({ signal: 'bio_match', weight: 5.1, value: bioScore });
    }
  }

  // --- Tier 3: Moderate signals ---

  // Location
  if (collectedData.location && seed.known_locations.length > 0) {
    const locScore = locationMatch(seed.known_locations, collectedData.location);
    weights.push({ signal: 'location', weight: locScore.weight, value: locScore.similarity });
  }

  // Temporal pattern (only if we have posts from both)
  if (collectedData.recent_post_timestamps.length >= 10 && seed.known_temporal_pattern) {
    const tempSim = temporalSimilarity(seed.known_temporal_pattern, collectedData.recent_post_timestamps);
    if (tempSim > 0.7) {
      weights.push({ signal: 'temporal', weight: 2.0, value: tempSim });
    }
  }

  // Writing style (only if we have posts from both)
  if (collectedData.recent_post_texts.length >= 5 && seed.known_writing_samples.length >= 5) {
    const styleSim = stylometricSimilarity(seed.known_writing_samples, collectedData.recent_post_texts);
    if (styleSim > 0.6) {
      weights.push({ signal: 'writing_style', weight: 2.5, value: styleSim });
    }
  }

  // --- Compute final score ---
  const prior = Math.log2(0.24 / 0.76); // ~24% base rate from discovery
  const totalWeight = prior + weights.reduce((sum, w) => sum + w.weight, 0);
  const probability = Math.pow(2, totalWeight) / (1 + Math.pow(2, totalWeight));

  let classification;
  if (totalWeight >= 10) classification = 'CONFIRMED';
  else if (totalWeight >= 7) classification = 'PROBABLE';
  else if (totalWeight >= 4) classification = 'POSSIBLE';
  else if (totalWeight >= 0) classification = 'UNLIKELY';
  else classification = 'REJECTED';

  return { classification, confidence: probability, weight: totalWeight, signals: weights };
}
```

### Phase 4: Progressive Enrichment (Cost Optimization)

Not all signals are equally expensive to collect. Use a cascade:

```
Stage 1 (FREE - from maigret output):
  - Username pattern analysis
  - Platform detection
  -> REJECT obvious non-matches (username completely unrelated + different platform ecosystem)

Stage 2 (CHEAP - single profile scrape via ADB):
  - Display name
  - Bio text
  - Location
  - Profile photo -> face embedding
  - Join date
  -> Score. If CONFIRMED or REJECTED, stop. If POSSIBLE/PROBABLE, continue.

Stage 3 (MODERATE - scroll through posts):
  - Recent post timestamps (temporal fingerprint)
  - Recent post texts (writing style + NLP)
  -> Re-score. If CONFIRMED or REJECTED, stop.

Stage 4 (EXPENSIVE - crawl connections):
  - Follower/following overlap with confirmed accounts
  - Mutual connections analysis
  -> Final score.
```

**Cost per candidate**: Stage 1 = 0s, Stage 2 = ~30s ADB time, Stage 3 = ~2min,
Stage 4 = ~5-10min. For 100 candidates, full pipeline would take ~3hrs if all
reach Stage 4. With cascade, expect ~80% eliminated by Stage 2, so ~40min total.

---

## 4. Signal Implementation Details

### 4.1 Username Pattern Analysis

Usernames follow predictable patterns. Extract and compare:

```javascript
function extractUsernameFeatures(username) {
  return {
    raw: username.toLowerCase(),
    // Structural features
    hasNumbers: /\d/.test(username),
    hasUnderscore: /_/.test(username),
    hasDot: /\./.test(username),
    length: username.length,
    // Name-derived patterns
    containsFirstName: null, // check against seed
    containsLastName: null,
    containsInitials: null,
    // Common transforms
    leetspeak: deLeet(username), // k4zum4 -> kazuma
    stripped: username.replace(/[^a-z]/gi, ''),
    numberSuffix: (username.match(/\d+$/) || [null])[0],
  };
}

function usernamePatternScore(knownUsernames, candidate) {
  let maxScore = 0;
  for (const known of knownUsernames) {
    const kf = extractUsernameFeatures(known);
    const cf = extractUsernameFeatures(candidate);

    // Exact match
    if (kf.raw === cf.raw) return 1.0;

    // Same base, different suffix (john_smith vs john_smith_42)
    if (kf.stripped === cf.stripped) maxScore = Math.max(maxScore, 0.9);

    // Leetspeak variant
    if (kf.leetspeak === cf.leetspeak) maxScore = Math.max(maxScore, 0.85);

    // Same structural pattern + shared substring
    const lcs = longestCommonSubstring(kf.raw, cf.raw);
    if (lcs.length >= 5) {
      const ratio = lcs.length / Math.max(kf.raw.length, cf.raw.length);
      maxScore = Math.max(maxScore, ratio * 0.8);
    }

    // Edit distance
    const editDist = levenshtein(kf.raw, cf.raw);
    const editSim = 1 - editDist / Math.max(kf.raw.length, cf.raw.length);
    if (editSim > 0.7) maxScore = Math.max(maxScore, editSim * 0.7);
  }
  return maxScore;
}
```

### 4.2 Face Matching (via existing Qdrant infrastructure)

Your enricher.js already has the face matching pipeline. Key thresholds:

| Cosine Similarity | Interpretation | Match Weight |
|-------------------|----------------|--------------|
| >= 0.75 | Same person, high confidence | +13.2 |
| 0.60 - 0.74 | Same person, moderate confidence | +8.0 |
| 0.45 - 0.59 | Possible match, needs corroboration | +3.0 |
| 0.30 - 0.44 | Unlikely match | 0 (neutral) |
| < 0.30 | Different person | -3.5 |

**Critical**: Profile photos are often small, compressed, filtered. The face
service should use the highest-resolution version available. For ADB collection,
screenshot the avatar at max zoom before embedding.

### 4.3 Bio Semantic Comparison (via Claude Haiku)

```javascript
async function compareBiosSemantic(knownBios, candidateBio) {
  const prompt = `Compare these profile bios and determine if they likely belong to the same person.

KNOWN BIOS (confirmed accounts):
${knownBios.map((b, i) => `${i+1}. ${b}`).join('\n')}

CANDIDATE BIO:
${candidateBio}

Score 0.0 to 1.0 on these dimensions:
- shared_entities: Do they mention the same employer, school, city, or people?
- shared_interests: Do they mention the same hobbies, topics, or communities?
- shared_tone: Similar writing style, formality level, emoji usage?
- factual_consistency: No contradictions (different cities, different jobs)?

Return JSON: {"shared_entities": 0.X, "shared_interests": 0.X, "shared_tone": 0.X, "factual_consistency": 0.X, "overall": 0.X, "reasoning": "..."}`;

  // Call Claude Haiku (fast, cheap)
  const result = await callHaiku(prompt);
  return result.overall;
}
```

### 4.4 Temporal Fingerprint ("Timeprint")

Based on: "Timeprints for identifying social media users with multiple aliases"
(Clockwork Research, Security Informatics, 2015)

```javascript
function buildTimeprint(timestamps) {
  // Create 168-dimensional vector: 24 hours x 7 days
  const bins = new Float32Array(168);

  for (const ts of timestamps) {
    const d = new Date(ts);
    const hour = d.getUTCHours();
    const day = d.getUTCDay(); // 0=Sun
    bins[day * 24 + hour]++;
  }

  // Normalize to probability distribution
  const total = bins.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  for (let i = 0; i < 168; i++) bins[i] /= total;

  return bins;
}

function temporalSimilarity(timeprintA, timeprintB) {
  // Cosine similarity between timeprints
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < 168; i++) {
    dot += timeprintA[i] * timeprintB[i];
    normA += timeprintA[i] ** 2;
    normB += timeprintB[i] ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}
```

**Note**: Requires UTC-normalized timestamps. ADB screenshot timestamps are local
to Redroid (configurable timezone). Normalize to UTC before building timeprint.
Minimum 30 posts recommended for a reliable timeprint.

### 4.5 Writing Style (Stylometry)

Based on: character n-gram frequency analysis. Works even on short social media posts
when aggregated across 10+ posts.

```javascript
function buildStyleVector(texts) {
  // Character trigram frequency vector
  const trigrams = {};
  const combined = texts.join(' ').toLowerCase();

  for (let i = 0; i < combined.length - 2; i++) {
    const tri = combined.substring(i, i + 3);
    trigrams[tri] = (trigrams[tri] || 0) + 1;
  }

  // Also capture:
  // - Punctuation frequency (!!!, ..., emojis)
  // - Capitalization ratio
  // - Average word length
  // - Sentence length distribution
  const stats = {
    avgWordLen: averageWordLength(texts),
    capsRatio: capitalLetterRatio(combined),
    punctuationPattern: punctuationFrequency(combined),
    emojiFrequency: emojiCount(combined) / combined.length,
    exclamationRate: (combined.match(/!/g) || []).length / combined.length,
    questionRate: (combined.match(/\?/g) || []).length / combined.length,
  };

  return { trigrams, stats };
}

function stylometricSimilarity(samplesA, samplesB) {
  const vecA = buildStyleVector(samplesA);
  const vecB = buildStyleVector(samplesB);

  // Cosine similarity on trigram vectors
  const trigramSim = cosineSimilarityMaps(vecA.trigrams, vecB.trigrams);

  // Euclidean distance on stats (normalized)
  const statsSim = 1 - normalizedEuclidean(vecA.stats, vecB.stats);

  // Weighted combination
  return 0.7 * trigramSim + 0.3 * statsSim;
}
```

**Accuracy reference**: Stylometric methods achieve 85%+ attribution accuracy on
Twitter-length texts when aggregating 20+ posts per author (Layton et al., 2010).

### 4.6 Mutual Connections (Social Graph Overlap)

```javascript
function connectionOverlap(confirmedFollowers, candidateFollowers) {
  const setA = new Set(confirmedFollowers.map(f => f.toLowerCase()));
  const setB = new Set(candidateFollowers.map(f => f.toLowerCase()));

  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;

  const jaccard = intersection / (union || 1);

  // Weight by intersection count (more shared = stronger)
  // Even a Jaccard of 0.02 is meaningful if it means 50 shared followers
  return {
    jaccard,
    sharedCount: intersection,
    weight: jaccard > 0.1 ? 3.3 : jaccard > 0.02 ? 1.5 : 0,
  };
}
```

**Cost note**: Collecting followers lists is the most expensive operation (many scrolls
per profile). Only do this for candidates in POSSIBLE range (weight 4-7) that need
disambiguation. Sample first 200 followers max.

---

## 5. False Positive Mitigation

### 5.1 Contradictory Evidence (Negative Signals)

A signal that CONTRADICTS the match should carry heavy negative weight:

| Contradiction | Weight |
|--------------|--------|
| Face match confirms DIFFERENT person (cosine > 0.6 to someone else) | -15.0 |
| Bio states different city AND different employer | -5.0 |
| Account active simultaneously with confirmed account in incompatible timezone | -3.0 |
| Gender mismatch (clear indicators) | -4.0 |
| Account age impossible (created before person was born) | -Infinity |
| Different language (confirmed English speaker, candidate posts in Japanese) | -6.0 |

### 5.2 Prior Adjustment by Platform

Different platforms have different false positive rates for username matching:

| Platform | Base FP Rate | Prior Adjustment |
|----------|-------------|------------------|
| GitHub | Low (unique usernames) | prior * 1.5 |
| Reddit | High (generic names common) | prior * 0.5 |
| Twitter/X | Medium | prior * 1.0 |
| Instagram | Medium-High | prior * 0.8 |
| LinkedIn | Low (real names enforced) | prior * 2.0 |
| TikTok | High (random names common) | prior * 0.5 |
| Facebook | Low (real name policy) | prior * 2.0 |

### 5.3 Corroboration Requirement

Never classify as CONFIRMED on a single probabilistic signal alone, no matter how
strong. Require at least:

- **CONFIRMED**: 1 deterministic anchor OR 2+ strong signals (total weight >= 10)
- **PROBABLE**: 1 strong signal + 1 moderate signal (total weight >= 7)
- **POSSIBLE**: 1 strong signal OR 3+ moderate signals (total weight >= 4)

### 5.4 Cluster Consistency Check

After scoring all candidates, check for consistency within the cluster of accounts
attributed to the same person. Red flags:

- Two "CONFIRMED" accounts on the same platform with different usernames (legitimate
  for some platforms, suspicious for others)
- Location data that is geographically impossible (London and Tokyo simultaneously)
- Account creation dates spanning 20+ years
- Writing style variance within cluster is higher than expected

---

## 6. How Real Systems Do It

### Palantir Gotham/Foundry
- Ingests records from every available source (tax, social, financial, immigration)
- Entity resolution merges fragments into unified profiles using deterministic
  matching first (SSN, email, phone), then probabilistic on name + DOB + address
- Maintains a knowledge graph where resolved entities are nodes
- Confidence is tracked per link, not per entity
- Analysts can manually merge/split resolved entities
- Source: Palantir Gotham API docs, entity resolution module

### Maltego
- Graph-based approach: each piece of data is an "entity" (email, phone, username, person)
- "Transforms" discover new entities from existing ones (email -> social profiles)
- Disambiguation is **manual** — the analyst visually inspects the graph and merges/splits
- Integrates with Social Links, Pipl, and other data providers for enrichment
- Strength is visualization, not automated resolution
- Source: Maltego Person of Interest investigation guide

### Pipl
- Processes 28 billion unique identifiers
- "Multivariate linking technology" — not just matching on one field
- Creates "data clusters" by cross-referencing email, phone, username, and name
  across public records, social media, breached databases, and deep web
- Proprietary scoring — details not published, but described as connecting
  "online personas to real-world identities"
- Source: Pipl product documentation

### Recorded Future
- Intelligence Graph connects 13B+ entities from open web, dark web, technical sources
- Entity resolution uses ontology-driven analysis with relationship mapping
- Claims 95% false positive reduction vs. traditional keyword matching
- Identity Intelligence module focuses on credential exposure (leaked passwords)
- Source: Recorded Future Intelligence Graph documentation

### Academic State of the Art
- **Best performing approach**: Graph neural networks (GNNs) that jointly embed user
  profile features + network topology, achieving 90%+ accuracy on benchmark datasets
  (Twitter-Foursquare, Instagram-Twitter)
- **Display name alone**: F1 = 96.24% when both platforms show real names (supervised ML)
- **Multi-feature fusion**: F1 = 86.46% combining display name + location + org + URL
- **User-generated content**: F1 = 86-89% using text similarity on posts
- **Username alone**: 59% of users share exact username across platforms
- Source: arXiv:2409.08966 survey, KDD Explorations Vol 18 Issue 2

---

## 7. Implementation Plan for Our Pipeline

### What We Already Have

| Component | Status | Location |
|-----------|--------|----------|
| Username enumeration | sherlock + maigret installed | CLI tools |
| ADB profile scraping | Built | `collector.js` |
| Text normalization | Built | `normalizer.js` |
| Face embedding + Qdrant search | Built (51M vectors + kg_faces) | `enricher.js` |
| Claude Haiku NLP | Built | `enricher.js` |
| KG storage (subjects, facts, observations) | Built | Bridge API |

### What Needs to Be Built

| Component | Effort | Priority |
|-----------|--------|----------|
| **Identity resolver** — orchestrator that takes seed + maigret output and scores each candidate | 2-3 days | P0 |
| **Username pattern analyzer** — extract features, compare patterns, score similarity | 1 day | P0 |
| **Bio semantic comparator** — Claude Haiku prompt for bio comparison | 0.5 day | P0 |
| **Temporal fingerprint** — build timeprint from scraped post timestamps | 1 day | P1 |
| **Stylometric analyzer** — char n-gram + writing style features | 1 day | P1 |
| **Social graph sampler** — collect first N followers via ADB, compute Jaccard | 1-2 days | P2 |
| **Confidence dashboard** — show candidates with signal waterfall in Ozzu app | 2 days | P2 |
| **Feedback loop** — analyst confirms/rejects, model updates priors | 1 day | P3 |

### Pipeline Flow

```
1. SEED: { name: "Juan Garcia", email: "juangarcia@gmail.com", known_usernames: ["juangarcia"] }
     |
2. DISCOVER: maigret juangarcia --json -> 87 raw hits
     |
3. FILTER: Remove detection errors, 404s, captcha blocks -> 52 valid candidates
     |
4. STAGE 1 SCORE (free): Username pattern analysis
     -> 15 REJECTED (completely unrelated usernames like "butterfly_queen")
     -> 37 continue
     |
5. STAGE 2 COLLECT: ADB scrape each profile (name, bio, photo, location)
     -> Face match: 4 hits (weight +8 to +13 each)
     -> Name match: 8 more hits (weight +4 to +9)
     -> 12 REJECTED (wrong name, wrong face, contradictory location)
     -> 13 POSSIBLE (name similar but no face/weak signals)
     |
6. STAGE 3 COLLECT (for remaining 13): Scrape recent posts
     -> Temporal fingerprint: 3 more matches
     -> Writing style: 2 more matches
     -> 8 REJECTED or stay UNLIKELY
     |
7. RESULT:
     CONFIRMED: 3 accounts (deterministic anchor or weight >= 10)
     PROBABLE:  4 accounts (weight 7-10)
     POSSIBLE:  6 accounts (weight 4-7, flag for manual review)
     REJECTED:  74 accounts
```

### Database Schema Addition

```sql
-- Identity resolution candidates
CREATE TABLE IF NOT EXISTS kg_identity_candidates (
  id              SERIAL PRIMARY KEY,
  subject_id      INTEGER REFERENCES kg_subjects(id) ON DELETE CASCADE,
  platform        VARCHAR(50) NOT NULL,
  username        VARCHAR(200) NOT NULL,
  profile_url     TEXT,
  classification  VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, confirmed, probable, possible, unlikely, rejected
  match_weight    FLOAT,
  confidence      FLOAT,
  signals         JSONB,        -- array of {signal, weight, value, raw_data}
  collected_data  JSONB,        -- raw scraped profile data
  reviewed_by     VARCHAR(50),  -- null = auto, 'human' = manually reviewed
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(subject_id, platform, username)
);

CREATE INDEX idx_kg_identity_classification ON kg_identity_candidates(classification);
CREATE INDEX idx_kg_identity_subject ON kg_identity_candidates(subject_id);
CREATE INDEX idx_kg_identity_weight ON kg_identity_candidates(match_weight DESC);
```

---

## 8. Key Insights from Research

1. **Face matching is the single most powerful signal** for cross-platform identity
   resolution. A cosine similarity > 0.6 on face embeddings provides more evidence
   than any other single feature. You already have 51M vectors in Qdrant — this is
   your competitive advantage over every other OSINT tool.

2. **Username reuse is the cheapest signal** — 59% of users share the same username
   across platforms. Always check exact username match first, then pattern variants.

3. **Stylometry works even on short texts** when aggregated — 20+ tweets is enough
   for reliable authorship attribution. Character trigrams are the most robust feature.

4. **Temporal patterns are underrated** — posting time distribution is consistent per
   person and hard to fake. It's essentially a timezone + lifestyle fingerprint.

5. **The cascade architecture saves 80% of collection cost** — most candidates can be
   eliminated by Stage 2 (single profile scrape). Only ambiguous cases need expensive
   post collection or connection crawling.

6. **No system fully automates disambiguation** — even Palantir and Maltego include
   human-in-the-loop for edge cases. Plan for a review queue in the Ozzu app.

7. **Contradictory evidence is more valuable than confirming evidence** — a strong face
   match to a DIFFERENT known person eliminates a candidate instantly, saving all further
   collection cost. Always check negatives first.

8. **The Fellegi-Sunter framework is provably optimal** for this class of problem when
   signals are conditionally independent. The log-likelihood ratio approach is used by
   government agencies worldwide for record linkage. It generalizes naturally to any
   number of signals with any distribution.
