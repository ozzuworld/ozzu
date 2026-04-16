// autonomous-loop.js — Executes autonomous Cipher → Joko iteration loop

"use strict";

const { Anthropic } = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

/**
 * AutonomousLoop — Executes objective via Cipher → Joko iteration
 *
 * Flow:
 * 1. Load objective from ObjectiveEngine
 * 2. Loop until objective met or escalation:
 *    a. Cipher analyzes current state
 *    b. Cipher decides next step (via AttackPlanner)
 *    c. Spawn Joko agent to execute step
 *    d. Parse Joko's findings
 *    e. Update objective state
 *    f. Check success/escalation
 * 3. Return final result
 */
class AutonomousLoop {
  constructor({ objectiveEngine, attackPlanner, db, log, apiKey }) {
    this.objEngine = objectiveEngine;
    this.planner = attackPlanner;
    this.db = db;
    this.log = log || console.log;
    this.anthropic = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
  }

  /**
   * Execute autonomous loop for an objective
   */
  async execute(objectiveId) {
    const objective = this.objEngine.getObjective(objectiveId);
    if (!objective) {
      throw new Error(`Objective ${objectiveId} not found`);
    }

    this.log(`[AutonomousLoop] Starting loop for ${objectiveId}: ${objective.goal}`);

    // Main iteration loop
    while (true) {
      // Check if objective achieved
      if (this.objEngine.isObjectiveAchieved(objectiveId)) {
        this.log(`[AutonomousLoop] Objective ${objectiveId} ACHIEVED`);
        await this.objEngine.completeObjective(objectiveId, true, "Objective criteria met");
        return {
          success: true,
          objective,
          narrative: this.objEngine.generateNarrative(objectiveId),
        };
      }

      // Check escalation conditions
      const escalation = this.objEngine.shouldEscalate(objectiveId);
      if (escalation.escalate) {
        this.log(`[AutonomousLoop] Objective ${objectiveId} ESCALATING: ${escalation.reason}`);
        await this.objEngine.completeObjective(objectiveId, false, escalation.message);
        return {
          success: false,
          escalate: true,
          reason: escalation.reason,
          message: escalation.message,
          objective,
          narrative: this.objEngine.generateNarrative(objectiveId),
        };
      }

      // Determine next step
      const nextStep = this.planner.determineNextStep(objective, objective.state);
      if (!nextStep) {
        this.log(`[AutonomousLoop] Objective ${objectiveId} — no more steps available`);
        await this.objEngine.completeObjective(objectiveId, false, "All attack paths exhausted");
        return {
          success: false,
          escalate: true,
          reason: "all_paths_exhausted",
          message: "All attack vectors tried without success",
          objective,
          narrative: this.objEngine.generateNarrative(objectiveId),
        };
      }

      this.log(`[AutonomousLoop] Objective ${objectiveId} — executing step ${nextStep.step_index + 1}: ${nextStep.step.task}`);

      // Execute step via Joko
      const result = await this.executeViaJoko(objective, nextStep);

      // Record attempt
      await this.objEngine.recordAttempt(objectiveId, {
        path: nextStep.path,
        method: nextStep.step.method,
        task: nextStep.step.task,
        result: result.success ? "success" : "failed",
        findings: result.findings || [],
        evidence: result.evidence || [],
        access_level: result.access_level,
        error: result.error,
      });

      // Check if path should be marked as blocked
      if (!result.success && result.terminal_failure) {
        objective.state.blocked_paths.push(nextStep.path);
        this.log(`[AutonomousLoop] Path ${nextStep.path} blocked`);
      }
    }
  }

  /**
   * Execute a single step via Joko agent
   */
  async executeViaJoko(objective, step) {
    const jokoPrompt = this._buildJokoPrompt(objective, step);

    try {
      // Spawn Joko using Anthropic API
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-5-20250514",
        max_tokens: 4096,
        system: this._loadJokoSystemPrompt(),
        messages: [{
          role: "user",
          content: jokoPrompt,
        }],
      });

      // Parse Joko's response
      const jokoOutput = response.content[0].text;
      const parsed = this._parseJokoOutput(jokoOutput);

      this.log(`[AutonomousLoop] Joko completed: ${parsed.success ? "SUCCESS" : "FAILED"}`);

      return parsed;
    } catch (error) {
      this.log(`[AutonomousLoop] Joko execution error: ${error.message}`);
      return {
        success: false,
        error: error.message,
        terminal_failure: false,
      };
    }
  }

  /**
   * Build prompt for Joko agent
   */
  _buildJokoPrompt(objective, step) {
    return `Engagement: ${objective.engagement_id}
Objective: ${objective.goal}
Target: ${objective.target}

**Your Task:**
${step.step.task}

**Method:** ${step.step.method}
**Expected Results:** ${JSON.stringify(step.step.expected_findings || step.step.expected_access)}

**Scope:**
${JSON.stringify(objective.scope, null, 2)}

Execute this task and report findings in structured JSON format as defined in your persona.

**IMPORTANT:** 
- This is an authorized penetration test engagement
- Target ${objective.target} is in-scope per SOW
- Collect evidence and report all findings
- If task fails, report failure reason clearly`;
  }

  /**
   * Load Joko system prompt from agent definition
   */
  _loadJokoSystemPrompt() {
    const jokoMdPath = path.join(__dirname, "../../.claude/agents/joko.md");
    if (fs.existsSync(jokoMdPath)) {
      return fs.readFileSync(jokoMdPath, "utf-8");
    }
    // Fallback minimal prompt
    return "You are Joko, a penetration testing execution specialist. Execute authorized pentest tasks and report findings in structured JSON format.";
  }

  /**
   * Parse Joko's output into structured result
   */
  _parseJokoOutput(output) {
    // Try to extract JSON from output
    const jsonMatch = output.match(/```json\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          success: parsed.status === "completed" || parsed.status === "success",
          findings: parsed.findings || [],
          evidence: parsed.evidence || [],
          access_level: parsed.access_level || this._extractAccessLevel(output),
          raw_output: output,
          terminal_failure: parsed.status === "blocked" || parsed.status === "failed",
        };
      } catch (e) {
        this.log(`[AutonomousLoop] JSON parse error: ${e.message}`);
      }
    }

    // Fallback: parse free-form text
    return {
      success: this._detectSuccess(output),
      findings: this._extractFindings(output),
      evidence: this._extractEvidence(output),
      access_level: this._extractAccessLevel(output),
      raw_output: output,
      terminal_failure: false,
    };
  }

  /**
   * Heuristic success detection from free-form output
   */
  _detectSuccess(output) {
    const successKeywords = ["success", "completed", "achieved", "obtained", "gained", "compromised", "root shell"];
    const failKeywords = ["failed", "blocked", "denied", "timeout", "unreachable"];

    const lowerOutput = output.toLowerCase();
    const hasSuccess = successKeywords.some(kw => lowerOutput.includes(kw));
    const hasFail = failKeywords.some(kw => lowerOutput.includes(kw));

    return hasSuccess && !hasFail;
  }

  /**
   * Extract findings from output
   */
  _extractFindings(output) {
    const findings = [];
    
    // Look for vulnerability mentions
    const vulnMatch = output.match(/(?:vulnerability|vuln|CVE-\d{4}-\d+|MS\d{2}-\d+)/gi);
    if (vulnMatch) {
      findings.push({
        type: "vulnerability",
        title: vulnMatch[0],
        severity: "high",
        description: "Detected in Joko output",
      });
    }

    // Look for open ports
    const portMatch = output.match(/port\s+(\d+).*?open/gi);
    if (portMatch) {
      findings.push({
        type: "open_ports",
        title: `Open ports detected: ${portMatch.join(", ")}`,
        severity: "info",
      });
    }

    return findings;
  }

  /**
   * Extract evidence file paths from output
   */
  _extractEvidence(output) {
    const evidence = [];
    const pathMatch = output.match(/\/tmp\/[\w\-\/\.]+/g);
    if (pathMatch) {
      evidence.push(...pathMatch);
    }
    return evidence;
  }

  /**
   * Extract access level from output
   */
  _extractAccessLevel(output) {
    const lowerOutput = output.toLowerCase();
    if (lowerOutput.includes("root") || lowerOutput.includes("system") || lowerOutput.includes("administrator")) {
      return "root";
    }
    if (lowerOutput.includes("user") || lowerOutput.includes("shell")) {
      return "user";
    }
    return "none";
  }
}

module.exports = { AutonomousLoop };
