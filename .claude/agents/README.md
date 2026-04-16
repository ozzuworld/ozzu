# Multi-Agent Pentest System

## Architecture

```
┌──────────────────────────────────────────┐
│  CIPHER (Opus 4.6) — Strategic Layer     │
│  • Engagement planning & SOW generation  │
│  • Evidence analysis (vision + reasoning)│
│  • Report generation (CVSS, MITRE map)   │
│  • Client deliverables                   │
│  • Invokes Joko via invoke_joko MCP tool │
└────────────┬─────────────────────────────┘
             │
             │ delegates via MCP
             ▼
┌──────────────────────────────────────────┐
│  JOKO (Sonnet 4.5) — Execution Layer     │
│  • Tool operation (nmap, Metasploit, etc)│
│  • Evidence collection                   │
│  • Structured finding documentation      │
│  • All actions logged to audit_trail DB  │
└──────────────────────────────────────────┘
```

## Components

### 1. Joko Agent Definition
**File:** `.claude/agents/joko.md`

Defines Joko's persona, rules, authorized techniques, output format, and framing language to avoid classifier issues.

### 2. MCP Tool: `invoke_joko`
**Location:** `backend/bridge/routes/mcp.js`

**Usage:**
```javascript
invoke_joko({
  task: "Full nmap scan of 192.168.1.0/24 - all TCP ports, service detection",
  engagement_id: "SKYLINE-SOC-2026-002",
  directive_id: "dir_XXXXX",  // optional
  scope: {
    subnets: ["192.168.1.0/24"],
    prohibited: ["192.168.1.1"]
  }
})
```

**Returns:**
- Session ID for tracking
- Audit log entry ID
- Evidence directory path

### 3. Audit Trail Database
**Table:** `agent_audit_log`

**Schema:**
```sql
CREATE TABLE agent_audit_log (
  id SERIAL PRIMARY KEY,
  agent_name VARCHAR(50) NOT NULL,       -- 'cipher', 'joko'
  engagement_id VARCHAR(50),
  directive_id VARCHAR(50) REFERENCES directives(id),
  task TEXT NOT NULL,
  spawned_by VARCHAR(50),                -- 'cipher'
  status VARCHAR(20) DEFAULT 'running',  -- running|completed|failed|blocked
  evidence JSONB DEFAULT '[]',           -- file paths
  findings JSONB DEFAULT '[]',           -- structured findings
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  output TEXT,
  metadata JSONB DEFAULT '{}'
);
```

**Indexes:**
- `idx_agent_audit_engagement` — query by engagement
- `idx_agent_audit_agent` — query by agent name
- `idx_agent_audit_spawned` — query by spawner
- `idx_agent_audit_directive` — link to directive

### 4. Evidence Pipeline

**Structure:**
```
/tmp/{engagement_id}/
  evidence/
    nmap_192.168.1.0_full.txt
    nmap_192.168.1.0_full.xml
    screenshot_web_sqli_192.168.1.15.png
    pcap_wpa2_handshake.cap
    finding_001_smb_anon_access.txt
```

**Naming Convention:**
- `{tool}_{target}_{type}.{ext}` — e.g., `nmap_192.168.1.15_full.xml`
- `screenshot_{category}_{target}.png` — e.g., `screenshot_sqli_login_page.png`
- `finding_{number}_{title}.txt` — e.g., `finding_001_eternalblue.txt`

## Workflow

### Phase 1: Cipher Planning
1. Cipher creates directive for engagement
2. Generates SOW, ROE, scope documents
3. Plans attack methodology

### Phase 2: Joko Execution
4. Cipher delegates tactical tasks to Joko
5. Joko runs tools, collects evidence
6. Joko reports findings in structured JSON
7. All actions logged to `agent_audit_log`

### Phase 3: Cipher Analysis
8. Cipher analyzes Joko's findings
9. Scores vulnerabilities (CVSS 3.1)
10. Maps to MITRE ATT&CK
11. Generates client report

## Output Format (Joko → Cipher)

```json
{
  "engagement_id": "SKYLINE-SOC-2026-002",
  "task": "nmap scan 192.168.1.0/24",
  "status": "completed",
  "evidence": [
    "/tmp/SKYLINE-SOC-2026-002/evidence/nmap_full.txt",
    "/tmp/SKYLINE-SOC-2026-002/evidence/nmap_full.xml"
  ],
  "findings": [
    {
      "severity": "critical",
      "title": "EternalBlue (MS17-010) on SMB server",
      "description": "192.168.1.15:445 vulnerable to EternalBlue...",
      "cvss": "9.8",
      "cvss_vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      "mitre_attack": ["T1210 - Exploitation of Remote Services"],
      "affected_asset": "192.168.1.15:445",
      "reproduction_steps": ["nmap --script smb-vuln-ms17-010 192.168.1.15"],
      "evidence_file": "/tmp/SKYLINE-SOC-2026-002/evidence/eternalblue_192.168.1.15.txt"
    }
  ],
  "next_recommended_action": "Validate exploitability with safe PoC",
  "blockers": null
}
```

## Benefits

### For Engagements
- **Scalable:** Cipher delegates execution, focuses on analysis
- **Auditable:** Full trail in `agent_audit_log`
- **Consistent:** Structured findings, reproducible methodology
- **Fast:** Parallel execution, no manual orchestration

### For Product
- **Sellable:** "AI-augmented pentest" = Cipher + Joko
- **Compliant:** Audit trail for client reports
- **Extensible:** Add more specialized agents (web, mobile, cloud)

## Next Steps

1. **Full Agent SDK Integration** — Replace scaffold with real Claude Agent SDK spawning
2. **Evidence Analyzer** — Cipher tool to parse Joko's outputs
3. **Report Generator** — Auto-generate pentest reports from findings
4. **Additional Agents:**
   - **Joko-Web** — Web app pentesting specialist
   - **Joko-Cloud** — Cloud security assessment (AWS, GCP, Azure)
   - **Joko-Mobile** — iOS/Android app testing

## Status

- ✅ Database schema (agent_audit_log)
- ✅ Joko agent definition
- ✅ invoke_joko MCP tool (scaffold)
- ⏳ Full Agent SDK integration (pending)
- ⏳ Evidence analyzer (pending)
- ⏳ Report generator (pending)
