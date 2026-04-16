// attack-planner.js — Tactical attack path planning for autonomous pentesting

"use strict";

/**
 * AttackPlanner — Determines next attack vector based on current findings
 *
 * This is Cipher's tactical brain. It analyzes Joko's findings and decides
 * the optimal next step to achieve the objective.
 */
class AttackPlanner {
  constructor(log) {
    this.log = log || console.log;
  }

  /**
   * Generate initial attack plan for an objective
   */
  createAttackPlan(objective) {
    const goal = objective.goal.toLowerCase();
    const target = objective.target;

    // Default attack paths based on objective type
    let paths = [];

    if (goal.includes("root") || goal.includes("admin") || goal.includes("compromise")) {
      paths = this._rootAccessPaths(target);
    } else if (goal.includes("scan") || goal.includes("enumerate")) {
      paths = this._enumerationPaths(target);
    } else if (goal.includes("wifi") || goal.includes("wireless")) {
      paths = this._wirelessPaths(target);
    } else {
      // Generic compromise paths
      paths = this._rootAccessPaths(target);
    }

    return {
      objective_id: objective.id,
      paths,
      current_path_index: 0,
    };
  }

  /**
   * Determine next attack step based on current state
   */
  determineNextStep(objective, currentState) {
    const plan = objective.attack_plan;
    if (!plan || !plan.paths || plan.paths.length === 0) {
      return null; // No paths available
    }

    // Check if current path is blocked
    const currentPath = plan.paths[plan.current_path_index];
    if (currentState.blocked_paths.includes(currentPath.name)) {
      // Move to next path
      plan.current_path_index++;
      if (plan.current_path_index >= plan.paths.length) {
        return null; // All paths exhausted
      }
    }

    const nextPath = plan.paths[plan.current_path_index];
    const stepIndex = this._getCurrentStepIndex(currentState, nextPath);

    if (stepIndex >= nextPath.steps.length) {
      // Current path completed, mark as blocked if no success
      if (currentState.current_access_level === "none" || currentState.current_access_level === "user") {
        currentState.blocked_paths.push(nextPath.name);
      }
      plan.current_path_index++;
      if (plan.current_path_index >= plan.paths.length) {
        return null; // All paths exhausted
      }
      return this.determineNextStep(objective, currentState);
    }

    return {
      path: nextPath.name,
      step: nextPath.steps[stepIndex],
      step_index: stepIndex,
    };
  }

  /**
   * Root access attack paths (most common objective)
   */
  _rootAccessPaths(target) {
    return [
      {
        name: "smb_exploit",
        priority: 1,
        description: "SMB vulnerability exploitation (EternalBlue, SMBGhost)",
        steps: [
          {
            task: `nmap scan ${target} - focus on port 445`,
            method: "nmap",
            expected_findings: ["open_ports", "smb_version"],
          },
          {
            task: `Check ${target} for SMB vulnerabilities (MS17-010, CVE-2020-0796)`,
            method: "nmap_vuln_scripts",
            expected_findings: ["vulnerability"],
          },
          {
            task: `Exploit SMB vulnerability on ${target} using Metasploit`,
            method: "metasploit_smb",
            expected_access: "system",
          },
        ],
      },
      {
        name: "web_exploit",
        priority: 2,
        description: "Web application vulnerabilities",
        steps: [
          {
            task: `Scan ${target} for web services (ports 80, 443, 8080)`,
            method: "nmap",
            expected_findings: ["open_ports", "http_service"],
          },
          {
            task: `Enumerate web directories on ${target}`,
            method: "gobuster",
            expected_findings: ["web_paths"],
          },
          {
            task: `Test ${target} for common web vulnerabilities (SQLi, XSS, LFI)`,
            method: "manual_web_test",
            expected_findings: ["vulnerability"],
          },
          {
            task: `Exploit web vulnerability on ${target}`,
            method: "web_exploit",
            expected_access: "www-data",
          },
          {
            task: `Privilege escalation on ${target} (SUID, sudo, kernel)`,
            method: "privesc",
            expected_access: "root",
          },
        ],
      },
      {
        name: "ssh_bruteforce",
        priority: 3,
        description: "SSH credential brute force",
        steps: [
          {
            task: `Check if ${target} port 22 is open`,
            method: "nmap",
            expected_findings: ["open_ports", "ssh_version"],
          },
          {
            task: `Brute force SSH on ${target} with common credentials`,
            method: "hydra_ssh",
            expected_access: "user",
          },
          {
            task: `Privilege escalation on ${target}`,
            method: "privesc",
            expected_access: "root",
          },
        ],
      },
      {
        name: "service_exploit",
        priority: 4,
        description: "Exploit other exposed services",
        steps: [
          {
            task: `Full port scan on ${target} (all 65535 ports)`,
            method: "nmap_full",
            expected_findings: ["open_ports", "services"],
          },
          {
            task: `Version detection and vulnerability matching for ${target}`,
            method: "nmap_vuln_scripts",
            expected_findings: ["vulnerability"],
          },
          {
            task: `Exploit identified vulnerability on ${target}`,
            method: "metasploit_generic",
            expected_access: "user",
          },
          {
            task: `Privilege escalation on ${target}`,
            method: "privesc",
            expected_access: "root",
          },
        ],
      },
    ];
  }

  /**
   * Enumeration/scanning attack paths
   */
  _enumerationPaths(target) {
    return [
      {
        name: "full_enumeration",
        priority: 1,
        description: "Complete network and service enumeration",
        steps: [
          {
            task: `Host discovery on ${target}`,
            method: "nmap_ping_sweep",
            expected_findings: ["live_hosts"],
          },
          {
            task: `Port scan on ${target}`,
            method: "nmap_full",
            expected_findings: ["open_ports"],
          },
          {
            task: `Service version detection on ${target}`,
            method: "nmap_version",
            expected_findings: ["services", "versions"],
          },
          {
            task: `OS fingerprinting on ${target}`,
            method: "nmap_os",
            expected_findings: ["os_type"],
          },
        ],
      },
    ];
  }

  /**
   * Wireless attack paths
   */
  _wirelessPaths(target) {
    return [
      {
        name: "wpa2_crack",
        priority: 1,
        description: "WPA2-PSK password cracking",
        steps: [
          {
            task: `Scan for WiFi networks matching ${target}`,
            method: "airodump",
            expected_findings: ["ap_info", "encryption_type"],
          },
          {
            task: `Capture WPA2 handshake for ${target}`,
            method: "hcxdumptool",
            expected_findings: ["handshake"],
          },
          {
            task: `Crack WPA2 password for ${target} using hashcat`,
            method: "hashcat_wpa2",
            expected_findings: ["password"],
          },
        ],
      },
      {
        name: "wps_attack",
        priority: 2,
        description: "WPS PIN brute force",
        steps: [
          {
            task: `Check if ${target} has WPS enabled`,
            method: "wash",
            expected_findings: ["wps_status"],
          },
          {
            task: `WPS PIN attack on ${target}`,
            method: "reaver",
            expected_findings: ["password"],
          },
        ],
      },
    ];
  }

  /**
   * Get current step index in a path based on completed attempts
   */
  _getCurrentStepIndex(currentState, path) {
    const completedSteps = currentState.attempts
      .filter(a => a.path === path.name)
      .length;
    return completedSteps;
  }

  /**
   * Analyze findings and suggest next action
   */
  analyzeFindings(findings) {
    const recommendations = [];

    // Check for critical vulnerabilities
    const criticalVulns = findings.filter(f => f.severity === "critical");
    if (criticalVulns.length > 0) {
      recommendations.push({
        priority: 1,
        action: "exploit_vulnerability",
        target: criticalVulns[0].affected_asset,
        reason: `Critical vulnerability found: ${criticalVulns[0].title}`,
      });
    }

    // Check for open SMB
    const smbFindings = findings.filter(f => f.title.toLowerCase().includes("smb"));
    if (smbFindings.length > 0) {
      recommendations.push({
        priority: 2,
        action: "test_smb_vulns",
        reason: "SMB service exposed",
      });
    }

    // Check for web services
    const webFindings = findings.filter(f => f.title.toLowerCase().includes("http"));
    if (webFindings.length > 0) {
      recommendations.push({
        priority: 3,
        action: "web_enumeration",
        reason: "Web services detected",
      });
    }

    return recommendations;
  }
}

module.exports = { AttackPlanner };
