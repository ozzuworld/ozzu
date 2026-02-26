// OSINT Report Generator — structured JSON + Markdown output
// Executive summary, findings by category, entity graph summary, remediation checklist
const db = require("./db");

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEVERITY_EMOJI = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "⚪" };
const CATEGORY_EMOJI = { breach: "💀", account_found: "👤", exposure: "🌐" };

async function generateReport(profileId) {
  const profile = await db.getOsintProfile(profileId);
  if (!profile) throw new Error(`Profile ${profileId} not found`);

  const findings = await db.getOsintFindings({ profileId, limit: 500 });
  const graph = await db.getOsintEntityGraph(profileId);
  const entities = graph.entities || [];
  const relationships = graph.relationships || [];

  return buildReport(profile, findings, entities, relationships);
}

async function generateCombinedReport() {
  const profiles = await db.getOsintProfiles();
  const allFindings = await db.getOsintFindings({ limit: 1000 });
  const graph = await db.getOsintEntityGraph();
  const entities = graph.entities || [];
  const relationships = graph.relationships || [];

  return buildReport(null, allFindings, entities, relationships, profiles);
}

function buildReport(profile, findings, entities, relationships, allProfiles) {
  // Count severities
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    if (f.status !== "false_positive") counts[f.severity] = (counts[f.severity] || 0) + 1;
  }

  // Group findings by category
  const byCategory = {};
  for (const f of findings) {
    if (f.status === "false_positive") continue;
    if (!byCategory[f.category]) byCategory[f.category] = [];
    byCategory[f.category].push(f);
  }

  // Collect unique remediation items
  const remediationSet = new Set();
  const sortedFindings = [...findings]
    .filter((f) => f.status !== "false_positive" && f.remediation)
    .sort((a, b) => (SEVERITY_ORDER[a.severity] || 4) - (SEVERITY_ORDER[b.severity] || 4));

  for (const f of sortedFindings) {
    if (f.remediation) remediationSet.add(f.remediation);
  }
  const remediation = [...remediationSet];

  // Entity type counts
  const entityTypeCounts = {};
  for (const e of entities) {
    entityTypeCounts[e.entity_type] = (entityTypeCounts[e.entity_type] || 0) + 1;
  }

  // Build markdown
  const lines = [];
  const label = profile ? profile.label : "All Profiles";
  const value = profile ? ` (${profile.profile_type}: ${profile.value})` : "";

  lines.push(`# OSINT Report: ${label}${value}`);
  lines.push("");
  lines.push(`*Generated: ${new Date().toISOString()}*`);
  lines.push("");

  // Executive Summary
  lines.push("## Executive Summary");
  lines.push("");
  const totalActive = counts.critical + counts.high + counts.medium + counts.low + counts.info;
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| ${SEVERITY_EMOJI.critical} Critical | ${counts.critical} |`);
  lines.push(`| ${SEVERITY_EMOJI.high} High | ${counts.high} |`);
  lines.push(`| ${SEVERITY_EMOJI.medium} Medium | ${counts.medium} |`);
  lines.push(`| ${SEVERITY_EMOJI.low} Low | ${counts.low} |`);
  lines.push(`| ${SEVERITY_EMOJI.info} Info | ${counts.info} |`);
  lines.push(`| **Total Findings** | **${totalActive}** |`);
  lines.push(`| Entities Discovered | ${entities.length} |`);
  lines.push(`| Relationships Mapped | ${relationships.length} |`);
  if (allProfiles) {
    lines.push(`| Profiles Scanned | ${allProfiles.length} |`);
  }
  lines.push("");

  // Risk assessment
  if (counts.critical > 0) {
    lines.push("> **CRITICAL RISK**: Immediate action required. Critical exposures found.");
  } else if (counts.high > 0) {
    lines.push("> **HIGH RISK**: Significant exposures found that should be addressed promptly.");
  } else if (counts.medium > 0) {
    lines.push("> **MODERATE RISK**: Some exposures found. Review and remediate when possible.");
  } else {
    lines.push("> **LOW RISK**: Minimal exposure detected. Continue monitoring.");
  }
  lines.push("");

  // Findings by Category
  lines.push("## Findings by Category");
  lines.push("");

  for (const [category, categoryFindings] of Object.entries(byCategory)) {
    const emoji = CATEGORY_EMOJI[category] || "📋";
    const label = category.replace(/_/g, " ").toUpperCase();
    lines.push(`### ${emoji} ${label} (${categoryFindings.length})`);
    lines.push("");

    // Sort by severity within category
    categoryFindings.sort((a, b) => (SEVERITY_ORDER[a.severity] || 4) - (SEVERITY_ORDER[b.severity] || 4));

    for (const f of categoryFindings.slice(0, 20)) {
      lines.push(`- ${SEVERITY_EMOJI[f.severity]} **${f.title}**`);
      if (f.description) {
        // Truncate long descriptions
        const desc = f.description.length > 200 ? f.description.substring(0, 200) + "..." : f.description;
        lines.push(`  ${desc.split("\n")[0]}`);
      }
    }
    if (categoryFindings.length > 20) {
      lines.push(`  *... and ${categoryFindings.length - 20} more*`);
    }
    lines.push("");
  }

  // Entity Graph Summary
  if (entities.length > 0) {
    lines.push("## Entity Graph");
    lines.push("");
    lines.push(`Discovered **${entities.length}** identity fragments connected by **${relationships.length}** relationships.`);
    lines.push("");

    const typeEmoji = {
      person: "👤", email: "📧", username: "🏷", phone: "📱", domain: "🌐",
      ip: "🖥", social_account: "🔗", organization: "🏢", location: "📍", image: "🖼",
    };

    for (const [type, count] of Object.entries(entityTypeCounts).sort((a, b) => b[1] - a[1])) {
      const emoji = typeEmoji[type] || "📋";
      const typeEntities = entities.filter((e) => e.entity_type === type);
      lines.push(`- ${emoji} **${type.replace(/_/g, " ").toUpperCase()}** (${count}): ${typeEntities.slice(0, 5).map((e) => e.label || e.value).join(", ")}${count > 5 ? "..." : ""}`);
    }
    lines.push("");

    // Key relationships
    if (relationships.length > 0) {
      lines.push("### Key Relationships");
      lines.push("");
      const highConf = relationships.filter((r) => r.confidence >= 80).slice(0, 15);
      for (const r of highConf) {
        lines.push(`- ${r.source_label || r.source_value} **${r.relationship.replace(/_/g, " ")}** ${r.target_label || r.target_value} (${r.confidence}%)`);
      }
      lines.push("");
    }
  }

  // Remediation Checklist
  if (remediation.length > 0) {
    lines.push("## Remediation Checklist");
    lines.push("");
    for (let i = 0; i < remediation.length; i++) {
      lines.push(`- [ ] ${remediation[i]}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("*Report generated by Ozzu OSINT Scanner*");

  const markdown = lines.join("\n");

  return {
    markdown,
    json: {
      profile: profile || null,
      summary: {
        ...counts,
        totalEntities: entities.length,
        totalRelationships: relationships.length,
      },
      findings: findings.filter((f) => f.status !== "false_positive"),
      entities,
      relationships,
      remediation,
    },
  };
}

module.exports = { generateReport, generateCombinedReport };
