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

const DEFAULT_PATH = path.resolve(__dirname, '..', '..', '..', 'infra', 'devices.json');
const INFRA_PATH = process.env.OZZU_INFRA_JSON || DEFAULT_PATH;

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
