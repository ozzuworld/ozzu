/**
 * Influence Engine — Social media account management & content automation
 * Manages real accounts from real people with their consent.
 * Uses Dolphin Anty for browser profiles, Decodo for proxies, CapSolver for CAPTCHAs.
 *
 * Directive: dir_1775926142812
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");

const ENV_PATH = "/home/gcp/ozzu/private/influence-ops-credentials.env";

// AES-256-GCM encryption for stored credentials
const ENCRYPTION_KEY = crypto.createHash("sha256").update("ozzu-influence-vault").digest();

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch (err) {
    console.error("[influence] Failed to load env:", err.message);
  }
  return env;
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return iv.toString("hex") + ":" + tag + ":" + encrypted;
}

function decrypt(data) {
  const [ivHex, tagHex, encrypted] = data.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// --- Dolphin Anty API ---

async function dolphinRequest(method, path, body) {
  const env = loadEnv();
  const token = env.DOLPHIN_ANTY_TOKEN;
  if (!token) throw new Error("DOLPHIN_ANTY_TOKEN not configured");

  const url = `https://dolphin-anty-api.com${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dolphin API ${resp.status}: ${text.substring(0, 200)}`);
  }
  return resp.json();
}

async function createDolphinProfile(name, proxyPort) {
  const env = loadEnv();
  const profile = {
    name,
    platform: "windows",
    browserType: "anty",
    mainWebsite: "",
    useragent: {
      mode: "manual",
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    },
    webrtc: { mode: "altered", ipAddress: null },
    canvas: { mode: "noise" },
    webgl: { mode: "noise" },
    webglInfo: { mode: "manual", vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    geolocation: { mode: "auto" },
    timezone: { mode: "auto" },
    locale: { mode: "auto" },
    proxy: {
      type: "http",
      host: "us.decodo.com",
      port: String(proxyPort),
      login: env.DECODO_PROXY_USER,
      password: env.DECODO_PROXY_PASS,
    },
    statusId: 0,
    tags: ["influence"],
  };

  return dolphinRequest("POST", "/browser_profiles", profile);
}

async function listDolphinProfiles() {
  return dolphinRequest("GET", "/browser_profiles?limit=100&tags[]=influence");
}

async function deleteDolphinProfile(profileId) {
  return dolphinRequest("DELETE", `/browser_profiles/${profileId}`);
}

// --- CapSolver ---

async function solveCapSolver(taskType, taskParams) {
  const env = loadEnv();
  const clientKey = env.CAPSOLVER_API_KEY;
  if (!clientKey) throw new Error("CAPSOLVER_API_KEY not configured");

  const createResp = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, task: { type: taskType, ...taskParams } }),
  });
  const createData = await createResp.json();
  if (createData.errorId !== 0) throw new Error(`CapSolver: ${createData.errorDescription || createData.errorCode}`);

  // Sync tasks return immediately
  if (createData.status === "ready") return createData.solution;

  // Async — poll
  const taskId = createData.taskId;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const resultResp = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey, taskId }),
    });
    const result = await resultResp.json();
    if (result.status === "ready") return result.solution;
    if (result.errorId !== 0) throw new Error(`CapSolver: ${result.errorDescription || result.errorCode}`);
  }
  throw new Error("CapSolver timeout");
}

async function getCapSolverBalance() {
  const env = loadEnv();
  const clientKey = env.CAPSOLVER_API_KEY;
  if (!clientKey) return null;

  const resp = await fetch("https://api.capsolver.com/getBalance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey }),
  });
  const data = await resp.json();
  return data.balance;
}

module.exports = {
  loadEnv,
  encrypt,
  decrypt,
  dolphinRequest,
  createDolphinProfile,
  listDolphinProfiles,
  deleteDolphinProfile,
  solveCapSolver,
  getCapSolverBalance,
};
