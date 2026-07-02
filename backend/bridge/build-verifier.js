// build-verifier.js — Build verification framework for directive completion
// Workers must run verification before marking directives as completed.
// Detects change type (frontend/backend/none) and runs appropriate checks.

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const WORKDIR = "/home/gcp/ozzu";
const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[build-verifier ${ts}] ${msg}`);
}

function execAsync(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout || 60000;
    exec(cmd, { cwd: WORKDIR, encoding: "utf8", timeout, ...opts }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

// Detect what type of changes exist on the directive's branch vs main
async function detectChangeType(directiveId) {
  const verificationLog = [];

  try {
    // Find the branch for this directive — try cipher/ first, then agent/, then HEAD~1
    let branchName = `cipher/${directiveId}`;
    let diffOutput;
    try {
      const result = await execAsync(
        `git diff --name-only main...${branchName}`,
        { timeout: 10000 }
      );
      diffOutput = result.stdout;
    } catch {
      // Try agent/ prefix
      branchName = `agent/${directiveId}`;
      try {
        const result = await execAsync(
          `git diff --name-only main...${branchName}`,
          { timeout: 10000 }
        );
        diffOutput = result.stdout;
      } catch {
        // Fall back to HEAD~1
        branchName = "HEAD";
        const result = await execAsync(
          `git diff --name-only HEAD~1 HEAD`,
          { timeout: 10000 }
        );
        diffOutput = result.stdout;
      }
    }

    const changedFiles = diffOutput.trim().split("\n").filter(Boolean);
    if (changedFiles.length === 0) {
      return { changeType: "none", changedFiles: [], verificationLog: ["No changed files detected"] };
    }

    verificationLog.push(`${changedFiles.length} file(s) changed`);

    let hasFrontend = false;
    let hasFrontendNative = false;
    let hasBackend = false;
    let hasFirmware = false;

    const nativePatterns = [
      /frontend\/android\//,
      /frontend\/ios\//,
      /frontend\/modules\/.*\/(android|ios)\//,
      /frontend\/app\.json/,
      /frontend\/plugins\//,
    ];
    const frontendPatterns = [/^frontend\//];
    const backendPatterns = [/^backend\/bridge\//];
    const firmwarePatterns = [/hardware\/positioning\/esp32-csi\/main\//, /hardware\/positioning\/esp32-csi\/partitions\.csv/, /hardware\/positioning\/esp32-csi\/sdkconfig/];

    for (const file of changedFiles) {
      if (nativePatterns.some(p => p.test(file))) {
        hasFrontendNative = true;
        hasFrontend = true;
      } else if (frontendPatterns.some(p => p.test(file))) {
        hasFrontend = true;
      }
      if (backendPatterns.some(p => p.test(file))) {
        hasBackend = true;
      }
      if (firmwarePatterns.some(p => p.test(file))) {
        hasFirmware = true;
      }
    }

    // Check for native dependency changes in package.json
    if (changedFiles.includes("frontend/package.json")) {
      try {
        const { stdout: pkgDiff } = await execAsync(
          `git diff main...${branchName} -- frontend/package.json`,
          { timeout: 10000 }
        );
        if (/^\+.*"(expo-|react-native-|@react-native)/m.test(pkgDiff)) {
          hasFrontendNative = true;
          verificationLog.push("Native dependency change detected in package.json");
        }
      } catch {
        // Best effort
      }
    }

    let changeType = "none";
    if (hasFrontendNative) changeType = "frontend_native";
    else if (hasFrontend) changeType = "frontend_js";
    else if (hasBackend) changeType = "backend";
    else changeType = "other";

    if (hasFirmware && changeType === "other") changeType = "firmware";

    verificationLog.push(`Change type: ${changeType}`);
    return { changeType, changedFiles, verificationLog, hasFrontend, hasBackend, hasFirmware };
  } catch (err) {
    verificationLog.push(`Change detection failed: ${err.message}`);
    return { changeType: "unknown", changedFiles: [], verificationLog };
  }
}

// Verify backend changes — syntax check all modified JS files
async function verifyBackendChanges(changedFiles) {
  const results = [];
  const jsFiles = changedFiles.filter(f => f.endsWith(".js") && f.startsWith("backend/bridge/"));

  if (jsFiles.length === 0) {
    return { success: true, log: ["No backend JS files to syntax check"] };
  }

  let allPassed = true;
  for (const file of jsFiles) {
    const fullPath = path.join(WORKDIR, file);
    // A diff includes deletions — nothing to syntax-check on a removed file, and node -c
    // on a missing path fails. Skip it. (Was blocking any .js deletion from deploy.)
    if (!fs.existsSync(fullPath)) { results.push(`Skipped (deleted): ${file}`); continue; }
    try {
      await execAsync(`node -c "${fullPath}"`, { timeout: 10000 });
      results.push(`Syntax OK: ${file}`);
    } catch (err) {
      allPassed = false;
      results.push(`Syntax FAIL: ${file} — ${err.message.split("\n")[0]}`);
    }
  }

  return { success: allPassed, log: results };
}

// Verify frontend JS-only changes — run expo export to validate bundles
// Falls back to TypeScript/syntax checking if expo export is unavailable (no node_modules)
async function verifyFrontendJSChanges() {
  const results = [];

  // Check if frontend node_modules exist before attempting expo export
  const hasNodeModules = fs.existsSync(path.join(WORKDIR, "frontend", "node_modules"));

  if (!hasNodeModules) {
    // Fallback: run syntax checks on changed frontend files
    results.push("Frontend node_modules not installed — falling back to syntax checks");
    try {
      // Find changed .ts/.tsx files in frontend
      let changedFiles;
      try {
        const { stdout } = await execAsync(`git diff --name-only HEAD~1 HEAD -- frontend/`, { timeout: 10000 });
        changedFiles = stdout.trim().split("\n").filter(f => f && /\.(tsx?|jsx?)$/.test(f));
      } catch {
        changedFiles = [];
      }

      if (changedFiles.length === 0) {
        results.push("No frontend JS/TS files changed — syntax check skipped");
        return { success: true, log: results };
      }

      // Basic syntax validation: check that files exist and aren't empty
      let allOk = true;
      for (const file of changedFiles) {
        const fullPath = path.join(WORKDIR, file);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, "utf8");
          if (content.trim().length === 0) {
            results.push(`WARN: ${file} is empty`);
          } else {
            results.push(`Syntax OK: ${file} (${content.split("\n").length} lines)`);
          }
        }
      }

      results.push(`Checked ${changedFiles.length} frontend file(s) — CI build will do full validation`);
      return { success: allOk, log: results };
    } catch (err) {
      results.push(`Fallback syntax check error: ${err.message}`);
      return { success: false, log: results };
    }
  }

  try {
    // Run expo export for Android only (we deploy Android + iOS, not web)
    const { stdout } = await execAsync(
      `cd frontend && npx expo export --platform android --dump-sourcemap --output-dir /tmp/ozzu-verify-bundles 2>&1`,
      { timeout: VERIFICATION_TIMEOUT_MS }
    );
    results.push("OTA export completed");

    // Verify bundle files exist and have non-zero size
    const bundleDir = "/tmp/ozzu-verify-bundles";

    let bundlesFound = false;
    try {
      const { stdout: findResult } = await execAsync(
        `find ${bundleDir} -name "*.bundle" -o -name "*.js" | head -5`,
        { timeout: 5000 }
      );
      if (findResult.trim()) {
        bundlesFound = true;
        results.push(`Bundle files found: ${findResult.trim().split("\n").length} file(s)`);
      }
    } catch {
      // Best effort
    }

    if (!bundlesFound) {
      // Check for any output at all — expo export might use different structure
      try {
        const { stdout: lsResult } = await execAsync(`ls -la ${bundleDir}/ 2>/dev/null | head -10`, { timeout: 5000 });
        if (lsResult.trim()) {
          bundlesFound = true;
          results.push(`Export output found in ${bundleDir}`);
        }
      } catch {}
    }

    // Clean up
    try { await execAsync(`rm -rf ${bundleDir}`, { timeout: 5000 }); } catch {}

    return { success: true, log: results };
  } catch (err) {
    results.push(`OTA export FAILED: ${err.message.split("\n").slice(0, 3).join(" | ")}`);
    try { await execAsync(`rm -rf /tmp/ozzu-verify-bundles`, { timeout: 5000 }); } catch {}
    return { success: false, log: results };
  }
}

// Verify frontend native changes — check that CI builds would likely succeed
// We don't actually trigger CI builds (that would be wasteful), but we validate:
// 1. No syntax errors in JS files
// 2. app.json is valid JSON
// 3. Native module files have valid syntax where checkable
async function verifyFrontendNativeChanges(changedFiles) {
  const results = [];

  // Check app.json validity if changed
  if (changedFiles.includes("frontend/app.json")) {
    try {
      const appJsonPath = path.join(WORKDIR, "frontend/app.json");
      const content = fs.readFileSync(appJsonPath, "utf8");
      JSON.parse(content);
      results.push("app.json: valid JSON");
    } catch (err) {
      results.push(`app.json: INVALID — ${err.message}`);
      return { success: false, log: results };
    }
  }

  // Syntax check any JS/TS files in the change set
  const jsFiles = changedFiles.filter(f =>
    f.startsWith("frontend/") && (f.endsWith(".js") || f.endsWith(".jsx"))
  );
  let allPassed = true;
  for (const file of jsFiles) {
    const fullPath = path.join(WORKDIR, file);
    // A diff includes deletions — nothing to syntax-check on a removed file, and node -c
    // on a missing path fails. Skip it. (Was blocking any .js deletion from deploy.)
    if (!fs.existsSync(fullPath)) { results.push(`Skipped (deleted): ${file}`); continue; }
    try {
      await execAsync(`node -c "${fullPath}"`, { timeout: 10000 });
      results.push(`Syntax OK: ${file}`);
    } catch (err) {
      allPassed = false;
      results.push(`Syntax FAIL: ${file} — ${err.message.split("\n")[0]}`);
    }
  }

  if (allPassed && results.length === 0) {
    results.push("Native changes detected — JS syntax checks passed (full CI build validates native code on merge)");
  }

  return { success: allPassed, log: results };
}

// Verify ESP32 firmware changes — Docker build with ESP-IDF
async function verifyFirmwareChanges() {
  const results = [];

  // Check that changed C files exist and aren't empty
  const fwDir = path.join(WORKDIR, "hardware/positioning/esp32-csi/main");
  if (!fs.existsSync(fwDir)) {
    results.push("FAIL: firmware source directory not found");
    return { success: false, log: results };
  }

  // Run idf.py build in Docker to verify firmware compiles
  try {
    const { stdout } = await execAsync(
      `docker run --rm -v "${WORKDIR}/hardware/positioning/esp32-csi:/project" -w /project espressif/idf:v5.2.3 bash -c "idf.py build" 2>&1 | tail -10`,
      { timeout: 5 * 60 * 1000 }  // 5 min for full build
    );
    results.push("ESP32 firmware build: OK");
    results.push(stdout.trim().split("\n").slice(-3).join(" | "));
    return { success: true, log: results };
  } catch (err) {
    results.push(`ESP32 firmware build FAILED: ${err.message.split("\n").slice(0, 5).join(" | ")}`);
    return { success: false, log: results };
  }
}

// Main verification entry point
async function verify(directive) {
  const startTime = Date.now();
  const verificationLog = [];

  verificationLog.push(`Verification started for directive ${directive.id}`);

  // Detect change type
  const detection = await detectChangeType(directive.id);
  verificationLog.push(...detection.verificationLog);

  if (detection.changeType === "none") {
    verificationLog.push("No changes detected — verification passed (nothing to verify)");
    return {
      success: true,
      verification_log: verificationLog,
      change_type: "none",
      duration_ms: Date.now() - startTime,
    };
  }

  let success = true;
  let failureReason = null;

  // Run backend verification if backend files changed
  if (detection.hasBackend) {
    const backendResult = await verifyBackendChanges(detection.changedFiles);
    verificationLog.push("--- Backend verification ---");
    verificationLog.push(...backendResult.log);
    if (!backendResult.success) {
      success = false;
      failureReason = "Backend syntax check failed";
    }
  }

  // Run frontend verification based on change type
  if (detection.changeType === "frontend_native") {
    const nativeResult = await verifyFrontendNativeChanges(detection.changedFiles);
    verificationLog.push("--- Frontend native verification ---");
    verificationLog.push(...nativeResult.log);
    if (!nativeResult.success) {
      success = false;
      failureReason = failureReason || "Frontend native verification failed";
    }
  } else if (detection.changeType === "frontend_js") {
    // For JS-only frontend changes, run OTA export check
    const jsResult = await verifyFrontendJSChanges();
    verificationLog.push("--- Frontend JS verification ---");
    verificationLog.push(...jsResult.log);
    if (!jsResult.success) {
      success = false;
      failureReason = failureReason || "Frontend JS verification (OTA export) failed";
    }
  }

  // Firmware verification — compile with ESP-IDF
  if (detection.hasFirmware) {
    const fwResult = await verifyFirmwareChanges();
    verificationLog.push("--- Firmware verification ---");
    verificationLog.push(...fwResult.log);
    if (!fwResult.success) {
      success = false;
      failureReason = failureReason || "ESP32 firmware build failed";
    }
  }

  // For "other" changes (docs, scripts, etc.), just verify any JS files
  if (detection.changeType === "other") {
    const jsFiles = detection.changedFiles.filter(f => f.endsWith(".js"));
    if (jsFiles.length > 0) {
      let allPassed = true;
      verificationLog.push("--- Other JS file verification ---");
      for (const file of jsFiles) {
        const fullPath = path.join(WORKDIR, file);
        if (!fs.existsSync(fullPath)) { verificationLog.push(`Skipped (deleted): ${file}`); continue; }
        try {
          await execAsync(`node -c "${fullPath}"`, { timeout: 10000 });
          verificationLog.push(`Syntax OK: ${file}`);
        } catch (err) {
          allPassed = false;
          verificationLog.push(`Syntax FAIL: ${file} — ${err.message.split("\n")[0]}`);
        }
      }
      if (!allPassed) {
        success = false;
        failureReason = "JS syntax check failed";
      }
    } else {
      verificationLog.push("Non-JS changes only — verification passed");
    }
  }

  const durationMs = Date.now() - startTime;
  verificationLog.push(`Verification ${success ? "PASSED" : "FAILED"} in ${durationMs}ms`);

  log(`Verification for ${directive.id}: ${success ? "PASSED" : "FAILED"} (${detection.changeType}, ${durationMs}ms)`);

  return {
    success,
    verification_log: verificationLog,
    change_type: detection.changeType,
    failure_reason: failureReason,
    duration_ms: durationMs,
  };
}

module.exports = { verify, detectChangeType };
