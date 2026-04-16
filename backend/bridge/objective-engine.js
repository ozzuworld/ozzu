// objective-engine.js — Autonomous objective achievement engine
// Coordinates Cipher (decision) + Joko (execution) in closed loop

"use strict";

/**
 * ObjectiveEngine — Manages autonomous task iteration until objective achieved
 *
 * Flow:
 * 1. Human sets objective (e.g., "gain root on 192.168.1.15")
 * 2. Cipher breaks down into attack plan
 * 3. Loop: Cipher decides → Joko executes → Cipher analyzes → repeat
 * 4. Exit: Objective met OR all paths exhausted OR max iterations
 * 5. Report to human with evidence + narrative
 */
class ObjectiveEngine {
  constructor(db, log) {
    this.db = db;
    this.log = log || console.log;
    this.activeObjectives = new Map(); // objectiveId → state
  }

  /**
   * Create new objective and start autonomous execution
   */
  async createObjective({ goal, target, engagement_id, directive_id, scope, max_iterations = 20, success_criteria }) {
    const objectiveId = `obj_${Date.now()}`;

    const objective = {
      id: objectiveId,
      goal,
      target,
      engagement_id,
      directive_id,
      scope: scope || {},
      max_iterations,
      success_criteria: success_criteria || this._defaultSuccessCriteria(goal),

      // Runtime state
      state: {
        status: "planning", // planning|executing|completed|failed|escalated
        iterations: 0,
        attempts: [],
        findings: [],
        current_access_level: "none",
        blocked_paths: [],
        evidence: [],
        start_time: new Date().toISOString(),
        last_update: new Date().toISOString(),
      },

      // Attack plan (populated by Cipher)
      attack_plan: null,
      current_step: null,
    };

    // Save to DB
    await this.db.query(`
      INSERT INTO agent_audit_log (agent_name, engagement_id, directive_id, task, status, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      "cipher",
      engagement_id,
      directive_id,
      `Objective: ${goal} on ${target}`,
      "planning",
      JSON.stringify({ objective_id: objectiveId, objective })
    ]);

    this.activeObjectives.set(objectiveId, objective);
    this.log(`[ObjectiveEngine] Created objective ${objectiveId}: ${goal} on ${target}`);

    return objective;
  }

  /**
   * Record attempt result from Joko
   */
  async recordAttempt(objectiveId, attempt) {
    const obj = this.activeObjectives.get(objectiveId);
    if (!obj) throw new Error(`Objective ${objectiveId} not found`);

    obj.state.attempts.push({
      ...attempt,
      timestamp: new Date().toISOString(),
    });
    obj.state.iterations++;
    obj.state.last_update = new Date().toISOString();

    // Extract findings
    if (attempt.findings && attempt.findings.length > 0) {
      obj.state.findings.push(...attempt.findings);
    }

    // Extract evidence
    if (attempt.evidence && attempt.evidence.length > 0) {
      obj.state.evidence.push(...attempt.evidence);
    }

    // Update access level if elevated
    if (attempt.access_level) {
      obj.state.current_access_level = attempt.access_level;
    }

    this.log(`[ObjectiveEngine] Recorded attempt ${obj.state.iterations}/${obj.max_iterations} for ${objectiveId}`);
  }

  /**
   * Check if objective is achieved
   */
  isObjectiveAchieved(objectiveId) {
    const obj = this.activeObjectives.get(objectiveId);
    if (!obj) return false;

    const criteria = obj.success_criteria;
    const state = obj.state;

    // Check success criteria
    if (criteria.access_level && state.current_access_level !== criteria.access_level) {
      return false;
    }

    if (criteria.required_findings) {
      const foundTypes = new Set(state.findings.map(f => f.type));
      const allFound = criteria.required_findings.every(type => foundTypes.has(type));
      if (!allFound) return false;
    }

    if (criteria.evidence_count && state.evidence.length < criteria.evidence_count) {
      return false;
    }

    // If all criteria met (or no specific criteria), check for root/admin access
    return state.current_access_level === "root" || state.current_access_level === "admin";
  }

  /**
   * Check if objective should escalate to human
   */
  shouldEscalate(objectiveId) {
    const obj = this.activeObjectives.get(objectiveId);
    if (!obj) return { escalate: false };

    // Max iterations reached
    if (obj.state.iterations >= obj.max_iterations) {
      return {
        escalate: true,
        reason: "exhausted_attempts",
        message: `Reached max iterations (${obj.max_iterations}) without achieving objective`
      };
    }

    // All known attack paths blocked
    const totalPaths = obj.attack_plan?.paths?.length || 0;
    const blockedPaths = obj.state.blocked_paths.length;
    if (totalPaths > 0 && blockedPaths >= totalPaths) {
      return {
        escalate: true,
        reason: "all_paths_exhausted",
        message: "All attack vectors tried and blocked. Need new strategy."
      };
    }

    // Critical finding detected
    const criticalFindings = obj.state.findings.filter(f => f.severity === "critical" && f.type === "active_breach");
    if (criticalFindings.length > 0) {
      return {
        escalate: true,
        reason: "critical_finding",
        message: `Active breach detected: ${criticalFindings[0].title}`
      };
    }

    // Scope uncertainty
    if (obj.state.scope_uncertainty) {
      return {
        escalate: true,
        reason: "scope_uncertainty",
        message: "Target ownership unclear - need authorization confirmation"
      };
    }

    return { escalate: false };
  }

  /**
   * Mark objective as completed
   */
  async completeObjective(objectiveId, success = true, reason = null) {
    const obj = this.activeObjectives.get(objectiveId);
    if (!obj) throw new Error(`Objective ${objectiveId} not found`);

    obj.state.status = success ? "completed" : "failed";
    obj.state.completion_time = new Date().toISOString();
    obj.state.completion_reason = reason;

    // Update DB
    await this.db.query(`
      UPDATE agent_audit_log
      SET status = $1, completed_at = NOW(), output = $2, findings = $3, evidence = $4
      WHERE metadata->>'objective_id' = $5
    `, [
      obj.state.status,
      reason,
      JSON.stringify(obj.state.findings),
      JSON.stringify(obj.state.evidence),
      objectiveId
    ]);

    this.log(`[ObjectiveEngine] Objective ${objectiveId} ${obj.state.status}: ${reason}`);

    return obj;
  }

  /**
   * Get objective state
   */
  getObjective(objectiveId) {
    return this.activeObjectives.get(objectiveId);
  }

  /**
   * Default success criteria based on goal type
   */
  _defaultSuccessCriteria(goal) {
    const goalLower = goal.toLowerCase();

    if (goalLower.includes("root") || goalLower.includes("admin")) {
      return { access_level: "root", evidence_count: 1 };
    }

    if (goalLower.includes("scan") || goalLower.includes("enumerate")) {
      return { required_findings: ["open_ports", "services"], evidence_count: 1 };
    }

    if (goalLower.includes("exploit") || goalLower.includes("compromise")) {
      return { access_level: "user", evidence_count: 1 };
    }

    // Generic criteria
    return { evidence_count: 1 };
  }

  /**
   * Generate attack narrative from objective state
   */
  generateNarrative(objectiveId) {
    const obj = this.activeObjectives.get(objectiveId);
    if (!obj) return null;

    const timeline = obj.state.attempts.map((attempt, idx) => {
      return `**Attempt ${idx + 1}:** ${attempt.method} - ${attempt.result}`;
    }).join("\n");

    const findings = obj.state.findings.map(f => {
      return `- [${f.severity.toUpperCase()}] ${f.title}`;
    }).join("\n");

    return `
# Attack Narrative — ${obj.goal}

**Target:** ${obj.target}
**Objective:** ${obj.goal}
**Status:** ${obj.state.status}
**Time:** ${obj.state.start_time} → ${obj.state.completion_time || "ongoing"}
**Iterations:** ${obj.state.iterations}/${obj.max_iterations}

## Timeline

${timeline}

## Findings

${findings}

## Evidence

${obj.state.evidence.length} files collected:
${obj.state.evidence.map(e => `- ${e}`).join("\n")}

## Final Access Level

${obj.state.current_access_level}
`.trim();
  }
}

module.exports = { ObjectiveEngine };
