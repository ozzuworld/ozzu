// Extended Kalman Filter Fusion Engine for OSINT Intelligence
// Fuses observations from multiple scanner modules into unified confidence estimates
const db = require("./db");

// State vector indices
const STATE = {
  NAME_CONFIDENCE: 0,
  LOCATION_LAT: 1,
  LOCATION_LNG: 2,
  LOCATION_CONFIDENCE: 3,
  AGE_ESTIMATE: 4,
  AGE_CONFIDENCE: 5,
  EMPLOYER_CONFIDENCE: 6,
  ONLINE_PRESENCE: 7,
  THREAT_LEVEL: 8,
  IDENTITY_CERTAINTY: 9,
};
const STATE_DIM = 10;

// Sensor noise models per module (R matrix diagonal — lower = more trustworthy)
const SENSOR_MODELS = {
  "face-search":      { name: 0.3, location: 0.9, age: 0.8, employer: 0.8, identity: 0.2 },
  "scene-analysis":   { name: 0.7, location: 0.4, age: 0.3, employer: 0.5, identity: 0.6 },
  "identity-resolver":{ name: 0.2, location: 0.8, age: 0.7, employer: 0.7, identity: 0.15 },
  "instagram-intel":  { name: 0.4, location: 0.5, age: 0.6, employer: 0.7, identity: 0.4 },
  "tiktok-intel":     { name: 0.5, location: 0.6, age: 0.5, employer: 0.8, identity: 0.5 },
  "facebook-intel":   { name: 0.3, location: 0.4, age: 0.4, employer: 0.5, identity: 0.3 },
  "linkedin-intel":   { name: 0.1, location: 0.3, age: 0.3, employer: 0.1, identity: 0.2 },
  "twitter-intel":    { name: 0.3, location: 0.6, age: 0.7, employer: 0.6, identity: 0.4 },
  "bluesky-intel":    { name: 0.4, location: 0.7, age: 0.8, employer: 0.8, identity: 0.5 },
  "reddit-intel":     { name: 0.6, location: 0.7, age: 0.7, employer: 0.7, identity: 0.6 },
  "youtube-intel":    { name: 0.4, location: 0.7, age: 0.6, employer: 0.7, identity: 0.5 },
  "mastodon-intel":   { name: 0.5, location: 0.7, age: 0.8, employer: 0.8, identity: 0.6 },
  "telegram-intel":   { name: 0.5, location: 0.8, age: 0.8, employer: 0.8, identity: 0.6 },
  "hibp-email":       { name: 0.8, location: 0.9, age: 0.9, employer: 0.9, identity: 0.7 },
  "data-broker":      { name: 0.2, location: 0.3, age: 0.4, employer: 0.6, identity: 0.3 },
  "domain-recon":     { name: 0.5, location: 0.4, age: 0.9, employer: 0.3, identity: 0.5 },
  "shodan-lookup":    { name: 0.9, location: 0.5, age: 0.9, employer: 0.7, identity: 0.8 },
  "phone-lookup":     { name: 0.3, location: 0.4, age: 0.9, employer: 0.8, identity: 0.4 },
  "username-enum":    { name: 0.7, location: 0.9, age: 0.9, employer: 0.9, identity: 0.6 },
  "gravatar-lookup":  { name: 0.4, location: 0.7, age: 0.8, employer: 0.7, identity: 0.4 },
};

// Default high-noise model for unknown modules
const DEFAULT_SENSOR = { name: 0.8, location: 0.8, age: 0.8, employer: 0.8, identity: 0.8 };

// ── Matrix helpers (small fixed-size, no library needed) ──

function zeros(n) { return new Array(n).fill(0); }
function eye(n) { return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 1 : 0)); }

function matMul(A, B) {
  const rows = A.length, cols = B[0].length, inner = B.length;
  const C = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++)
      for (let k = 0; k < inner; k++)
        C[i][j] += A[i][k] * B[k][j];
  return C;
}

function matTranspose(A) {
  return A[0].map((_, j) => A.map(row => row[j]));
}

function matAdd(A, B) {
  return A.map((row, i) => row.map((v, j) => v + B[i][j]));
}

function matSub(A, B) {
  return A.map((row, i) => row.map((v, j) => v - B[i][j]));
}

function matInv2x2(M) {
  // For small matrices we use the 1x1 case (scalar observation)
  if (M.length === 1) return [[1 / M[0][0]]];
  if (M.length === 2) {
    const det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
    if (Math.abs(det) < 1e-10) return eye(2);
    return [[M[1][1] / det, -M[0][1] / det], [-M[1][0] / det, M[0][0] / det]];
  }
  // For larger matrices, use simplified diagonal inverse (observations are independent)
  return M.map((row, i) => row.map((v, j) => i === j ? (Math.abs(v) > 1e-10 ? 1 / v : 0) : 0));
}

// ── EKF Core ──

function initState() {
  const x = zeros(STATE_DIM);
  x[STATE.ONLINE_PRESENCE] = 0;
  x[STATE.THREAT_LEVEL] = 0;
  x[STATE.IDENTITY_CERTAINTY] = 0;
  const P = eye(STATE_DIM).map(row => row.map(v => v * 10)); // High initial uncertainty
  return { x, P, observationCount: 0, observations: [] };
}

function predict(state) {
  // Static model: F = identity (person attributes don't change between scans)
  // Process noise Q adds small uncertainty over time
  const Q = eye(STATE_DIM).map(row => row.map(v => v * 0.01));
  state.P = matAdd(state.P, Q);
  return state;
}

function update(state, observation) {
  // observation: { indices: [stateIdx], values: [float], module: string }
  const { indices, values, module } = observation;
  const sensor = SENSOR_MODELS[module] || DEFAULT_SENSOR;

  for (let obs = 0; obs < indices.length; obs++) {
    const idx = indices[obs];
    const z = values[obs]; // observed value
    const h = state.x[idx]; // predicted value

    // Innovation (measurement residual)
    const y = z - h;

    // Measurement noise R (scalar per observation)
    let R;
    if (idx === STATE.NAME_CONFIDENCE || idx === STATE.IDENTITY_CERTAINTY) R = sensor.name;
    else if (idx === STATE.LOCATION_LAT || idx === STATE.LOCATION_LNG || idx === STATE.LOCATION_CONFIDENCE) R = sensor.location;
    else if (idx === STATE.AGE_ESTIMATE || idx === STATE.AGE_CONFIDENCE) R = sensor.age;
    else if (idx === STATE.EMPLOYER_CONFIDENCE) R = sensor.employer;
    else R = sensor.identity;

    // S = H*P*H' + R  (for scalar observation, H is a row vector with 1 at idx)
    const S = state.P[idx][idx] + R;
    if (Math.abs(S) < 1e-10) continue;

    // Kalman gain K = P*H'/S
    const K = state.P.map(row => [row[idx] / S]);

    // State update x = x + K*y
    for (let i = 0; i < STATE_DIM; i++) {
      state.x[i] += K[i][0] * y;
    }

    // Covariance update P = (I - K*H)*P
    const KH = K.map(row => state.P[idx].map(v => row[0] * v / state.P[idx][idx]));
    const IKH = eye(STATE_DIM).map((row, i) => row.map((v, j) => v - (K[i][0] * (j === idx ? 1 : 0))));
    state.P = matMul(IKH, state.P);
  }

  state.observationCount++;
  state.observations.push({ module, indices, values, timestamp: Date.now() });
  return state;
}

// ── Observation Extraction from Findings ──

function extractObservations(findings, module) {
  const observations = [];

  for (const f of findings) {
    const rd = f.raw_data || {};

    // Identity certainty from various signals
    if (rd.type === "identity_candidates" && rd.candidates?.length > 0) {
      observations.push({
        indices: [STATE.IDENTITY_CERTAINTY, STATE.NAME_CONFIDENCE],
        values: [rd.candidates[0].confidence, rd.candidates[0].confidence],
        module,
      });
    }

    if (rd.type === "verified_face_matches" && rd.verifiedMatches?.length > 0) {
      const topSim = rd.verifiedMatches[0].similarity;
      observations.push({
        indices: [STATE.IDENTITY_CERTAINTY],
        values: [topSim],
        module,
      });
    }

    if (rd.type === "discovered_profile") {
      observations.push({
        indices: [STATE.ONLINE_PRESENCE, STATE.IDENTITY_CERTAINTY],
        values: [Math.min(100, 20), (rd.similarity || 0.7)],
        module,
      });
    }

    // Scene analysis location
    if (rd.type === "scene_analysis" && rd.analysis?.location) {
      const loc = rd.analysis.location;
      const confMap = { high: 0.9, medium: 0.6, low: 0.3 };
      observations.push({
        indices: [STATE.LOCATION_CONFIDENCE],
        values: [confMap[loc.confidence] || 0.3],
        module,
      });
    }

    // Age from scene analysis
    if (rd.type === "scene_analysis" && rd.analysis?.people?.details?.length > 0) {
      const ageStr = rd.analysis.people.details[0].estimated_age_range;
      if (ageStr) {
        const match = ageStr.match(/(\d+)-(\d+)/);
        if (match) {
          const avgAge = (parseInt(match[1]) + parseInt(match[2])) / 2;
          observations.push({
            indices: [STATE.AGE_ESTIMATE, STATE.AGE_CONFIDENCE],
            values: [avgAge, 0.5],
            module,
          });
        }
      }
    }

    // Social intel modules — presence + identity signals
    if (f.category === "social" || f.category === "identity") {
      if (rd.followers !== undefined || rd.following !== undefined) {
        const presence = Math.min(100, Math.log10((rd.followers || 0) + 1) * 20);
        observations.push({
          indices: [STATE.ONLINE_PRESENCE],
          values: [presence],
          module,
        });
      }
      if (rd.full_name || rd.display_name || rd.name) {
        observations.push({
          indices: [STATE.NAME_CONFIDENCE],
          values: [0.7],
          module,
        });
      }
    }

    // Employer signals from LinkedIn
    if (module === "linkedin-intel" && (rd.company || rd.employer)) {
      observations.push({
        indices: [STATE.EMPLOYER_CONFIDENCE],
        values: [0.85],
        module,
      });
    }

    // Threat from breaches/leaks
    if (f.severity === "critical") {
      observations.push({
        indices: [STATE.THREAT_LEVEL],
        values: [Math.min(100, 30)],
        module,
      });
    } else if (f.severity === "high") {
      observations.push({
        indices: [STATE.THREAT_LEVEL],
        values: [Math.min(100, 15)],
        module,
      });
    }
  }

  return observations;
}

// ── Main Integration ──

async function fuseScanResults(profileId, scanId) {
  // Load or initialize EKF state
  let ekfState = await db.getOsintEkfState(profileId);
  let state;
  if (ekfState?.state_vector) {
    state = {
      x: ekfState.state_vector,
      P: ekfState.covariance_matrix,
      observationCount: ekfState.observation_count || 0,
      observations: [],
    };
  } else {
    state = initState();
  }

  // Predict step (adds process noise)
  predict(state);

  // Get findings from this scan
  const findings = await db.getOsintFindings({ profileId, scanId, limit: 500 });
  if (!findings || findings.length === 0) return state;

  // Group findings by module
  const byModule = {};
  for (const f of findings) {
    if (!byModule[f.module]) byModule[f.module] = [];
    byModule[f.module].push(f);
  }

  // Extract and apply observations
  for (const [module, moduleFindings] of Object.entries(byModule)) {
    const observations = extractObservations(moduleFindings, module);
    for (const obs of observations) {
      update(state, obs);
    }
  }

  // Clamp values to valid ranges
  state.x[STATE.NAME_CONFIDENCE] = Math.max(0, Math.min(1, state.x[STATE.NAME_CONFIDENCE]));
  state.x[STATE.LOCATION_CONFIDENCE] = Math.max(0, Math.min(1, state.x[STATE.LOCATION_CONFIDENCE]));
  state.x[STATE.AGE_CONFIDENCE] = Math.max(0, Math.min(1, state.x[STATE.AGE_CONFIDENCE]));
  state.x[STATE.EMPLOYER_CONFIDENCE] = Math.max(0, Math.min(1, state.x[STATE.EMPLOYER_CONFIDENCE]));
  state.x[STATE.ONLINE_PRESENCE] = Math.max(0, Math.min(100, state.x[STATE.ONLINE_PRESENCE]));
  state.x[STATE.THREAT_LEVEL] = Math.max(0, Math.min(100, state.x[STATE.THREAT_LEVEL]));
  state.x[STATE.IDENTITY_CERTAINTY] = Math.max(0, Math.min(1, state.x[STATE.IDENTITY_CERTAINTY]));

  // Save state
  await db.upsertOsintEkfState(profileId, {
    state_vector: state.x,
    covariance_matrix: state.P,
    observation_count: state.observationCount,
  });

  return state;
}

function getConfidenceIntervals(state) {
  const ci = {};
  const labels = [
    "name_confidence", "location_lat", "location_lng", "location_confidence",
    "age_estimate", "age_confidence", "employer_confidence",
    "online_presence", "threat_level", "identity_certainty",
  ];
  for (let i = 0; i < STATE_DIM; i++) {
    const variance = state.P[i][i];
    const stddev = Math.sqrt(Math.max(0, variance));
    ci[labels[i]] = {
      value: state.x[i],
      stddev,
      ci95_low: state.x[i] - 1.96 * stddev,
      ci95_high: state.x[i] + 1.96 * stddev,
    };
  }
  return ci;
}

function getStateSummary(state) {
  const ci = getConfidenceIntervals(state);
  return {
    identity_certainty: `${(state.x[STATE.IDENTITY_CERTAINTY] * 100).toFixed(1)}% (+/- ${(Math.sqrt(state.P[STATE.IDENTITY_CERTAINTY][STATE.IDENTITY_CERTAINTY]) * 100).toFixed(1)}%)`,
    name_confidence: `${(state.x[STATE.NAME_CONFIDENCE] * 100).toFixed(1)}%`,
    location_confidence: `${(state.x[STATE.LOCATION_CONFIDENCE] * 100).toFixed(1)}%`,
    age_estimate: state.x[STATE.AGE_ESTIMATE] > 0 ? `${state.x[STATE.AGE_ESTIMATE].toFixed(0)} years (+/- ${Math.sqrt(state.P[STATE.AGE_ESTIMATE][STATE.AGE_ESTIMATE]).toFixed(1)})` : "unknown",
    employer_confidence: `${(state.x[STATE.EMPLOYER_CONFIDENCE] * 100).toFixed(1)}%`,
    online_presence: `${state.x[STATE.ONLINE_PRESENCE].toFixed(0)}/100`,
    threat_level: `${state.x[STATE.THREAT_LEVEL].toFixed(0)}/100`,
    observations: state.observationCount,
    confidence_intervals: ci,
  };
}

module.exports = {
  initState,
  predict,
  update,
  fuseScanResults,
  extractObservations,
  getConfidenceIntervals,
  getStateSummary,
  STATE,
  STATE_DIM,
  SENSOR_MODELS,
};
