// Identity Clustering Engine — groups entities into "same person" clusters
// Uses face match similarity, username overlap, email patterns, shared breaches, and platform overlap
const db = require("./db");

const WEIGHTS = {
  faceMatch: 0.4,
  usernameOverlap: 0.2,
  emailDomainMatch: 0.2,
  sharedBreaches: 0.1,
  platformOverlap: 0.1,
};

// Levenshtein distance for username comparison
function levenshtein(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

function usernameSimilarity(a, b) {
  if (!a || !b) return 0;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1;
  const maxLen = Math.max(la.length, lb.length);
  if (maxLen === 0) return 0;
  return 1 - levenshtein(la, lb) / maxLen;
}

function emailDomainSimilarity(a, b) {
  if (!a || !b) return 0;
  const [userA, domA] = a.toLowerCase().split("@");
  const [userB, domB] = b.toLowerCase().split("@");
  if (!domA || !domB) return 0;
  if (userA === userB && domA === domB) return 1;
  if (userA === userB) return 0.8;
  if (domA === domB) return 0.3;
  return 0;
}

// BFS to find connected components
function findComponents(nodes, edges) {
  const adj = new Map();
  for (const n of nodes) adj.set(n, []);
  for (const [a, b] of edges) {
    if (adj.has(a) && adj.has(b)) {
      adj.get(a).push(b);
      adj.get(b).push(a);
    }
  }

  const visited = new Set();
  const components = [];

  for (const node of nodes) {
    if (visited.has(node)) continue;
    const component = [];
    const queue = [node];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adj.get(current) || []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    if (component.length > 1) components.push(component);
  }

  return components;
}

async function runIdentityClustering(profileId) {
  // Get all entities and relationships
  const entities = await db.getOsintEntities({ limit: 2000 });
  const relationships = await db.getOsintRelationships({ limit: 5000 });
  if (!entities || entities.length === 0) return { clusters: [] };

  // Build entity map
  const entityMap = new Map();
  for (const e of entities) entityMap.set(e.id, e);

  // Build profile-to-entities map
  const profileEntities = new Map(); // profileId -> entities[]
  for (const e of entities) {
    if (!e.profile_id) continue;
    if (!profileEntities.has(e.profile_id)) profileEntities.set(e.profile_id, []);
    profileEntities.get(e.profile_id).push(e);
  }

  // Build edges from relationships
  const edges = [];
  for (const r of relationships) {
    edges.push([r.source_entity_id, r.target_entity_id]);
  }

  // Find connected components
  const allNodes = entities.map(e => e.id);
  const components = findComponents(allNodes, edges);

  // For each component, calculate identity confidence
  const clusters = [];

  for (const component of components) {
    const compEntities = component.map(id => entityMap.get(id)).filter(Boolean);
    const profileIds = [...new Set(compEntities.map(e => e.profile_id).filter(Boolean))];

    // Only interesting if spans multiple profiles
    if (profileIds.length < 2) continue;

    // Calculate composite confidence
    let faceScore = 0;
    let usernameScore = 0;
    let emailScore = 0;
    let breachScore = 0;
    let platformScore = 0;

    // Face matches
    const faceRels = relationships.filter(r =>
      r.relationship === "face_match" &&
      component.includes(r.source_entity_id) &&
      component.includes(r.target_entity_id)
    );
    if (faceRels.length > 0) {
      faceScore = Math.max(...faceRels.map(r => r.confidence)) / 100;
    }

    // Username overlap
    const usernames = compEntities
      .filter(e => e.entity_type === "username" || e.entity_type === "social_account")
      .map(e => e.value.includes(":") ? e.value.split(":")[1] : e.value);
    if (usernames.length >= 2) {
      let maxSim = 0;
      for (let i = 0; i < usernames.length; i++) {
        for (let j = i + 1; j < usernames.length; j++) {
          maxSim = Math.max(maxSim, usernameSimilarity(usernames[i], usernames[j]));
        }
      }
      usernameScore = maxSim;
    }

    // Email domain matching
    const emails = compEntities.filter(e => e.entity_type === "email").map(e => e.value);
    if (emails.length >= 2) {
      let maxSim = 0;
      for (let i = 0; i < emails.length; i++) {
        for (let j = i + 1; j < emails.length; j++) {
          maxSim = Math.max(maxSim, emailDomainSimilarity(emails[i], emails[j]));
        }
      }
      emailScore = maxSim;
    }

    // Shared breaches
    const breaches = compEntities.filter(e => e.entity_type === "organization" && e.metadata?.type === "breach");
    const breachNames = new Set(breaches.map(e => e.value));
    breachScore = Math.min(breachNames.size / 3, 1); // 3+ shared breaches = 100%

    // Platform overlap
    const platforms = compEntities
      .filter(e => e.entity_type === "social_account")
      .map(e => e.value.split(":")[0]);
    const platformSet = new Set(platforms);
    platformScore = Math.min(platformSet.size / 5, 1); // 5+ platforms = 100%

    // Composite confidence
    const confidence = Math.round(
      (faceScore * WEIGHTS.faceMatch +
       usernameScore * WEIGHTS.usernameOverlap +
       emailScore * WEIGHTS.emailDomainMatch +
       breachScore * WEIGHTS.sharedBreaches +
       platformScore * WEIGHTS.platformOverlap) * 100
    );

    if (confidence < 20) continue; // Skip low-confidence clusters

    // Build evidence summary
    const evidence = [];
    if (faceScore > 0) evidence.push(`Face: ${Math.round(faceScore * 100)}%`);
    if (usernameScore > 0) evidence.push(`Username: ${Math.round(usernameScore * 100)}%`);
    if (emailScore > 0) evidence.push(`Email: ${Math.round(emailScore * 100)}%`);
    if (breachScore > 0) evidence.push(`Breaches: ${breachNames.size}`);
    if (platformScore > 0) evidence.push(`Platforms: ${platformSet.size}`);

    // Generate label from person entities or highest-confidence relationship
    const persons = compEntities.filter(e => e.entity_type === "person");
    const label = persons.length > 0
      ? persons[0].label || persons[0].value
      : compEntities[0].label || compEntities[0].value;

    clusters.push({
      label,
      confidence,
      entity_ids: component,
      profile_ids: profileIds,
      evidence: evidence.join(" | "),
      entity_count: component.length,
      profile_count: profileIds.length,
      breakdown: { faceScore, usernameScore, emailScore, breachScore, platformScore },
    });
  }

  // Sort by confidence descending
  clusters.sort((a, b) => b.confidence - a.confidence);

  // Store clusters in DB
  for (const cluster of clusters) {
    await db.upsertIdentityCluster(cluster);
  }

  console.log(`[identity-cluster] Found ${clusters.length} identity cluster(s)`);
  return { clusters };
}

module.exports = { runIdentityClustering };
