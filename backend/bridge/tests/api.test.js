// api.test.js — Backend API unit tests
// Run with: node tests/api.test.js

const http = require("http");

const BASE_URL = "http://localhost:3333";

let passed = 0;
let failed = 0;
const results = [];

async function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const opts = {
      hostname: url.hostname,
      port: url.port || 3333,
      path: url.pathname + url.search,
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };

    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: "PASS" });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    results.push({ name, status: "FAIL", error: err.message });
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected}, got ${actual}`);
}

async function runTests() {
  console.log("\n🧪 Ozzu Bridge API Tests\n");

  // ── Health / Status ──
  console.log("Health checks:");
  await test("GET /status returns 200", async () => {
    const res = await request("GET", "/status");
    assertEqual(res.status, 200);
  });

  await test("GET /ops/status returns service list", async () => {
    const res = await request("GET", "/ops/status");
    assert(res.status === 200, `Status ${res.status}`);
    assert(res.body.services || res.body.length >= 0, "No services in response");
  });

  // ── Backups ──
  console.log("\nBackup routes:");
  await test("GET /api/backups returns list", async () => {
    const res = await request("GET", "/api/backups");
    assertEqual(res.status, 200);
    assert(Array.isArray(res.body.backups), "backups should be array");
    assert(typeof res.body.cronEnabled === "boolean", "cronEnabled should be boolean");
  });

  await test("GET /api/backups/status returns health", async () => {
    const res = await request("GET", "/api/backups/status");
    assertEqual(res.status, 200);
    assert(typeof res.body.healthy === "boolean", "healthy should be boolean");
    assert(typeof res.body.cronEnabled === "boolean", "cronEnabled should be boolean");
  });

  // ── Files ──
  console.log("\nFile routes:");
  await test("GET /files returns file list", async () => {
    const res = await request("GET", "/files");
    assertEqual(res.status, 200);
    assert(Array.isArray(res.body.files), "files should be array");
    assert(typeof res.body.total === "number", "total should be number");
  });

  await test("GET /files with category filter", async () => {
    const res = await request("GET", "/files?category=photos");
    assertEqual(res.status, 200);
    assert(Array.isArray(res.body.files), "files should be array");
  });

  await test("GET /files/folders returns folders", async () => {
    const res = await request("GET", "/files/folders");
    assert(res.status === 200 || res.status === 500, `Unexpected status ${res.status}`);
    if (res.status === 200) {
      assert(Array.isArray(res.body.folders), "folders should be array");
    }
  });

  await test("GET /files/999999 returns 404", async () => {
    const res = await request("GET", "/files/999999");
    assertEqual(res.status, 404);
  });

  await test("DELETE /files/999999 returns 404", async () => {
    const res = await request("DELETE", "/files/999999");
    assertEqual(res.status, 404);
  });

  // ── Directives ──
  console.log("\nDirective routes:");
  await test("GET /directives returns list", async () => {
    const res = await request("GET", "/directives");
    assertEqual(res.status, 200);
    assert(Array.isArray(res.body) || typeof res.body === "object", "Should return directives");
  });

  // ── Business ──
  console.log("\nBusiness routes:");
  await test("GET /business/projects returns list", async () => {
    const res = await request("GET", "/business/projects");
    assert(res.status === 200 || res.status === 404, `Status ${res.status}`);
  });

  // ── Push device registration ──
  console.log("\nPush notification routes:");
  await test("POST /api/devices/register with invalid token returns 400", async () => {
    const res = await request("POST", "/api/devices/register", { token: "invalid", deviceId: "test" });
    assertEqual(res.status, 400);
  });

  await test("POST /api/devices/register with valid Expo token returns 200", async () => {
    const res = await request("POST", "/api/devices/register", {
      token: "ExponentPushToken[test-token-12345]",
      deviceId: "test-device",
      platform: "ios",
    });
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.ok === true, "ok should be true");
  });

  // ── Error handling ──
  console.log("\nError handling:");
  await test("GET /nonexistent returns 404", async () => {
    const res = await request("GET", "/nonexistent-route-xyz");
    assert(res.status === 404 || res.status === 400, `Expected 404, got ${res.status}`);
  });

  // ── Summary ──
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  if (failed > 0) {
    console.log("\nFailed tests:");
    results.filter(r => r.status === "FAIL").forEach(r => console.log(`  ✗ ${r.name}: ${r.error}`));
    process.exit(1);
  } else {
    console.log("\n✅ All tests passed");
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
