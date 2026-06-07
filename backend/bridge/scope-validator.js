// scope-validator.js — dir_1780846961338
//
// Validates engagement.scope.targets so we never ship an engagement with
// free-text targets that the workspace_jail (dir_1780844590951) silently
// blocks every concrete IP against.
//
// Discovered tonight via trace_dispatch on engagement 628 — scope.targets
// was the string "EDIFICIO LAURA LAN — subnet TBD..." which blocked every
// IP from running.

"use strict";

const IPV4_RE   = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const CIDR_RE   = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;
const HOST_RE   = /^[a-zA-Z](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

function classifyTarget(raw) {
  const s = String(raw || "").trim().split(":")[0]; // strip optional :port
  if (!s) return { kind: "empty", value: raw };
  if (CIDR_RE.test(s)) {
    const [, bits] = s.split("/");
    const b = parseInt(bits, 10);
    if (b < 0 || b > 32) return { kind: "free_text", value: raw, reason: "CIDR bits out of range" };
    return { kind: "cidr", value: s };
  }
  if (IPV4_RE.test(s)) {
    const parts = s.split(".").map(Number);
    if (parts.every(p => p >= 0 && p <= 255)) return { kind: "ipv4", value: s };
    return { kind: "free_text", value: raw, reason: "IPv4 octet out of range" };
  }
  if (HOST_RE.test(s) && s.includes(".") && !s.includes(" ")) return { kind: "hostname", value: s };
  return { kind: "free_text", value: raw };
}

function validateScope(scope) {
  if (!scope || typeof scope !== "object") {
    return {
      valid_count: 0, free_text_count: 0, classifications: [],
      machine_readable: false,
      warnings: ["scope is missing or not an object — workspace_jail will be permissive (legacy fallback)"],
    };
  }
  const targets = Array.isArray(scope.targets) ? scope.targets : [];
  if (targets.length === 0) {
    return {
      valid_count: 0, free_text_count: 0, classifications: [],
      machine_readable: false,
      warnings: ["scope.targets is empty — workspace_jail will be permissive (legacy fallback); ANY IP would be allowed in scope"],
    };
  }
  const classifications = targets.map(classifyTarget);
  const validCount = classifications.filter(c => c.kind === "ipv4" || c.kind === "cidr").length;
  const freeTextCount = classifications.filter(c => c.kind === "free_text" || c.kind === "empty").length;
  const machineReadable = validCount > 0;
  const warnings = [];
  if (!machineReadable) {
    warnings.push(
      `scope.targets contains ${freeTextCount} free-text entries and ZERO IPv4/CIDR entries. ` +
      `The workspace_jail layer will REJECT every dispatched command because no concrete target ` +
      `matches the scope. Either: (a) add an IPv4 or CIDR to scope.targets when you confirm the ` +
      `subnet, or (b) accept that all commands will fail at workspace_jail until you do.`
    );
  }
  if (machineReadable && freeTextCount > 0) {
    warnings.push(
      `${freeTextCount} free-text entries detected alongside ${validCount} machine-readable. ` +
      `Free-text entries are ignored by the workspace_jail — use scope.targets_note for human context.`
    );
  }
  for (const c of classifications) {
    if (c.kind === "free_text" && c.reason) {
      warnings.push(`Target "${String(c.value).slice(0, 60)}" misclassified — ${c.reason}`);
    }
  }
  return {
    valid_count: validCount,
    free_text_count: freeTextCount,
    hostname_count: classifications.filter(c => c.kind === "hostname").length,
    cidr_count: classifications.filter(c => c.kind === "cidr").length,
    ipv4_count: classifications.filter(c => c.kind === "ipv4").length,
    classifications,
    machine_readable: machineReadable,
    warnings,
  };
}

module.exports = { classifyTarget, validateScope };
