// Social Network Mapper — maps connections from social interactions across platforms
const db = require("../db");

module.exports = {
  name: "social-network-mapper",
  profileTypes: ["username", "email"],

  async scan(profile, rateLimiter) {
    const findings = [];

    // Collect all social intel findings for this profile
    const allFindings = await db.getOsintFindings({ profileId: profile.id, limit: 500 });

    const connections = new Map(); // username → { platforms[], interactions, firstSeen }
    const mentions = new Map();   // mentioned user → count
    const taggedUsers = new Set();

    for (const f of allFindings) {
      const rd = f.raw_data || {};

      // Instagram mentions/tags
      if (f.module === "instagram-intel") {
        for (const mention of (rd.mentions || [])) {
          const clean = mention.replace(/^@/, "").toLowerCase();
          mentions.set(clean, (mentions.get(clean) || 0) + 1);
        }
        if (rd.tagged_users) {
          for (const u of rd.tagged_users) taggedUsers.add(u.toLowerCase());
        }
      }

      // Twitter mentions
      if (f.module === "twitter-intel") {
        for (const mention of (rd.mentions || [])) {
          const clean = mention.replace(/^@/, "").toLowerCase();
          mentions.set(clean, (mentions.get(clean) || 0) + 1);
        }
        if (rd.replied_to) {
          const clean = rd.replied_to.replace(/^@/, "").toLowerCase();
          mentions.set(clean, (mentions.get(clean) || 0) + 3); // replies weighted higher
        }
      }

      // Reddit interactions
      if (f.module === "reddit-intel") {
        for (const sub of (rd.subreddits || [])) {
          connections.set(`reddit:r/${sub}`, {
            platforms: ["reddit"],
            type: "community",
            interactions: 1,
          });
        }
      }

      // Bluesky follows/interactions
      if (f.module === "bluesky-intel" && rd.follows) {
        for (const follow of rd.follows) {
          connections.set(`bluesky:${follow}`, {
            platforms: ["bluesky"],
            type: "follow",
            interactions: 1,
          });
        }
      }

      // Cross-platform username overlap (from correlation)
      if (rd.type === "discovered_profile") {
        const key = `${rd.platform}:${rd.username}`;
        connections.set(key, {
          platforms: [rd.platform],
          type: "same_person",
          interactions: 1,
          similarity: rd.similarity,
        });
      }
    }

    // Rank mentions by frequency
    const rankedMentions = [...mentions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    if (rankedMentions.length > 0) {
      findings.push({
        category: "social",
        severity: "medium",
        title: `Social network: ${rankedMentions.length} frequently mentioned users`,
        description: rankedMentions.slice(0, 10)
          .map(([user, count]) => `@${user} — ${count} mentions`)
          .join("\n"),
        rawData: {
          type: "social_network_mentions",
          mentions: Object.fromEntries(rankedMentions),
          totalUnique: mentions.size,
        },
      });
    }

    if (taggedUsers.size > 0) {
      findings.push({
        category: "social",
        severity: "medium",
        title: `Social network: ${taggedUsers.size} tagged users found`,
        description: `Users tagged in photos/posts: ${[...taggedUsers].slice(0, 15).join(", ")}`,
        rawData: {
          type: "social_network_tags",
          taggedUsers: [...taggedUsers],
        },
      });
    }

    if (connections.size > 0) {
      findings.push({
        category: "social",
        severity: "info",
        title: `Social network: ${connections.size} connections mapped`,
        description: `Cross-platform connections and community memberships identified.`,
        rawData: {
          type: "social_network_map",
          connections: Object.fromEntries(connections),
          totalConnections: connections.size,
        },
      });
    }

    if (rankedMentions.length === 0 && connections.size === 0) {
      findings.push({
        category: "social",
        severity: "info",
        title: "Social network mapper: insufficient data",
        rawData: { type: "no_network_data" },
      });
    }

    return findings;
  },
};
