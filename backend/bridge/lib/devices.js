// devices.js — canonical Ozzu infra registry for Node consumers.
// Reads infra/devices.json (override with $OZZU_INFRA_JSON env).
//
// Usage:
//   const { getDevice, getGcp, listDevices } = require('./lib/devices');
//   const dev01 = getDevice('dev-01');
//   ping(dev01.wg_ip);
//
// Companion: scripts/lib/infra.sh provides the same data to bash scripts.
// Human-prose context (history, decisions) lives in
// ~/.claude/projects/-home-gcp-ozzu/memory/infra_registry.md.

const fs = require('fs');
const path = require('path');

// Locate devices.json. Explicit env var wins. Otherwise try (a) repo-root
// relative to this file (works on the host) and (b) the in-container repo
// mount path /home/gcp/ozzu/infra/devices.json (bridge container mounts it).
function _resolveInfraPath() {
  if (process.env.OZZU_INFRA_JSON) return process.env.OZZU_INFRA_JSON;
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'infra', 'devices.json'),
    '/home/gcp/ozzu/infra/devices.json',
  ];
  for (const p of candidates) {
    try { fs.accessSync(p); return p; } catch {}
  }
  return candidates[0];
}
const INFRA_PATH = _resolveInfraPath();

// Load secret env vars from a bash-style file ($HOME/.ozzu-secrets by default)
// into process.env, on first require. Failing-soft: missing file is fine, and
// vars already set in process.env take precedence over the file.
function _loadSecrets() {
  const secretsPath = process.env.OZZU_SECRETS || '/root/.ozzu-secrets';
  let text;
  try { text = fs.readFileSync(secretsPath, 'utf8'); } catch { return; }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(?:'([^']*)'|"([^"]*)"|(.*))$/);
    if (!m) continue;
    const [, key, sq, dq, bare] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = sq ?? dq ?? bare ?? '';
  }
}
_loadSecrets();

let _cache = null;
let _cacheStat = null;

function _load() {
  const stat = fs.statSync(INFRA_PATH);
  if (_cache && _cacheStat && stat.mtimeMs === _cacheStat.mtimeMs) return _cache;
  _cache = JSON.parse(fs.readFileSync(INFRA_PATH, 'utf8'));
  _cacheStat = stat;
  return _cache;
}

function getGcp() {
  return _load().gcp;
}

function getDevice(name) {
  const d = _load().devices?.[name];
  if (!d) throw new Error(`getDevice: unknown device "${name}" (known: ${listDevices().join(', ')})`);
  return d;
}

function listDevices() {
  return Object.keys(_load().devices || {});
}

function getEsp32Nodes() {
  return _load().esp32_nodes || {};
}

// Build the canonical reachable address for a device — prefers WG, falls back
// to LAN, then WiFi. Throws if no address is present.
function getAddress(name) {
  const d = getDevice(name);
  return d.wg_ip || d.lan_ip || d.wifi_ip
    || (() => { throw new Error(`getAddress: ${name} has no address fields`); })();
}

// Build a SSH spec object — { user, host, key, jump } — for callers that want
// to construct ssh invocations. Returns null if device has no ssh_user.
function getSshSpec(name) {
  const d = getDevice(name);
  if (!d.ssh_user) return null;
  return {
    user: d.ssh_user,
    host: d.ssh_alias || d.wg_ip || d.lan_ip,
    key: d.ssh_key || null,
    jump: d.ssh_jump || null,
    kex_legacy: !!d.ssh_kex_legacy,
  };
}

module.exports = { getGcp, getDevice, getAddress, getSshSpec, listDevices, getEsp32Nodes };
