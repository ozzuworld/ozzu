// routes/mcp.js — MCP (Model Context Protocol) server for Claude Code
// Exposes directive management as native Claude Code tools
// Spec: https://modelcontextprotocol.io/specification/2025-03-26

"use strict";

module.exports = function mcpRoutes(ctx) {
  const { sendJSON, parseBody, db, log: logObj, getDirectives, saveDirectives,
          broadcastToAll, sendNotification } = ctx;
  const log = typeof logObj === "function" ? logObj : (...args) => (logObj?.bridge?.info?.(...args) || console.log(...args));

  const watchdog = (() => { try { return require("../infra/watchdog"); } catch { return null; } })();
  const recoveryEngine = (() => { try { return require("../infra/recovery-engine"); } catch { return null; } })();
  const buildVerifier = (() => { try { return require("../build-verifier"); } catch { return null; } })();
  const infraMonitor = (() => { try { return require("../infra/infra-monitor"); } catch { return null; } })();
  const { mergeWorktreeToMain, smartDeploy } = (() => {
    try { return require("../agent-spawner"); } catch { return {}; }
  })();
  const { sendPush } = require("../push-notifications");
  const { createApprovalGate } = require("../approval-gate");
  const requireMessageApproval = createApprovalGate({ db, sendPush });

  // ── Tool definitions ──

  const TOOLS = [
    {
      name: "list_directives",
      description: "List all directives with their current status. Returns id, title, status, emoji, work_summary for each.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status (completed, in_progress, approved, planning, deploy_failed, blocked). Omit for all." },
        },
      },
    },
    {
      name: "create_directive",
      description: "Create a new directive to track a code change. MUST be called before writing any code.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title describing the change" },
          description: { type: "string", description: "Detailed description of what will be done" },
          type: { type: "string", enum: ["quick", "feature"], description: "quick = fix/refactor (no approval needed), feature = new functionality (needs PIN approval)" },
          emoji: { type: "string", description: "Single emoji representing this work" },
        },
        required: ["title", "description", "type", "emoji"],
      },
    },
    {
      name: "update_directive",
      description: "Update a directive's status, working_state, or work_summary.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Directive ID (dir_XXXXX)" },
          status: { type: "string", enum: ["in_progress", "blocked", "planning", "planned"], description: "New status" },
          work_summary: { type: "string", description: "Summary of work done so far" },
          working_state: { type: "object", description: "Structured state (progress, blockers, etc.)" },
          failureReason: { type: "string", description: "Why this directive is blocked/failed" },
        },
        required: ["id"],
      },
    },
    {
      name: "merge_and_deploy",
      description: "Verify, merge branch to main, and trigger deploy. The final step after code is committed.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Directive ID" },
          branch: { type: "string", description: "Branch name to merge (e.g. cipher/dir_XXXXX)" },
        },
        required: ["id", "branch"],
      },
    },
    {
      name: "stage_ios",
      description: "STAGING tier: Trigger an iOS CI build explicitly. Use this when King Kazuma says the app is ready for iPhone. JS-only changes do NOT auto-build iOS — this is the only way to get a new IPA. Caches to artifacts/ozzu-latest.ipa.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Optional directive ID to link the build to" },
        },
      },
    },
    {
      name: "check_pipeline",
      description: "Check the health of the entire pipeline — stuck directives, failed deploys, service status.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_service_status",
      description: "Get real-time health status of all monitored services (postgres, redis, nginx, etc.).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_system_state",
      description: "Get complete live system state in one call: all service health, recovery engine state, active directives, face DB count, and pending actions.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "send_email",
      description: "Send an email. Two accounts available: 'personal' = eng.hsuarezp@gmail.com (Hebert Suarez — for formal/government/university outreach), 'ozzu' = eng.ozzu@gmail.com (Skyline Capital — for Ozzu project, suppliers, technical). Default: personal. Always CC eng.ozzu@icloud.com. Always draft first and show to King Kazuma before sending unless he says otherwise.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject line" },
          text: { type: "string", description: "Plain text body" },
          html: { type: "string", description: "HTML body (optional, for professional formatting)" },
          cc: { type: "string", description: "CC recipients (comma-separated). Always include eng.ozzu@icloud.com" },
          from_account: { type: "string", enum: ["personal", "ozzu"], description: "Which email account to send from. personal = eng.hsuarezp@gmail.com, ozzu = eng.ozzu@gmail.com. Default: personal" },
          contactId: { type: "number", description: "Link to a business contact ID" },
          directiveId: { type: "string", description: "Link to a directive ID" },
          attachments: { type: "array", description: "File attachments. Each item: { filename, path } for server files (e.g. /home/gcp/ozzu/artifacts/file.ovpn) or { filename, content } for base64 content.", items: { type: "object" } },
        },
        required: ["to", "subject", "text"],
      },
    },
    {
      name: "list_emails",
      description: "List sent emails and drafts from the business email log.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["sent", "draft"], description: "Filter by status" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
      },
    },
    {
      name: "create_venture",
      description: "Create a business venture/project on the Ventures dashboard tab. Use this for business plans, grant applications, partnerships — NOT for code changes (use create_directive for code).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Venture name" },
          description: { type: "string", description: "What this venture is about" },
          emoji: { type: "string", description: "Single emoji" },
          color: { type: "string", description: "Hex color (default #06B6D4)" },
        },
        required: ["name", "description", "emoji"],
      },
    },
    {
      name: "list_ventures",
      description: "List all business ventures/projects from the Ventures dashboard.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "add_venture_task",
      description: "Add a task to a business venture/project.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number", description: "Venture/project ID" },
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task details" },
          priority: { type: "string", enum: ["low", "medium", "high"], description: "Priority level" },
          due_date: { type: "string", description: "Due date (YYYY-MM-DD)" },
          phase: { type: "string", description: "Phase grouping label" },
        },
        required: ["project_id", "title"],
      },
    },
    {
      name: "update_venture",
      description: "Update a business venture/project's details (name, description, status, emoji, color, budget).",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "number", description: "Venture/project ID" },
          name: { type: "string", description: "New venture name" },
          description: { type: "string", description: "New description" },
          status: { type: "string", enum: ["active", "paused", "completed", "archived"], description: "Venture status" },
          emoji: { type: "string", description: "Single emoji" },
          color: { type: "string", description: "Hex color" },
          budget: { type: "number", description: "Budget amount" },
          currency: { type: "string", description: "Currency code (e.g. COP, USD)" },
        },
        required: ["project_id"],
      },
    },
    {
      name: "update_venture_task",
      description: "Update a venture task's details (title, description, status, priority, phase, due_date, notes).",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "number", description: "Task ID" },
          title: { type: "string", description: "New task title" },
          description: { type: "string", description: "New task description/details" },
          status: { type: "string", enum: ["todo", "in_progress", "done"], description: "Task status" },
          priority: { type: "string", enum: ["low", "medium", "high"], description: "Priority level" },
          phase: { type: "string", description: "Phase grouping label" },
          due_date: { type: "string", description: "Due date (YYYY-MM-DD)" },
          notes: { type: "string", description: "Additional notes" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "search_uc_docs",
      description: "Search the Cisco UC documentation knowledge base (RAG). Returns relevant troubleshooting guides, CLI commands, and procedures for CUCM, CUBE, Expressway, and other Cisco UC products. Use this when diagnosing UC issues — paste error messages, symptoms, or questions to get grounded answers from indexed documentation.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query — error message, symptom, or question (e.g. 'LDAP authentication error valid server not configured', 'phone stuck on registering', 'database replication state 4')" },
          product: { type: "string", enum: ["cucm", "cube", "expressway", "all"], description: "Filter by product. Default: all" },
          limit: { type: "number", description: "Max results (default 5, max 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_infra_state",
      description: "Get live infrastructure state. TOPOLOGY: GCP VM (bridge, postgres, redis, qdrant, nginx, face-recognition, browser) + WireGuard mesh (10.9.0.0/24) connecting kazuma-pc, orangepi5, ozzu-tab (pentest relay), Rock Pi (WG bridge 10.9.0.21). Sections: network (VPN, routes), devices (reachability/services/resources), gcp (Docker, disk, memory). Cached 60s, use refresh=true for fresh probe.",
      inputSchema: {
        type: "object",
        properties: {
          refresh: { type: "boolean", description: "Force fresh probe instead of using cache (takes ~15s)" },
          section: { type: "string", enum: ["network", "devices", "esp32", "gcp", "hub", "router", "all"], description: "Return only a specific section. Default: all" },
        },
      },
    },
    {
      name: "get_wg_state",
      description: "Get LIVE WireGuard peer state (handshake age, endpoint, transfer, up/stale/never per peer). Source: wg-state-poller.sh refreshes every 60s. Use this to answer 'is device X on VPN right now / when did it last handshake / did its public IP change' — from data, NOT from memory or a single ad-hoc `wg show`. status: up (handshake <=180s), stale (>180s), never (no handshake yet).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_device_states",
      description: "Get LIVE per-device state pushed by device heartbeats: wifi_ssid, lan_ip, public_ip (detects CGNAT rotation), wg_ip, battery, status (online/stale/offline), last_seen. This is the self-updating source of truth that replaces hand-edited infra_registry.md. Use to answer 'where is device X / what wifi / what IP'.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_device_history",
      description: "Get the transition timeline for one device (roam/drop/IP-change events) from device_state_log. Use to answer 'did the tablet roam networks / change public IP, and when'.",
      inputSchema: {
        type: "object",
        properties: {
          device_id: { type: "string", description: "Device ID, e.g. 'tablet-p610', 'dev-01'" },
          since: { type: "string", description: "Optional ISO timestamp or relative like '24h' — only events after this" },
          limit: { type: "number", description: "Max rows (default 100)" },
        },
        required: ["device_id"],
      },
    },
    {
      name: "gpu_status",
      description: "Get Vast.ai GPU instance status — running instances, SSH connection details, GPU utilization, cost. Use this to check if a GPU is available or to get SSH connection info.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "gpu_create",
      description: "Rent a new Vast.ai GPU instance. Searches for cheapest offers matching criteria and creates an instance. Returns instance ID and SSH details once ready.",
      inputSchema: {
        type: "object",
        properties: {
          gpu_model: { type: "string", description: "GPU model (e.g. RTX_3090, RTX_4090, A100). Default: RTX_3090" },
          disk_gb: { type: "number", description: "Disk space in GB. Default: 80" },
          max_cost: { type: "number", description: "Max $/hr. Default: 0.30" },
        },
      },
    },
    // send_whatsapp, read_whatsapp, request_human_takeover removed — now handled by whatsapp-mcp server (localhost:8081)
    {
      name: "list_persons",
      description: "List all known persons in Ozzu — their name, relationship, channels (WhatsApp, email, push), devices, and linked faces.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_person",
      description: "Get a specific person by name or ID. If no args given, returns King Kazuma (the owner).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Person name or nickname (partial match)" },
          id: { type: "string", description: "Person UUID" },
        },
      },
    },
    {
      name: "reach_person",
      description: "Send a message to a person through their primary channel (WhatsApp, email, or push). Cipher uses this instead of raw send_whatsapp/send_email when talking to known contacts.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Person name (partial match)" },
          id: { type: "string", description: "Person UUID" },
          message: { type: "string", description: "Message to send" },
          via: { type: "string", enum: ["whatsapp", "email", "push"], description: "Force a specific channel (optional — defaults to primary)" },
        },
        required: ["message"],
      },
    },
    {
      name: "create_person",
      description: "Register a new person in Ozzu with their contact channels.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Full name" },
          nickname: { type: "string", description: "Nickname or alias" },
          relationship: { type: "string", enum: ["trusted", "contact", "recognized", "unknown"], description: "Relationship to King Kazuma" },
          whatsapp: { type: "string", description: "WhatsApp phone number (digits only, with country code)" },
          email: { type: "string", description: "Email address" },
          notes: { type: "string", description: "Any notes about this person" },
        },
        required: ["name"],
      },
    },
    {
      name: "gpu_destroy",
      description: "Destroy/terminate a Vast.ai GPU instance to stop billing.",
      inputSchema: {
        type: "object",
        properties: {
          instance_id: { type: "number", description: "Instance ID to destroy. If omitted, destroys all running instances." },
        },
      },
    },
    {
      name: "gpu_ssh_exec",
      description: "Execute a command on the running Vast.ai GPU instance via SSH. Use for setup, monitoring, or running training jobs.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute on the GPU instance" },
          instance_id: { type: "number", description: "Instance ID. If omitted, uses the first running instance." },
        },
        required: ["command"],
      },
    },
    {
      name: "solve_captcha",
      description: "Detect and solve a CAPTCHA on the current Redroid WebView using CapSolver. Supports reCAPTCHA v2 (visible + invisible) and hCaptcha. Uses Chrome DevTools Protocol to extract sitekey, sends to CapSolver API, injects token, and triggers callback. Call this when a social media app on Redroid is blocked by a CAPTCHA.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "The page URL context (e.g. https://www.linkedin.com). Helps CapSolver solve accurately." },
        },
      },
    },
    // ── Thread tools ──
    {
      name: "list_threads",
      description: "List directive threads (topic groups). Threads group related directives by topic — use to see all work done on a subject across sessions. View 1: topic-based (default). Includes directive counts per thread.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter: active (default), archived" },
        },
      },
    },
    {
      name: "get_thread",
      description: "Get a thread with all linked directives, decisions, and summary. Use this to understand the full history of a topic before starting related work.",
      inputSchema: {
        type: "object",
        properties: {
          thread_id: { type: "string", description: "Thread ID (e.g. thread_xxx)" },
        },
        required: ["thread_id"],
      },
    },
    {
      name: "get_thread_timeline",
      description: "Get chronological timeline of ALL activity across a thread's directives. View 2: time-based — useful for debugging, understanding cause-and-effect, and tracing what happened when.",
      inputSchema: {
        type: "object",
        properties: {
          thread_id: { type: "string", description: "Thread ID" },
        },
        required: ["thread_id"],
      },
    },
    {
      name: "organize_directive",
      description: "Link a directive to a thread (or create a new thread). Call this after completing a directive to organize it. If thread_id is omitted, provide thread_name to create a new thread.",
      inputSchema: {
        type: "object",
        properties: {
          directive_id: { type: "string", description: "Directive ID to organize" },
          thread_id: { type: "string", description: "Existing thread to link to" },
          thread_name: { type: "string", description: "Name for a new thread (if thread_id not provided)" },
          thread_summary: { type: "string", description: "Summary for the new thread" },
          add_decision: { type: "string", description: "Optional: a key decision made during this directive to record on the thread" },
        },
        required: ["directive_id"],
      },
    },
    {
      name: "execute_objective",
      description: "AUTONOMOUS LOOP: Set objective, Cipher + Joko iterate autonomously until achieved or escalation needed. Only escalates to human if stuck/critical. Use this for full autonomous pentesting. Returns when objective complete or needs human input.",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "High-level objective (e.g., 'gain root access', 'compromise target', 'scan network')" },
          target: { type: "string", description: "Target IP, subnet, or hostname" },
          engagement_id: { type: "string", description: "Engagement ID (e.g., SKYLINE-SOC-2026-002)" },
          directive_id: { type: "string", description: "Directive ID this work belongs to" },
          scope: { type: "object", description: "In-scope targets and constraints" },
          max_iterations: { type: "number", description: "Max autonomous iterations before escalation (default: 20)" },
        },
        required: ["goal", "target", "engagement_id"],
      },
    },
    {
      name: "invoke_joko",
      description: "Spawn Joko execution agent for pentest task execution. Joko (Sonnet 4.5) runs tools, collects evidence, returns structured findings. Cipher delegates tactical work to Joko, then analyzes results. Returns agent session ID for tracking.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Specific task for Joko to execute (e.g., 'nmap scan 192.168.1.0/24', 'crack WPA2 handshake', 'exploit CVE-2023-XXXX')" },
          engagement_id: { type: "string", description: "Engagement identifier (e.g., SKYLINE-SOC-2026-002)" },
          directive_id: { type: "string", description: "Directive ID this work belongs to" },
          scope: { type: "object", description: "In-scope targets and constraints (subnets, IPs, prohibited targets)" },
          evidence_dir: { type: "string", description: "Optional: evidence directory path. Defaults to /tmp/{engagement_id}/evidence/" },
        },
        required: ["task", "engagement_id"],
      },
    },
    {
      name: "create_engagement",
      description: "Create a new pentest engagement with client, scope, and ROE. Returns engagement ID for tracking all work.",
      inputSchema: {
        type: "object",
        properties: {
          client_name: { type: "string", description: "Client company name" },
          engagement_type: { type: "string", enum: ["external_pentest", "internal_pentest", "webapp", "redteam", "compliance"], description: "Type of engagement" },
          scope: { type: "object", description: "Engagement scope: {targets: [], allowed: [], prohibited: [], credentials: {}}" },
          roe: { type: "object", description: "Rules of Engagement (destructive actions, time windows, etc.)" },
          start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
          end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
          lead_engineer: { type: "string", description: "Lead engineer name" },
          sow_url: { type: "string", description: "Link to Statement of Work document" },
        },
        required: ["client_name", "engagement_type", "scope"],
      },
    },
    {
      name: "list_engagements",
      description: "List all pentest engagements with status and findings count.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["scoping", "approved", "in_progress", "reporting", "completed", "billed"], description: "Filter by status" },
        },
      },
    },
    {
      name: "get_engagement",
      description: "Get full engagement details including scope, findings, and agent activity.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID (e.g., SKYLINE-SOC-2026-001)" },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "add_finding",
      description: "Record a pentest finding (vulnerability, misconfiguration, exposure). Links to engagement and provides structured data for reporting.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"], description: "Finding severity" },
          title: { type: "string", description: "Finding title (e.g., 'Exposed Admin Panel with Default Credentials')" },
          description: { type: "string", description: "Detailed finding description" },
          cvss_score: { type: "number", description: "CVSS 3.1 score (0.0-10.0)" },
          cvss_vector: { type: "string", description: "CVSS vector string" },
          affected_asset: { type: "string", description: "Affected host/service (e.g., '192.168.1.10:80')" },
          mitre_attack: { type: "array", description: "MITRE ATT&CK technique IDs" },
          reproduction: { type: "object", description: "Reproduction steps" },
          remediation: { type: "string", description: "Recommended fix" },
          evidence_files: { type: "array", description: "Paths to evidence (screenshots, logs, pcaps)" },
          refs: { type: "array", description: "Public references by ID/URL — CVE / ExploitDB / advisory (e.g. ['CVE-2024-12345','EDB-50123']). Reference only; never exploit source." },
          affected_assets: { type: "array", description: "Structured multi-asset link: [{ip, ports:[...], note}], joinable to recon_hosts. Use for findings spanning multiple hosts/ports; affected_asset (string) remains for the single-asset case." },
          informed_by: { type: "array", description: "Attack-graph edges TO this finding: array of {finding_id, edge_kind in ['evidence','implies','refutes']} or bare finding_ids. Encodes which prior findings led to this one. dir_1780781999942." },
          enables: { type: "array", description: "Attack-graph FUTURE paths: array of {hypothesis_label, ttp_hint}. What attack-paths this finding makes possible. dir_1780781999942." },
          kind: { type: "string", enum: ["confirmed", "hypothesis", "refuted"], description: "Node kind: 'confirmed' (evidence-backed finding) | 'hypothesis' (model-proposed probe, no result) | 'refuted' (probe ran, disproved). Defaults to 'confirmed'." },
        },
        required: ["engagement_id", "severity", "title", "description"],
      },
    },
    {
      name: "get_finding_graph",
      description: "Get the attack-graph rendering of an engagement's findings (confirmed + hypothesis + pending probes, with informed_by edges + open frontiers). Membrane-safe: no raw commands, payloads, or credentials. Use to inspect what the offense model sees on each iter when graph_mode_enabled is on, or to audit graph density. dir_1780781999942.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
          format: { type: "string", enum: ["json", "ascii"], description: "json = full {nodes, edges, topo_order, open_frontiers}; ascii = compact tree rendering used in the agent prompt. Default ascii." },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "list_findings",
      description: "List findings for an engagement, optionally filtered by severity.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"], description: "Filter by severity" },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "note_model_behavior",
      description: "Record a v1.4-corpus quality signal observed during this engagement: what the L3 agent did well or badly at a specific iteration, with a controlled-vocab tag and polarity. When the corpus-v1.4 build runs, these notes attach to the iteration so the trainer can filter or down-weight bad behaviors and weight up good ones. Use whenever you see the agent (a) recover from a failure with a tool pivot, (b) end the engagement prematurely, (c) hallucinate a flag/path, (d) ignore the executor caps note, (e) make a great recon decision, etc. Without these notes the corpus bakes every behavior into v1.4 equally.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
          tag: {
            type: "string",
            description: "Controlled-vocab tag describing the behavior",
            enum: [
              "tool_pivot",            // agent switched to a different tool after a failure
              "repair_flow",           // agent corrected itself reading queue history
              "false_end",             // agent called end_engagement prematurely
              "empty_decision",        // orchestrator returned no action while pending tasks existed
              "phase_confusion",       // agent misread engagement_phase (e.g. read 'reporting' as 'done')
              "tool_hallucination",    // agent used non-existent flag/path/script (e.g. nmap -e <wrong-iface>)
              "wrong_lan_assumption",  // agent reasoned from polluted/wrong-LAN findings
              "give_up_early",         // agent stopped after few attempts when more remained
              "cap_respect",           // agent honored executor_caps_note / tool list
              "good_recon",            // agent picked a tight, target-appropriate probe
              "bad_recon",             // agent picked a weak/irrelevant probe
            ],
          },
          polarity: { type: "string", enum: ["positive", "negative", "neutral"], description: "Is this behavior what v1.4 should learn (positive) or avoid (negative)?" },
          observation: { type: "string", description: "What was observed, free text — e.g. 'NSE rtsp-info failed; agent pivoted to curl + HEAD; reached real banner.'" },
          iter: { type: "number", description: "Optional: the agent iteration this was observed at" },
          queue_item_id: { type: "number", description: "Optional: the soc_queue_items.id that surfaced the behavior" },
          model_used: { type: "string", description: "Optional: model id (e.g. 'qwen3:32b', 'ozzu-soc-v1.3')" },
          suggested_fix: { type: "string", description: "Optional: how v1.4 should handle this case (free text)" },
        },
        required: ["engagement_id", "tag", "polarity", "observation"],
      },
    },
    {
      name: "list_model_behavior_notes",
      description: "List recorded model_behavior_notes for an engagement (or all engagements). Filterable by tag and polarity. Useful before training v1.4 to scan what was tagged as positive vs negative across the corpus.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Optional: filter to a specific engagement" },
          tag: { type: "string", description: "Optional: filter by tag" },
          polarity: { type: "string", enum: ["positive", "negative", "neutral"], description: "Optional: filter by polarity" },
          limit: { type: "number", description: "Max rows (default 50)" },
        },
      },
    },
    {
      name: "get_recon",
      description: "Get STRUCTURED recon hosts (ip / mac / vendor / status / open ports + service/version) for an engagement, parsed server-side from scan output. Use this INSTEAD of reading raw nmap/nc scan dumps — raw output stays in the audit log for the app and never enters context. Returns one row per discovered host.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID (e.g. SKYLINE-SOC-2026-001)" },
          status: { type: "string", description: "Optional filter by host status (e.g. 'up')" },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "spawn_sub_agent",
      description: "Spawn a per-target sub-agent for an engagement (dir_1780848098817). Coordinator (the engagement-level runAgent loop) OR operator can spawn these. Sub-agent gets isolated context: its own iter counter, mentor state, recovery state, scope override (defaults to [target_host]), and optional permission_mode override (defaults to engagement's). All queue items + findings produced by this sub-agent carry sub_agent_id. Runs the full gate stack (no bypass). Use to fan out per-target investigation: one sub-agent per IP, each focused on its target without polluting the others' context.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Parent engagement ID" },
          target_host: { type: "string", description: "IP or hostname this sub-agent owns" },
          target_role: { type: "string", description: "Semantic role: gateway | nvr | web | etc." },
          objective: { type: "string", description: "What this sub-agent should accomplish (free text, fed to its orchestrator)" },
          permission_mode_override: { type: "string", description: "Optional per-sub-agent permission_mode (default = engagement's). Valid: recon_only|enumeration|exploitation_auto|exploitation_prompt|full_engagement", enum: ["recon_only", "enumeration", "exploitation_auto", "exploitation_prompt", "full_engagement"] },
          max_iter: { type: "number", description: "Max iterations (default 20)" },
          spawned_reason: { type: "string", description: "Why this sub-agent was spawned (for audit)" },
        },
        required: ["engagement_id", "target_host"],
      },
    },
    {
      name: "list_sub_agents",
      description: "List all sub-agents for an engagement (dir_1780848098817). Shows status, iter progress, target_host, target_role, total_findings, last_action.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "terminate_sub_agent",
      description: "Terminate a running sub-agent by id (dir_1780848098817). Sub-agent's next iter check exits early; queue items already in flight finish but no new ones are queued.",
      inputSchema: {
        type: "object",
        properties: {
          sub_agent_id: { type: "number", description: "Sub-agent id from list_sub_agents" },
          reason: { type: "string", description: "Audit reason for termination" },
        },
        required: ["sub_agent_id"],
      },
    },
    {
      name: "validate_engagement_scope",
      description: "Validate an engagement's scope.targets — classify each target as IPv4, CIDR, hostname, or free-text. Surfaces warnings when scope is free-text only (which makes workspace_jail block every dispatch). Use to debug 'why does every command get blocked' on an engagement (dir_1780846961338).",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "trace_dispatch",
      description: "Dry-run a hypothetical command through every gate layer of the SOC pipeline WITHOUT executing it (dir_1780846511537). Returns a layered verdict report showing which gate would block (if any) and why. Layers in dispatch order: roe_blocklist → permission_mode → workspace_jail → command_tokens (anti-spoof) → preflight_lint → hooks_pre_queue (registered hooks listed but NOT executed) → auto_verify_cve (NVD lookup) → auto_verify_nse (catalog lookup) → sploitus_enrichment (informational). Use to debug why the model's queued commands keep getting denied, or to verify a new command shape is allowed before queueing it through the model.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
          command: { type: "string", description: "Shell command to trace (string, not executed)" },
          intent_class: { type: "string", description: "Declared intent_class to assume (default 'recon'). One of: recon, enumeration, exploit_test, exploit_rce, post_exploit", enum: ["recon", "enumeration", "exploit_test", "exploit_rce", "post_exploit"] },
        },
        required: ["engagement_id", "command"],
      },
    },
    {
      name: "register_engagement_cron",
      description: "Schedule a recurring task for an engagement (dir_1780846234615). Schedule is a 5-field cron expression (minute hour day month weekday — UTC). Examples: '*/15 * * * *' = every 15 minutes, '0 */2 * * *' = every 2 hours on the hour, '0 0 * * *' = daily at midnight. When the schedule matches, the prompt is queued as a SOC queue item with the declared intent_class, then runs through the full gate stack (ROE → permission_mode → workspace_jail → command_tokens → preflight → hooks → auto-verify) just like a model-generated step. Use for: hourly re-recon, daily cred re-verification, periodic finding staleness checks.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
          schedule: { type: "string", description: "5-field cron expression (UTC). E.g. '0 */2 * * *' = every 2 hours." },
          prompt: { type: "string", description: "Shell command to queue when the schedule matches" },
          intent_class: { type: "string", description: "Declared intent (recon | enumeration | exploit_test | exploit_rce | post_exploit). Default 'recon'.", enum: ["recon", "enumeration", "exploit_test", "exploit_rce", "post_exploit"] },
          description: { type: "string", description: "Human-readable description of what this cron does" },
        },
        required: ["engagement_id", "schedule", "prompt"],
      },
    },
    {
      name: "list_engagement_crons",
      description: "List all scheduled crons for an engagement (or all engagements if engagement_id is null). Shows id, schedule, prompt, intent_class, enabled, last_run_at, next_run_at, run_count.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID, or omit to list ALL crons across all engagements" },
        },
      },
    },
    {
      name: "delete_engagement_cron",
      description: "Permanently delete a scheduled cron by id. To temporarily disable, prefer toggling enabled flag via direct DB (or via future MCP tool).",
      inputSchema: {
        type: "object",
        properties: {
          cron_id: { type: "number", description: "Cron id from list_engagement_crons" },
        },
        required: ["cron_id"],
      },
    },
    {
      name: "register_engagement_hook",
      description: "Register an operator-configured shell hook on engagement queue events (dir_1780845861190). Hook command receives JSON event payload on stdin and may return JSON on stdout {allow, deny_reason, messages}. Events: pre_queue_dispatch (blocks dispatch if allow=false), post_queue_complete (advisory, e.g. push webhook on failure), pre_finding_write, post_phase_advance. Pass engagement_id=null for a GLOBAL hook that fires on every engagement. Hook receives env vars HOOK_EVENT and HOOK_ID. Timeout in milliseconds (default 10000) — on timeout, hook is treated as ALLOW (fail-open).",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID to scope this hook to, or null/empty for global" },
          event: { type: "string", description: "Hook event", enum: ["pre_queue_dispatch", "post_queue_complete", "pre_finding_write", "post_phase_advance"] },
          command: { type: "string", description: "Shell command to run (passed to sh -c). Will receive JSON event data on stdin." },
          timeout_ms: { type: "number", description: "Timeout in milliseconds (default 10000)" },
        },
        required: ["event", "command"],
      },
    },
    {
      name: "list_engagement_hooks",
      description: "List all hooks registered for an engagement (plus global hooks). Returns id, event, command preview, enabled state, fire counter, last_fired_at, last_outcome.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID. Global hooks (engagement_id=null) are always included." },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "list_recovery_state",
      description: "Read the engagement's recovery state — typed failure scenarios detected, per-scenario attempt counters, escalation status (dir_1780845298918). Use to diagnose WHY an engagement is paused or stalling. Returns {paused, recovery_state: {[scenario]: {attempts, last_attempt_at, last_evidence, escalated}}}. Scenarios: executor_offline, cve_fabrication_streak, nse_fabrication_streak, target_unreachable, parse_failure_repeat, permission_streak, model_loop.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "set_engagement_permission_mode",
      description: "Set the engagement's permission mode (claw-analog style, dir_1780844590951). Modes from least → most privileged: recon_only · enumeration · exploitation_auto · exploitation_prompt · full_engagement. The mode gates intent_class on every auto-executed queue item: recon_only blocks all enumeration+exploit, enumeration blocks all exploit, exploitation_auto allows exploit_test but blocks RCE/post-exploit, full_engagement allows everything. Use to escalate or de-escalate mid-engagement (e.g. after reviewing recon → enable exploitation_auto). Returns previous + new mode.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
          mode: { type: "string", description: "One of: recon_only, enumeration, exploitation_auto, exploitation_prompt, full_engagement", enum: ["recon_only", "enumeration", "exploitation_auto", "exploitation_prompt", "full_engagement"] },
          reason: { type: "string", description: "Audit reason for the mode change (logged as telemetry)" },
        },
        required: ["engagement_id", "mode"],
      },
    },
    {
      name: "advance_offense",
      description: "Advance an AUTHORIZED engagement by ONE offensive step. The self-hosted offense model (L3) reads the structured findings server-side, synthesizes the next in-scope step, and queues it for the PA to execute. Returns ONLY a sanitized confirmation — the offensive command/rationale/refs stay server-side and are NOT surfaced to you (membrane). Use this INSTEAD of reasoning about specific creds/exploits yourself.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
          intent: { type: "string", description: "High-level objective for this step (optional, e.g. 'gain access to the target service')" },
          model_override: { type: "string", description: "Optional ollama/vLLM model tag to use for THIS call only (e.g. 'qwen3:32b' or 'deepseek-r1:32b'). Used for in-harness benchmarking; the resulting queue item's title is prefixed with [<model_tag>] so the operator can attribute it. If omitted, OFFENSE_MODEL_NAME env is used." },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "start_offense_model",
      description: "One-click bring-up of the L3 offense model on vast.ai. Reuses any already-running instance, or rents one. Attaches the bridge SSH key, installs Ollama (loopback bind, 16K ctx), and kicks off the model pull on the remote in BACKGROUND. Returns IMMEDIATELY with provisioning status — does NOT block on the pull. Follow with wait_offense_model to block until the model is loaded and open the bridge tunnel. Returns only sanitized status — no offensive content.",
      inputSchema: {
        type: "object",
        properties: {
          model: { type: "string", description: "Ollama model tag. Defaults to OFFENSE_MODEL_NAME env (deepseek-r1:32b is the 2026-06-04 validated pick)." },
          gpu_model: { type: "string", description: "vast.ai GPU model name (default 'RTX_4090')." },
          max_cost: { type: "number", description: "Max $/hr (default 0.50)." },
          disk_gb: { type: "number", description: "Disk in GB (default 60 — enough for one 32B Q4 model plus headroom)." },
        },
      },
    },
    {
      name: "wait_offense_model",
      description: "Block until the L3 offense model is pulled and registers in ollama list on the remote, then open the SSH tunnel from bridge to instance:11434 and verify /api/tags is reachable. After this returns successfully, advance_offense calls work. Call this after start_offense_model. Default timeout 900s (15 min) — the pull is the long pole.",
      inputSchema: {
        type: "object",
        properties: {
          timeout_sec: { type: "number", description: "Max seconds to wait for the model to register + tunnel to come up (default 900)." },
        },
      },
    },
    {
      name: "stop_offense_model",
      description: "Tear down the L3 offense model: close the bridge SSH tunnel and DESTROY all running vast.ai instances to stop billing. Call this at engagement end (or after a benchmark) — leaving the instance up burns money.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "probe_executor",
      description: "Probe an engagement's executor for actually-installed tools (replaces the seeded executor_tools list with ground truth). Runs a non-offensive `command -v <tool>` discovery loop over ~40 candidates via the same local execution path as queue items, then writes the installed list back to pentest_engagements.executor_tools so future advance_offense calls only see real tools. Idempotent: skips if probed_at is < 24h old unless force:true. Call once per engagement before the first advance_offense, or after installing new tools on the executor. Returns added/removed diff for visibility.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
          force: { type: "boolean", description: "Re-probe even if last probe is < 24h old (default false)" },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "start_engagement_run",
      description: "Step 5 of OFFENSE-AGENT-DESIGN.md — kick off the autonomous L3 agent loop on an engagement. The agent on the GPU calls tools (get_engagement_state, queue_step, wait_for_outcome, probe_executor, advance_phase, end_engagement) via Ollama function-calling, queues steps for the PA, waits for outcomes, and iterates. Hard iteration cap so the call stays bounded (default 15 model invocations, ~10–25 min real time). Conversation transcript persists in pentest_engagements.agent_run_state so re-calling resumes from where it stopped. Returns only sanitized summary — raw commands stay server-side (membrane).",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id:   { type: "string", description: "Engagement ID" },
          max_iter:        { type: "number", description: "Max model invocations this run (default 15). Each is ~30–180s with thinking enabled." },
          intent:          { type: "string", description: "Optional operator intent passed to the agent as guidance (e.g. 'enumerate IoT footprint first')." },
          model_override:  { type: "string", description: "Optional model tag override for this run (e.g. 'qwen3:32b' to A/B vs deepseek)." },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "reset_agent_run",
      description: "Reset the L3 agent's conversation transcript AND task graph for an engagement back to empty (agent_run_state = {}, agent_status = idle, engagement_tasks rows deleted). Use when scope changed materially or the prior run derailed. Does NOT delete queue items or findings.",
      inputSchema: {
        type: "object",
        properties: { engagement_id: { type: "string", description: "Engagement ID" } },
        required: ["engagement_id"],
      },
    },
    {
      name: "get_task_graph",
      description: "Read-only view of the L3 agent's current Task Coordination Graph for an engagement (Step 8 of OFFENSE-AGENT-DESIGN.md). Returns the DAG of engagement_tasks the Orchestrator built — each task's directive, phase, status, parent_ids, queue_item_id link, outcome_summary. Use this to see WHAT the agent is planning vs. what it has executed.",
      inputSchema: {
        type: "object",
        properties: { engagement_id: { type: "string", description: "Engagement ID" } },
        required: ["engagement_id"],
      },
    },
    {
      name: "get_behavioral_scorecard",
      description: "Per-engagement behavioral health snapshot. Returns ONLY numbers, enums, and booleans — never command text, IPs, CVE IDs, tool names, or finding descriptions. Membrane-safe by design. Fields: concluded, conclude_reason, total_steps, phase_progression (phase/steps/wall_seconds), step_queued_rate, step_queued_breakdown (infra_hang/prose_only/lint_reject/other), loop_breaker_fires, watchdog_timeouts, inference_hung, permission_denied (count + by_rule counts), claim_verify (fired/passed/failed/gated_a_finding), findings_by_severity, false_positive (severity enum / model_claimed / ground_truth_holds / harness_caught_it / mechanism enum), membrane_breach, orphaned_tasks.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "number", description: "Engagement ID (integer)" },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "get_offense_telemetry",
      description: "Read-only audit surface for the L3 offense pipeline. Returns AGGREGATES over advance_offense calls (per-model latency / step-queued% / avg refs / in-scope%, per-intent stats, outcome distribution, latency percentiles) plus a flat list of recent rows. MEMBRANE-SAFE: never includes raw commands or rationales — only shape, timing, and outcome metadata. Use this to spot harness gaps and drive the harness-improvement loop.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Filter to a specific engagement (optional)" },
          model: { type: "string", description: "Filter to a specific model_used (optional, e.g. 'deepseek-r1:32b')" },
          since: { type: "string", description: "ISO timestamp filter (default: 30 days ago)" },
          limit: { type: "number", description: "Max rows in the recent-rows table (default 50, max 500)" },
        },
      },
    },
    {
      name: "analyze_engagement_telemetry",
      description: "Diagnose the health of a live L3 multi-agent engagement run. Reads offense_telemetry + engagement_tasks + soc_queue_items for the given engagement_id and surfaces actionable problems: orchestrator loops (same intent ≥3× consecutively), executor dead (consecutive empty queue outputs), low step_queued rate (model can't tool-use), membrane breach (sanitization failed — HARD error), stalled tasks (unblocked + pending too long). MEMBRANE-SAFE: returns issue kinds + counts + row IDs, never the offending text. Use during live runs to spot agent dysfunction immediately.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement to analyze (e.g. SKYLINE-SOC-2026-628)" },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "diagnose_all_engagements",
      description: "Fleet-wide health check — runs analyze_engagement_telemetry over every active engagement (status='in_progress' OR agent_status in {running, error, halted}) and returns a summary table + detail for engagements with issues. Use to find which engagements need attention without per-id polling. Membrane-safe (same as per-engagement analyzer).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "audit_membrane",
      description: "Historical fleet-wide audit — scans the ENTIRE offense_telemetry table for any rows where text fields (intent_category, outcome_notes, error_message) contain membrane-breach patterns: raw CVE IDs, IPs, exploit keywords (nmap/sqlmap/etc), or credential file refs (passwd/shadow). Either confirms 'membrane intact' (the L3→L4 contract has held historically) OR pinpoints the leaking rows. Sample output shows row IDs + breach kind WITHOUT revealing the offending text — preserves the membrane even in the audit itself.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "string", description: "ISO timestamp — only audit rows from this date onward (default: all time)" },
        },
      },
    },
    {
      name: "soc_queue_steps",
      description: "Push one or more orchestration steps to the SOC app for a pentest engagement. Prefer the atomic single-item form (`item:{...}`) — call once per step. `items:[...]` array form is still accepted for batches. PA engineer runs each step from the app; output streams back and is visible to Cipher in the same session. Each step is a single shell command executed locally on the bridge (lab reached via wg0). By default, existing pending items are replaced on the first call of a batch — set replace_pending:false for subsequent calls in the same batch.",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID (e.g. SKYLINE-SOC-2026-001)" },
          item: {
            type: "object",
            description: "Single step (atomic form — preferred). Exactly one of `item` or `items` must be provided.",
            properties: {
              title: { type: "string", description: "Short human-readable title (e.g. 'Kernel fingerprint capture')" },
              description: { type: "string", description: "Why this step, what it produces" },
              command: { type: "string", description: "Shell command to run locally on the bridge" },
              expected_artifact: { type: "string", description: "Expected evidence file path or summary" },
            },
            required: ["title", "command"],
          },
          items: {
            type: "array",
            description: "Ordered list of steps (batch form). Exactly one of `item` or `items` must be provided.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Short human-readable title (e.g. 'Kernel fingerprint capture')" },
                description: { type: "string", description: "Why this step, what it produces" },
                command: { type: "string", description: "Shell command to run locally on the bridge" },
                expected_artifact: { type: "string", description: "Expected evidence file path or summary" },
              },
              required: ["title", "command"],
            },
          },
          replace_pending: { type: "boolean", description: "Replace existing pending items (default true). Set false when appending follow-up items in a multi-call batch." },
        },
        required: ["engagement_id"],
      },
    },
    {
      name: "soc_get_queue",
      description: "Get the current queue of SOC steps for an engagement (pending + in-flight + completed).",
      inputSchema: {
        type: "object",
        properties: {
          engagement_id: { type: "string", description: "Engagement ID" },
        },
        required: ["engagement_id"],
      },
    },
  ];

  // ── Tool handlers ──

  async function handleTool(name, args) {
    switch (name) {
      case "list_directives": {
        const directives = getDirectives();
        let filtered = directives;
        if (args.status) {
          filtered = directives.filter(d => d.status === args.status);
        }
        const summary = filtered.map(d => ({
          id: d.id, title: d.title, status: d.status, emoji: d.emoji, type: d.type,
          work_summary: d.work_summary || null,
          failureReason: d.failureReason || null,
          createdAt: d.createdAt,
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      case "create_directive": {
        const id = `dir_${Date.now()}`;
        const directive = {
          id, type: args.type, title: args.title, description: args.description,
          emoji: args.emoji, status: args.type === "quick" ? "in_progress" : "pending",
          plan: null, directiveApprovalId: null, retryCount: 0, failureReason: null,
          priority: 3, dependsOn: null, epicId: null, phaseOrder: null,
          createdBy: "cipher", working_state: null, work_summary: null, handoff_context: null,
          activity_log: [{ timestamp: Date.now(), type: "status_change", actor: "cipher", message: `Directive created with status: ${args.type === "quick" ? "in_progress" : "pending"}` }],
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        if (args.type === "quick") {
          directive.startedAt = Date.now();
        }
        const directives = getDirectives();
        directives.push(directive);
        saveDirectives(directives);
        try { await db.saveDirective(directive); } catch {}
        return { content: [{ type: "text", text: `Created directive ${id} (${args.type}): ${args.title}\nStatus: ${directive.status}\nBranch: cipher/${id}` }] };
      }

      case "update_directive": {
        const directives = getDirectives();
        const d = directives.find(dd => dd.id === args.id);
        if (!d) return { content: [{ type: "text", text: `Error: directive ${args.id} not found` }], isError: true };
        if (args.status) {
          const prev = d.status;
          d.status = args.status;
          d.activity_log = d.activity_log || [];
          d.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "Cipher", message: `Status changed from ${prev} to ${args.status}` });
          if (args.status === "in_progress" && !d.startedAt) d.startedAt = Date.now();
        }
        if (args.work_summary) d.work_summary = args.work_summary;
        if (args.working_state) d.working_state = args.working_state;
        if (args.failureReason) d.failureReason = args.failureReason;
        d.updatedAt = Date.now();
        d.lastActivity = Date.now();
        saveDirectives(directives);
        try { await db.saveDirective(d); } catch {}
        return { content: [{ type: "text", text: `Updated ${args.id}: status=${d.status}` }] };
      }

      case "merge_and_deploy": {
        const directives = getDirectives();
        const d = directives.find(dd => dd.id === args.id);
        if (!d) return { content: [{ type: "text", text: `Error: directive ${args.id} not found` }], isError: true };
        if (d.status !== "in_progress") {
          return { content: [{ type: "text", text: `Error: directive must be in_progress (currently ${d.status})` }], isError: true };
        }

        // Verify
        let verifyResult = { success: true };
        if (buildVerifier) {
          try {
            verifyResult = await buildVerifier.verify(d);
          } catch (err) {
            return { content: [{ type: "text", text: `Verification error: ${err.message}` }], isError: true };
          }
        }
        if (!verifyResult.success) {
          return { content: [{ type: "text", text: `Verification FAILED: ${verifyResult.failure_reason || "unknown"}\n${(verifyResult.verification_log || []).join("\n")}` }], isError: true };
        }

        // Merge
        let mergeOk = false;
        if (mergeWorktreeToMain) {
          mergeOk = mergeWorktreeToMain(args.id, args.branch);
        }
        if (!mergeOk) {
          d.status = "deploy_failed";
          d.failureReason = `Merge failed for branch ${args.branch}`;
          d.mergeBranch = args.branch;
          saveDirectives(directives);
          // Alert
          if (typeof broadcastToAll === "function") {
            broadcastToAll({ type: "opsAlert", service: "pipeline", status: "deploy_failed", severity: "high", ts: new Date().toISOString(), details: { directive: args.id, branch: args.branch } });
          }
          return { content: [{ type: "text", text: `Merge FAILED for ${args.branch}. Directive set to deploy_failed. Check git state.` }], isError: true };
        }

        // Success
        d.status = "completed";
        d.completedAt = Date.now();
        d.duration = d.startedAt ? Date.now() - d.startedAt : null;
        d.verification_result = verifyResult;
        d.activity_log.push({ timestamp: Date.now(), type: "merged", actor: "Cipher", message: `Branch ${args.branch} merged to main` });
        d.activity_log.push({ timestamp: Date.now(), type: "status_change", actor: "Cipher", message: "Status changed from in_progress to completed" });
        saveDirectives(directives);
        try { await db.saveDirective(d); } catch {}

        // Deploy (async)
        if (smartDeploy) {
          try { smartDeploy(d); } catch {}
        }

        return { content: [{ type: "text", text: `✓ Merged ${args.branch} → main. Directive ${args.id} completed. Deploy triggered.` }] };
      }

      case "stage_ios": {
        const { stageIos } = require("../agent-spawner");
        if (!stageIos) {
          return { content: [{ type: "text", text: "Error: stageIos not available" }], isError: true };
        }
        const directive = args.id ? getDirectives().find(d => d.id === args.id) : null;
        stageIos(directive);
        return { content: [{ type: "text", text: "✓ iOS STAGING build triggered. IPA will be cached to artifacts/ozzu-latest.ipa in ~10 minutes." }] };
      }

      case "check_pipeline": {
        const directives = getDirectives();
        const stuck = directives.filter(d => ["deploy_failed", "blocked", "stale"].includes(d.status));
        const inProgress = directives.filter(d => d.status === "in_progress");
        const pending = directives.filter(d => ["pending", "planning", "planned", "approved"].includes(d.status));
        const completed = directives.filter(d => d.status === "completed");

        let report = `Pipeline Health Report\n${"─".repeat(40)}\n`;
        report += `Completed: ${completed.length} | Active: ${inProgress.length} | Pending: ${pending.length} | Problems: ${stuck.length}\n\n`;

        if (stuck.length > 0) {
          report += `⚠️  PROBLEMS:\n`;
          for (const d of stuck) {
            report += `  ${d.emoji} ${d.id} [${d.status}] ${d.title}\n`;
            if (d.failureReason) report += `    Reason: ${d.failureReason}\n`;
          }
          report += "\n";
        }
        if (inProgress.length > 0) {
          report += `🔄 IN PROGRESS:\n`;
          for (const d of inProgress) {
            report += `  ${d.emoji} ${d.id} ${d.title}\n`;
          }
          report += "\n";
        }
        if (pending.length > 0) {
          report += `⏸️  PENDING:\n`;
          for (const d of pending) {
            report += `  ${d.emoji} ${d.id} [${d.status}] ${d.title}\n`;
          }
        }

        // Service health
        if (watchdog) {
          const status = watchdog.getStatus();
          const down = Object.entries(status).filter(([, s]) => s.status === "down");
          if (down.length > 0) {
            report += `\n🔴 SERVICES DOWN: ${down.map(([n]) => n).join(", ")}`;
          }
        }

        return { content: [{ type: "text", text: report }] };
      }

      case "get_service_status": {
        if (!watchdog) return { content: [{ type: "text", text: "Watchdog not available" }], isError: true };
        const status = watchdog.getStatus();
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      }

      case "get_system_state": {
        const state = {};

        // Service health from watchdog
        if (watchdog) {
          state.services = watchdog.getStatus();
        }

        // Recovery engine state
        if (recoveryEngine) {
          state.recovery = recoveryEngine.getState();
        }

        // Active directives
        const directives = getDirectives();
        state.directives = {
          active: directives.filter(d => !["completed", "archived"].includes(d.status)).map(d => ({
            id: d.id, title: d.title, status: d.status, emoji: d.emoji, type: d.type,
          })),
          counts: {
            total: directives.length,
            inProgress: directives.filter(d => d.status === "in_progress").length,
            pending: directives.filter(d => ["pending", "planning", "planned", "approved"].includes(d.status)).length,
            problems: directives.filter(d => ["deploy_failed", "blocked"].includes(d.status)).length,
          },
        };

        // Face DB count (live Qdrant query)
        try {
          const qdrantRes = await new Promise((resolve) => {
            const req = require("http").get("http://127.0.0.1:6333/collections/faces", { timeout: 3000 }, (res) => {
              let d = ""; res.on("data", c => d += c);
              res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
            });
            req.on("error", () => resolve(null));
            req.on("timeout", () => { req.destroy(); resolve(null); });
          });
          state.faceDb = {
            count: qdrantRes?.result?.points_count ?? null,
            vectors: qdrantRes?.result?.vectors_count ?? null,
            status: qdrantRes?.result?.status ?? "unknown",
          };
        } catch {
          state.faceDb = { count: null, status: "unreachable" };
        }

        // Pending action queue
        try {
          const aq = require("../action-queue");
          state.actionQueue = aq.list ? aq.list() : [];
        } catch {
          state.actionQueue = [];
        }

        return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
      }

      case "send_email": {
        const http = require("http");
        // FaceID approval gate
        const emailApproval = await requireMessageApproval(
          "send_email",
          `Email to ${args.to}: "${args.subject}"`,
          { to: args.to, subject: args.subject, from_account: args.from_account || "personal" }
        );
        if (emailApproval.error) return { content: [{ type: "text", text: emailApproval.error }], isError: true };

        const payload = JSON.stringify({
          to: args.to, subject: args.subject, text: args.text,
          html: args.html, cc: args.cc, from_account: args.from_account || "personal",
          contactId: args.contactId, directiveId: args.directiveId,
          attachments: args.attachments || undefined,
        });
        const result = await new Promise((resolve) => {
          const req = http.request({ hostname: "localhost", port: 3333, path: "/business/email/send", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } }); });
          req.on("error", e => resolve({ error: e.message }));
          req.write(payload); req.end();
        });
        if (result.error) return { content: [{ type: "text", text: `Email send failed: ${result.error}` }], isError: true };
        const acctUsed = args.from_account || "personal";
        const attachNote = args.attachments?.length ? ` Attachments: ${args.attachments.map(a => a.filename || a.path).join(", ")}.` : "";
        return { content: [{ type: "text", text: `Email sent via ${acctUsed} account to ${args.to}. Subject: "${args.subject}".${attachNote} MessageId: ${result.messageId}` }] };
      }

      case "list_emails": {
        const qs = new URLSearchParams();
        if (args.status) qs.set("status", args.status);
        qs.set("limit", String(args.limit || 20));
        const result = await new Promise((resolve) => {
          const http = require("http");
          http.get(`http://localhost:3333/business/emails?${qs}`, (res) => {
            let d = ""; res.on("data", c => d += c);
            res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
          }).on("error", e => resolve({ error: e.message }));
        });
        if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        const summary = (result.emails || []).map(e => ({
          id: e.id, to: e.to_addr, subject: e.subject, status: e.status,
          sent_at: e.sent_at, created_at: e.created_at,
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      // send_whatsapp, read_whatsapp, request_human_takeover — removed, now handled by whatsapp-mcp server

      case "create_venture": {
        const http = require("http");
        const payload = JSON.stringify({
          name: args.name, description: args.description,
          emoji: args.emoji, color: args.color || "#06B6D4",
        });
        const result = await new Promise((resolve) => {
          const req = http.request({ hostname: "localhost", port: 3333, path: "/business/projects", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } }); });
          req.on("error", e => resolve({ error: e.message }));
          req.write(payload); req.end();
        });
        if (result.error) return { content: [{ type: "text", text: `Failed to create venture: ${result.error}` }], isError: true };
        const p = result.project;
        return { content: [{ type: "text", text: `Created venture #${p.id}: ${p.emoji} ${p.name}\nStatus: ${p.status}` }] };
      }

      case "list_ventures": {
        const http = require("http");
        const result = await new Promise((resolve) => {
          http.get("http://localhost:3333/business/projects", (res) => {
            let d = ""; res.on("data", c => d += c);
            res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
          }).on("error", e => resolve({ error: e.message }));
        });
        if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
        const projects = Array.isArray(result) ? result : (result.projects || []);
        const summary = projects.map(p => ({
          id: p.id, name: p.name, emoji: p.emoji, status: p.status,
          tasks: p.task_count, done: p.done_count, in_progress: p.in_progress_count,
        }));
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      case "add_venture_task": {
        const http = require("http");
        const payload = JSON.stringify({
          title: args.title, description: args.description || "",
          priority: args.priority || "medium", due_date: args.due_date,
          phase: args.phase,
        });
        const result = await new Promise((resolve) => {
          const req = http.request({ hostname: "localhost", port: 3333, path: `/business/projects/${args.project_id}/tasks`, method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } }); });
          req.on("error", e => resolve({ error: e.message }));
          req.write(payload); req.end();
        });
        if (result.error) return { content: [{ type: "text", text: `Failed: ${result.error}` }], isError: true };
        const t = result.task;
        return { content: [{ type: "text", text: `Added task #${t.id} to venture #${args.project_id}: "${t.title}" [${t.priority}]${t.due_date ? ` due ${t.due_date.slice(0,10)}` : ""}` }] };
      }

      case "update_venture": {
        const http = require("http");
        const { project_id, ...updates } = args;
        const payload = JSON.stringify(updates);
        const result = await new Promise((resolve) => {
          const req = http.request({ hostname: "localhost", port: 3333, path: `/business/projects/${project_id}`, method: "PATCH",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } }); });
          req.on("error", e => resolve({ error: e.message }));
          req.write(payload); req.end();
        });
        if (result.error) return { content: [{ type: "text", text: `Failed to update venture: ${result.error}` }], isError: true };
        const p = result.project;
        return { content: [{ type: "text", text: `Updated venture #${p.id}: ${p.emoji} ${p.name} [${p.status}]` }] };
      }

      case "update_venture_task": {
        const http = require("http");
        const { task_id, ...updates } = args;
        const payload = JSON.stringify(updates);
        const result = await new Promise((resolve) => {
          const req = http.request({ hostname: "localhost", port: 3333, path: `/business/tasks/${task_id}`, method: "PATCH",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } }); });
          req.on("error", e => resolve({ error: e.message }));
          req.write(payload); req.end();
        });
        if (result.error) return { content: [{ type: "text", text: `Failed to update task: ${result.error}` }], isError: true };
        const t = result.task;
        return { content: [{ type: "text", text: `Updated task #${t.id}: "${t.title}" [${t.status}] ${t.priority}${t.due_date ? ` due ${t.due_date.toString().slice(0,10)}` : ""}` }] };
      }

      case "search_uc_docs": {
        const http = require("http");
        const limit = Math.min(args.limit || 5, 10);
        const product = args.product || "all";

        try {
          // Get embedding from sentence-transformers running on host via a simple HTTP call to Qdrant's built-in search
          // We'll use Qdrant's recommend/discover API or call the embedding service
          // Since we can't run Python inside Docker, call the host's embedding + search endpoint

          // Step 1: Get embedding by calling a lightweight HTTP endpoint on the host
          // We expose a tiny Flask/FastAPI on the host for this, OR we use the Qdrant text search
          // For now: call the search.py as an HTTP service on the host

          const qdrantHost = "host.docker.internal";
          const hostIp = "172.17.0.1"; // Docker bridge gateway to host

          // Call the search script via a simple HTTP wrapper on the host
          const searchUrl = `http://${hostIp}:8765/search`;
          const payload = JSON.stringify({ query: args.query, product: product === "all" ? null : product, limit });
          const result = await new Promise((resolve, reject) => {
            const req = http.request(searchUrl, {
              method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 15000,
            }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } }); });
            req.on("error", e => resolve({ error: e.message }));
            req.on("timeout", () => { req.destroy(); resolve({ error: "Search timed out" }); });
            req.write(payload); req.end();
          });

          if (result.error) {
            return { content: [{ type: "text", text: `RAG search error: ${result.error}` }], isError: true };
          }

          const results = result.results || result;
          if (!Array.isArray(results) || results.length === 0) {
            return { content: [{ type: "text", text: `No results found for: "${args.query}"\n\nAvailable topics: LDAP, certificates, replication, services, phone registration.` }] };
          }

          let text = `Found ${results.length} relevant doc sections for: "${args.query}"\n${"─".repeat(60)}\n\n`;
          for (const r of results) {
            text += `### ${r.title} (relevance: ${(r.score * 100).toFixed(0)}%)\n`;
            text += `Source: ${r.source} | Product: ${r.product}\n\n`;
            text += `${r.text}\n\n${"─".repeat(60)}\n\n`;
          }
          return { content: [{ type: "text", text }] };
        } catch (err) {
          return { content: [{ type: "text", text: `RAG search error: ${err.message}` }], isError: true };
        }
      }

      case "get_infra_state": {
        if (!infraMonitor) return { content: [{ type: "text", text: "Infra monitor not available" }], isError: true };
        const state = args.refresh ? await infraMonitor.refresh() : infraMonitor.getState();
        if (!state) return { content: [{ type: "text", text: "No infra state available yet" }], isError: true };

        if (args.section && args.section !== "all") {
          const sectionMap = {
            network: state.network,
            devices: state.devices,
            esp32: state.esp32Nodes,
            gcp: state.gcp,
            hub: state.positioningHub,
            router: state.router,
          };
          const section = sectionMap[args.section];
          if (!section) return { content: [{ type: "text", text: `Unknown section: ${args.section}` }], isError: true };
          return { content: [{ type: "text", text: JSON.stringify({ timestamp: state.timestamp, [args.section]: section }, null, 2) }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
      }

      case "get_wg_state": {
        // Absolute path — the file is bind-mounted; __dirname-relative resolves wrong in /app.
        try {
          const raw = require("fs").readFileSync("/home/gcp/ozzu/data/infra/wg-state.json", "utf8");
          const data = JSON.parse(raw);
          const nowS = Math.floor(Date.now() / 1000);
          const fileAgeS = data.generated_at ? nowS - data.generated_at : null;
          const out = {
            interface: data.interface || "wg0",
            generated_at: data.generated_at || null,
            file_age_s: fileAgeS,
            poller_fresh: fileAgeS !== null && fileAgeS <= 150,
            peer_count: (data.peers || []).length,
            peers: data.peers || [],
          };
          return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
        } catch (e) {
          return { content: [{ type: "text", text: `wg state not available yet (${e.code || e.message}). The wg-state-poller systemd timer writes it every 60s.` }], isError: true };
        }
      }

      case "get_device_states": {
        if (!db || !db.isConnected || !db.isConnected()) return { content: [{ type: "text", text: "Database not available" }], isError: true };
        try {
          const rows = await db.getDeviceStates();
          return { content: [{ type: "text", text: JSON.stringify({ count: rows.length, devices: rows }, null, 2) }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Query failed: ${e.message}` }], isError: true };
        }
      }

      case "get_device_history": {
        if (!db || !db.isConnected || !db.isConnected()) return { content: [{ type: "text", text: "Database not available" }], isError: true };
        if (!args.device_id) return { content: [{ type: "text", text: "device_id is required" }], isError: true };
        try {
          let since = null;
          if (args.since) {
            const m = /^(\d+)\s*([hd])$/.exec(String(args.since).trim());
            if (m) {
              const hrs = m[2] === "d" ? Number(m[1]) * 24 : Number(m[1]);
              since = new Date(Date.now() - hrs * 3600 * 1000).toISOString();
            } else {
              since = args.since; // assume ISO
            }
          }
          const rows = await db.getDeviceHistory(args.device_id, { since, limit: args.limit || 100 });
          return { content: [{ type: "text", text: JSON.stringify({ device_id: args.device_id, since: since || null, count: rows.length, history: rows }, null, 2) }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Query failed: ${e.message}` }], isError: true };
        }
      }

      case "gpu_status": {
        const https = require("https");
        try {
          const vastKey = require("fs").readFileSync("/root/.config/vastai/vast_api_key", "utf8").trim();
          const data = await new Promise((resolve, reject) => {
            const req = https.get("https://console.vast.ai/api/v0/instances/?owner=me", {
              headers: { Authorization: `Bearer ${vastKey}` }, timeout: 15000,
            }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d)); } }); });
            req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
          });
          const instances = data.instances || [];
          if (instances.length === 0) return { content: [{ type: "text", text: "No running GPU instances." }] };
          const summary = instances.map(i => {
            // Prefer direct SSH over proxy
            const ports = i.ports || {};
            const sshMapping = ports["22/tcp"];
            let sHost = i.ssh_host, sPort = i.ssh_port;
            if (i.public_ipaddr && sshMapping && sshMapping[0]) {
              sHost = i.public_ipaddr; sPort = sshMapping[0].HostPort;
            }
            return {
              id: i.id, status: i.actual_status, gpu: i.gpu_name,
              gpu_util: `${i.gpu_util || 0}%`, gpu_temp: `${Math.round(i.gpu_temp || 0)}°C`,
              vram: `${i.gpu_ram || 0}MB`,
              ssh: `ssh -p ${sPort} root@${sHost}`, ssh_host: sHost, ssh_port: sPort,
              cost_hr: `$${(i.dph_total || 0).toFixed(3)}/hr`,
              disk_used: `${((i.disk_usage || 0) * 100).toFixed(1)}%`, geo: i.geolocation,
            };
          });
          return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Failed to query Vast.ai: ${e.message}` }], isError: true };
        }
      }

      case "gpu_create": {
        const https = require("https");
        const gpu = args.gpu_model || "RTX_3090";
        const disk = args.disk_gb || 80;
        const maxCost = args.max_cost || 0.30;
        try {
          const vastKey = require("fs").readFileSync("/root/.config/vastai/vast_api_key", "utf8").trim();
          const vastGet = (path) => new Promise((resolve, reject) => {
            const req = https.get(`https://console.vast.ai/api/v0${path}`, {
              headers: { Authorization: `Bearer ${vastKey}` }, timeout: 15000,
            }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d)); } }); });
            req.on("error", reject);
          });
          const vastPut = (path, body) => new Promise((resolve, reject) => {
            const payload = JSON.stringify(body);
            const req = https.request(`https://console.vast.ai/api/v0${path}`, {
              method: "PUT", headers: { Authorization: `Bearer ${vastKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 30000,
            }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d }); } }); });
            req.on("error", reject); req.write(payload); req.end();
          });
          // Search offers
          const q = encodeURIComponent(JSON.stringify({ gpu_name: { eq: gpu }, rentable: { eq: true }, num_gpus: { eq: 1 }, inet_down: { gte: 100 }, disk_space: { gte: disk }, dph_total: { lte: maxCost } }));
          const offers = await vastGet(`/bundles?q=${q}&order=[[%22dph_total%22,%22asc%22]]&limit=5`);
          const offerList = offers.offers || [];
          if (offerList.length === 0) return { content: [{ type: "text", text: `No ${gpu} offers found under $${maxCost}/hr with ${disk}GB disk.` }], isError: true };
          const best = offerList[0];
          // Create instance
          const result = await vastPut(`/asks/${best.id}/`, { client_id: "me", image: "vastai/base-image:cuda-13.0.2-auto", disk: disk });
          const instId = result.new_contract;
          if (!instId) return { content: [{ type: "text", text: `Failed to create instance: ${JSON.stringify(result)}` }], isError: true };
          // Wait for running (poll up to 3 min)
          let sshInfo = null;
          for (let i = 0; i < 18; i++) {
            await new Promise(r => setTimeout(r, 10000));
            try {
              const info = await vastGet(`/instances/${instId}`);
              const inst = info.instances ? info.instances[0] : info;
              if (inst.actual_status === "running" && inst.ssh_port) {
                sshInfo = { id: instId, ssh: `ssh -p ${inst.ssh_port} root@${inst.ssh_host}`, ssh_host: inst.ssh_host, ssh_port: inst.ssh_port, gpu: inst.gpu_name, cost: `$${inst.dph_total.toFixed(3)}/hr` };
                break;
              }
            } catch {}
          }
          if (!sshInfo) return { content: [{ type: "text", text: `Instance ${instId} created but not ready yet. Check with gpu_status.` }] };
          return { content: [{ type: "text", text: `GPU instance created!\n${JSON.stringify(sshInfo, null, 2)}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
        }
      }

      case "gpu_destroy": {
        const https = require("https");
        try {
          const vastKey = require("fs").readFileSync("/root/.config/vastai/vast_api_key", "utf8").trim();
          const vastDel = (path) => new Promise((resolve, reject) => {
            const req = https.request(`https://console.vast.ai/api/v0${path}`, {
              method: "DELETE", headers: { Authorization: `Bearer ${vastKey}` }, timeout: 15000,
            }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); });
            req.on("error", reject); req.end();
          });
          if (args.instance_id) {
            await vastDel(`/instances/${args.instance_id}/`);
            return { content: [{ type: "text", text: `Destroyed instance ${args.instance_id}` }] };
          }
          const vastGet = (path) => new Promise((resolve, reject) => {
            https.get(`https://console.vast.ai/api/v0${path}`, {
              headers: { Authorization: `Bearer ${vastKey}` }, timeout: 15000,
            }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }).on("error", reject);
          });
          const data = await vastGet("/instances/?owner=me");
          const instances = data.instances || [];
          if (instances.length === 0) return { content: [{ type: "text", text: "No instances to destroy." }] };
          for (const inst of instances) await vastDel(`/instances/${inst.id}/`);
          return { content: [{ type: "text", text: `Destroyed ${instances.length} instance(s): ${instances.map(i => i.id).join(", ")}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
        }
      }

      case "gpu_ssh_exec": {
        const { execSync } = require("child_process");
        const https = require("https");
        try {
          const vastKey = require("fs").readFileSync("/root/.config/vastai/vast_api_key", "utf8").trim();
          let sshHost, sshPort;
          const vastGet = (path) => new Promise((resolve, reject) => {
            https.get(`https://console.vast.ai/api/v0${path}`, {
              headers: { Authorization: `Bearer ${vastKey}` }, timeout: 15000,
            }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } }); }).on("error", reject);
          });
          let inst;
          if (args.instance_id) {
            const info = await vastGet(`/instances/${args.instance_id}/`);
            inst = info.instances || info;
            if (Array.isArray(inst)) inst = inst[0];
          } else {
            const data = await vastGet("/instances/?owner=me");
            const instances = data.instances || [];
            if (instances.length === 0) return { content: [{ type: "text", text: "No running instances." }], isError: true };
            inst = instances[0];
          }
          // Prefer direct SSH (public_ipaddr + port 22 mapping) over SSH proxy
          const ports = inst.ports || {};
          const sshMapping = ports["22/tcp"];
          if (inst.public_ipaddr && sshMapping && sshMapping[0]) {
            sshHost = inst.public_ipaddr;
            sshPort = sshMapping[0].HostPort;
          } else {
            sshHost = inst.ssh_host;
            sshPort = inst.ssh_port;
          }
          if (!sshHost || !sshPort) return { content: [{ type: "text", text: "Could not determine SSH connection details." }], isError: true };
          const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p ${sshPort} root@${sshHost} ${JSON.stringify(args.command)}`;
          const output = execSync(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }).toString();
          return { content: [{ type: "text", text: output || "(no output)" }] };
        } catch (e) {
          const stderr = e.stderr ? e.stderr.toString() : "";
          return { content: [{ type: "text", text: `SSH exec failed: ${e.message}\n${stderr}`.trim() }], isError: true };
        }
      }

      // ── CAPTCHA Solver ──────────────────────────────────────────────────────

      case "solve_captcha": {
        const http = require("http");
        const COLLECTOR_URL = process.env.COLLECTOR_URL || "http://172.17.0.1:3335";
        try {
          const body = JSON.stringify({ url: args.url || "https://www.linkedin.com" });
          const result = await new Promise((resolve, reject) => {
            const parsedUrl = new URL(`${COLLECTOR_URL}/solve-captcha`);
            const req = http.request({
              hostname: parsedUrl.hostname,
              port: parsedUrl.port,
              path: parsedUrl.pathname,
              method: "POST",
              headers: { "Content-Type": "application/json", "Content-Length": body.length },
              timeout: 180000,
            }, (res) => {
              let d = "";
              res.on("data", c => d += c);
              res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
            });
            req.on("error", reject);
            req.write(body);
            req.end();
          });
          const msg = result.solved
            ? `CAPTCHA solved! Type: ${result.type}${result.callbackTriggered ? ", callback triggered" : ""}`
            : `CAPTCHA not solved: ${result.error || "unknown error"}`;
          return { content: [{ type: "text", text: msg }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Solver error: ${e.message}` }], isError: true };
        }
      }

      // ── Thread tools ──────────────────────────────────────────────────────────

      case "list_threads": {
        const threads = await db.getThreads(args.status || null);
        if (threads.length === 0) return { content: [{ type: "text", text: "No threads yet." }] };
        // Attach directive counts from in-memory directives
        const allDirs = getDirectives();
        const lines = threads.map(t => {
          const linked = allDirs.filter(d => d.thread_id === t.id);
          const completed = linked.filter(d => d.status === "completed").length;
          const active = linked.filter(d => ["in_progress", "planning", "planned", "approved", "pending"].includes(d.status)).length;
          const status = t.status === "archived" ? " [archived]" : "";
          return `• ${t.name}${status} (${t.id}) — ${linked.length} directives (${completed} done, ${active} active)${t.summary ? `\n  ${t.summary.substring(0, 120)}` : ""}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "get_thread": {
        const thread = await db.getThread(args.thread_id);
        if (!thread) return { content: [{ type: "text", text: `Thread ${args.thread_id} not found.` }], isError: true };
        const result = {
          id: thread.id, name: thread.name, status: thread.status,
          summary: thread.summary, decisions: thread.decisions,
          directives: (thread.directives || []).map(d => ({
            id: d.id, title: d.title, status: d.status, emoji: d.emoji,
            work_summary: d.work_summary, created_at: d.created_at, completed_at: d.completed_at,
          })),
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "get_thread_timeline": {
        const http = require("http");
        const result = await new Promise((resolve, reject) => {
          const req = http.request({ hostname: "localhost", port: 3333, path: `/threads/${args.thread_id}/timeline`, method: "GET",
            headers: { Authorization: `Bearer ${process.env.API_KEY || ""}` },
          }, (res) => {
            let d = ""; res.on("data", c => d += c);
            res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
          });
          req.on("error", reject); req.end();
        });
        if (result.error) return { content: [{ type: "text", text: `Error: ${JSON.stringify(result.error)}` }], isError: true };
        const entries = (result.timeline || []).slice(-100); // Last 100 entries
        const lines = entries.map(e => {
          const ts = new Date(e.timestamp).toISOString().replace("T", " ").substring(0, 19);
          return `[${ts}] ${e.directive_emoji || ""} ${e.directive_title} — ${e.type}: ${e.message}`;
        });
        return { content: [{ type: "text", text: `Thread: ${result.thread?.name || args.thread_id}\n\n${lines.join("\n") || "No activity yet."}` }] };
      }

      case "organize_directive": {
        const http = require("http");
        let threadId = args.thread_id;

        // Create new thread if no thread_id provided
        if (!threadId && args.thread_name) {
          const body = JSON.stringify({ name: args.thread_name, summary: args.thread_summary || null });
          const createResult = await new Promise((resolve, reject) => {
            const req = http.request({ hostname: "localhost", port: 3333, path: "/threads", method: "POST",
              headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${process.env.API_KEY || ""}` },
            }, (res) => {
              let d = ""; res.on("data", c => d += c);
              res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: d }); } });
            });
            req.on("error", reject); req.write(body); req.end();
          });
          if (!createResult.ok) return { content: [{ type: "text", text: `Failed to create thread: ${JSON.stringify(createResult)}` }], isError: true };
          threadId = createResult.thread.id;
        }

        if (!threadId) return { content: [{ type: "text", text: "Provide thread_id or thread_name to create a new thread." }], isError: true };

        // Link directive to thread
        const linkBody = JSON.stringify({ directive_id: args.directive_id });
        await new Promise((resolve, reject) => {
          const req = http.request({ hostname: "localhost", port: 3333, path: `/threads/${threadId}/link`, method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(linkBody), Authorization: `Bearer ${process.env.API_KEY || ""}` },
          }, (res) => {
            let d = ""; res.on("data", c => d += c);
            res.on("end", () => resolve(d));
          });
          req.on("error", reject); req.write(linkBody); req.end();
        });

        // Record decision if provided
        if (args.add_decision) {
          const decBody = JSON.stringify({ add_decision: { text: args.add_decision, directive_id: args.directive_id } });
          await new Promise((resolve, reject) => {
            const req = http.request({ hostname: "localhost", port: 3333, path: `/threads/${threadId}`, method: "PATCH",
              headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(decBody), Authorization: `Bearer ${process.env.API_KEY || ""}` },
            }, (res) => {
              let d = ""; res.on("data", c => d += c);
              res.on("end", () => resolve(d));
            });
            req.on("error", reject); req.write(decBody); req.end();
          });
        }

        const verb = args.thread_id ? "linked to" : "created thread and linked to";
        return { content: [{ type: "text", text: `Directive ${args.directive_id} ${verb} ${threadId}${args.add_decision ? ". Decision recorded." : ""}` }] };
      }

      case "execute_objective": {
        const { ObjectiveEngine } = require("../soc/objective-engine");
        const { AttackPlanner } = require("../soc/attack-planner");
        const { AutonomousLoop } = require("../soc/autonomous-loop");

        const objEngine = new ObjectiveEngine(db, log);
        const planner = new AttackPlanner(log);

        // Create objective
        const objective = await objEngine.createObjective({
          goal: args.goal,
          target: args.target,
          engagement_id: args.engagement_id,
          directive_id: args.directive_id,
          scope: args.scope || {},
          max_iterations: args.max_iterations || 20,
        });

        // Generate attack plan
        objective.attack_plan = planner.createAttackPlan(objective);
        objective.state.status = "executing";

        log(`[execute_objective] Starting autonomous loop for ${objective.id}: ${args.goal} on ${args.target}`);

        // Initialize autonomous loop
        const loop = new AutonomousLoop({
          objectiveEngine: objEngine,
          attackPlanner: planner,
          db,
          log,
        });

        // Execute autonomous loop (this will iterate until complete or escalation)
        const result = await loop.execute(objective.id);

        // Format response based on outcome
        if (result.success) {
          return {
            content: [{
              type: "text",
              text: `✅ **Objective ACHIEVED**

${result.narrative}

**Evidence:**
${result.objective.state.evidence.map(e => `- ${e}`).join('\n') || "No evidence files"}

**Findings:**
${result.objective.state.findings.map(f => `- [${f.severity}] ${f.title}`).join('\n') || "No findings"}

**Final Access:** ${result.objective.state.current_access_level}
**Iterations:** ${result.objective.state.iterations}/${result.objective.max_iterations}`
            }]
          };
        } else if (result.escalate) {
          return {
            content: [{
              type: "text",
              text: `⚠️  **ESCALATION NEEDED**

**Reason:** ${result.reason}
**Message:** ${result.message}

${result.narrative}

**What was tried:**
${result.objective.state.attempts.map((a, i) => `${i + 1}. ${a.method} — ${a.result}`).join('\n')}

**Findings so far:**
${result.objective.state.findings.map(f => `- [${f.severity}] ${f.title}`).join('\n') || "No findings"}

**Current Access:** ${result.objective.state.current_access_level}
**Iterations:** ${result.objective.state.iterations}/${result.objective.max_iterations}

**Need your input:** What strategy should we try next?`
            }]
          };
        } else {
          return {
            content: [{
              type: "text",
              text: `❌ **Objective FAILED**

${result.narrative}

**Attempts:** ${result.objective.state.iterations}
**Final Access:** ${result.objective.state.current_access_level}`
            }]
          };
        }
      }

      case "invoke_joko": {
        const fs = require("fs");
        const { spawn } = require("child_process");
        const evidenceDir = args.evidence_dir || `/tmp/${args.engagement_id}/evidence/`;

        // Create evidence directory
        if (!fs.existsSync(evidenceDir)) {
          fs.mkdirSync(evidenceDir, { recursive: true });
        }

        // Log to audit trail
        const auditEntry = await db.query(`
          INSERT INTO agent_audit_log (agent_name, engagement_id, directive_id, task, spawned_by, status, metadata)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `, [
          "joko",
          args.engagement_id,
          args.directive_id || null,
          args.task,
          "cipher",
          "running",
          JSON.stringify({ scope: args.scope || {}, evidence_dir: evidenceDir })
        ]);
        const auditId = auditEntry.rows[0].id;

        // Build context for Joko agent
        const jokoContext = {
          engagement_id: args.engagement_id,
          directive_id: args.directive_id,
          task: args.task,
          scope: args.scope || {},
          evidence_dir: evidenceDir,
          audit_id: auditId,
        };

        // Spawn Joko agent as separate claude process with joko profile
        const sessionId = `joko_${auditId}_${Date.now()}`;
        const jokoPrompt = `${JSON.stringify(jokoContext, null, 2)}\n\n${args.task}`;

        log(`[invoke_joko] Spawning Joko session ${sessionId} for engagement ${args.engagement_id}`);
        log(`[invoke_joko] Task: ${args.task}`);

        // Spawn Joko as background task
        const tmpTaskFile = `/tmp/joko-task-${sessionId}.txt`;
        const tmpOutputFile = `/tmp/joko-output-${sessionId}.txt`;

        // Read Joko agent persona (on dev-01)
        // Use base64 to avoid all escaping issues with JSON/newlines
        const base64Prompt = Buffer.from(jokoPrompt).toString('base64');

        // Spawn Joko on dev-01 with persona injected via append-system-prompt
        // Note: --agent flag doesn't work, use --append-system-prompt-file instead
        const fullCommand = `ssh -o StrictHostKeyChecking=no dev-01 "echo '${base64Prompt}' | base64 -d > ${tmpTaskFile} && cat ${tmpTaskFile} | claude --model sonnet --append-system-prompt \\\"\\$(cat /home/hadmin/.claude/joko.md)\\\" > ${tmpOutputFile} 2>&1 &"`;

        const jokoProcess = spawn('bash', ['-c', fullCommand], {
          detached: true,
          stdio: 'ignore'
        });

        jokoProcess.unref(); // Allow parent to exit independently

        // Update audit log with session ID
        await db.query(`
          UPDATE agent_audit_log
          SET metadata = metadata || $1
          WHERE id = $2
        `, [
          JSON.stringify({ session_id: sessionId, output_file: tmpOutputFile }),
          auditId
        ]);

        log(`[invoke_joko] Joko spawned with PID ${jokoProcess.pid}, output: ${tmpOutputFile}`);

        return {
          content: [{
            type: "text",
            text: `✅ Joko agent spawned for ${args.engagement_id}\n\n**Session ID:** ${sessionId}\n**Task:** ${args.task}\n**Evidence:** ${evidenceDir}\n**Audit Log:** agent_audit_log.id=${auditId}\n**Output:** ${tmpOutputFile}\n**PID:** ${jokoProcess.pid}\n\n🔄 Joko is running in background. Results will be logged to output file.`
          }]
        };
      }

      // ── SOC / Pentest Engagement tools ──────────────────────────────────────────────

      case "create_engagement": {
        // Generate engagement ID
        const timestamp = Date.now();
        const engagementId = `SKYLINE-SOC-${new Date().getFullYear()}-${String(timestamp).slice(-3)}`;

        await db.query(`
          INSERT INTO pentest_engagements (
            id, client_name, engagement_type, scope, roe, start_date, end_date, lead_engineer, sow_url, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          engagementId,
          args.client_name,
          args.engagement_type,
          JSON.stringify(args.scope),
          JSON.stringify(args.roe || {}),
          args.start_date || null,
          args.end_date || null,
          args.lead_engineer || null,
          args.sow_url || null,
          'scoping'
        ]);

        // dir_1780846961338: warn at creation if scope.targets is free-text only.
        let scopeWarn = "";
        try {
          const sv = require("../soc/scope-validator");
          const v = sv.validateScope(args.scope || {});
          if (!v.machine_readable) {
            scopeWarn =
              `\n\n⚠️ **Scope warning:** scope.targets has ${v.free_text_count} free-text entries and ` +
              `${v.valid_count} machine-readable (IPv4/CIDR) entries. The workspace_jail layer ` +
              `(dir_1780844590951) will REJECT every dispatched command until a real CIDR or IPv4 ` +
              `lands in scope.targets. Use \`scope.targets_note\` for human context.\n\n` +
              v.warnings.map(w => `- ${w}`).join("\n");
          } else if (v.free_text_count > 0) {
            scopeWarn =
              `\n\nℹ️ Scope hint: ${v.free_text_count} free-text + ${v.valid_count} machine-readable. ` +
              `Free-text entries are ignored by workspace_jail — they're just human notes.`;
          }
        } catch (_) {}
        return {
          content: [{
            type: "text",
            text: `✅ Pentest engagement created\n\n**ID:** ${engagementId}\n**Client:** ${args.client_name}\n**Type:** ${args.engagement_type}\n**Status:** scoping\n\n**Scope:**\n\`\`\`json\n${JSON.stringify(args.scope, null, 2)}\n\`\`\`${scopeWarn}\n\n**Next:** Call \`invoke_joko\` to begin reconnaissance with this engagement_id.`
          }]
        };
      }

      case "spawn_sub_agent": {
        // dir_1780848098817
        const sa = require("../soc/offense-sub-agent");
        try {
          const r = await sa.spawnSubAgent({
            engagement_id: args.engagement_id,
            target_host: args.target_host,
            target_role: args.target_role,
            objective: args.objective,
            permission_mode_override: args.permission_mode_override,
            max_iter: args.max_iter,
            spawned_by: "operator",
            spawned_reason: args.spawned_reason || "operator MCP spawn",
          });
          if (r && r.error) {
            return { content: [{ type: "text", text: `spawn_sub_agent failed: ${r.error}` }], isError: true };
          }
          return {
            content: [{
              type: "text",
              text: `🪢 Sub-agent #${r.id} spawned\n\n` +
                    `- **Engagement:** ${r.engagement_id}\n` +
                    `- **Target:** ${r.target_host}${r.target_role ? ` (role: ${r.target_role})` : ""}\n` +
                    `- **Objective:** ${r.objective || "(unspecified — defaults to investigate target)"}\n` +
                    `- **Permission mode:** ${r.permission_mode_override || "(inherit from engagement)"}\n` +
                    `- **Scope override:** ${(r.scope_targets_override || []).join(", ")}\n` +
                    `- **Max iter:** ${r.max_iter}\n\n` +
                    `Sub-agent runs in background. Use \`list_sub_agents\` to check status, \`terminate_sub_agent\` to stop it.`,
            }]
          };
        } catch (e) {
          return { content: [{ type: "text", text: `spawn_sub_agent failed: ${e.message}` }], isError: true };
        }
      }

      case "list_sub_agents": {
        // dir_1780848098817
        const sa = require("../soc/offense-sub-agent");
        try {
          const rows = await sa.listSubAgents(args.engagement_id);
          if (rows.length === 0) {
            return { content: [{ type: "text", text: `No sub-agents for engagement ${args.engagement_id}.` }] };
          }
          const lines = rows.map(r => {
            const icon =
              r.status === "running"   ? "🟢" :
              r.status === "pending"   ? "⏳" :
              r.status === "completed" ? "✅" :
              r.status === "paused"    ? "⏸️" :
              r.status === "failed"    ? "❌" :
              r.status === "terminated"? "🛑" : "❓";
            return `${icon} **#${r.id}** ${r.target_host}${r.target_role ? ` (${r.target_role})` : ""}\n` +
                   `  status=${r.status} iter=${r.iter}/${r.max_iter} findings=${r.total_findings} queue=${r.total_queue_items}\n` +
                   `  objective: ${(r.objective || "—").slice(0, 120)}\n` +
                   `  last: ${(r.last_action || "—").slice(0, 120)}` +
                   `${r.permission_mode_override ? `\n  permission_mode_override: ${r.permission_mode_override}` : ""}`;
          });
          return { content: [{ type: "text", text: `**Sub-agents for ${args.engagement_id}** (${rows.length}):\n\n${lines.join("\n\n")}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `list_sub_agents failed: ${e.message}` }], isError: true };
        }
      }

      case "terminate_sub_agent": {
        // dir_1780848098817
        const sa = require("../soc/offense-sub-agent");
        try {
          const r = await sa.terminateSubAgent(args.sub_agent_id, args.reason);
          if (!r) {
            return { content: [{ type: "text", text: `Sub-agent ${args.sub_agent_id} not found or not running.` }], isError: true };
          }
          return { content: [{ type: "text", text: `🛑 Sub-agent #${r.id} (${r.target_host}) terminated. Reason: ${args.reason || "no reason given"}.` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `terminate_sub_agent failed: ${e.message}` }], isError: true };
        }
      }

      case "validate_engagement_scope": {
        // dir_1780846961338
        const sv = require("../soc/scope-validator");
        try {
          const r = await db.query(`SELECT id, scope FROM pentest_engagements WHERE id = $1`, [args.engagement_id]);
          if (r.rows.length === 0) {
            return { content: [{ type: "text", text: `Engagement ${args.engagement_id} not found.` }], isError: true };
          }
          const v = sv.validateScope(r.rows[0].scope);
          const icon = v.machine_readable ? "✅" : "🛑";
          const head = `${icon} **Scope validation for ${r.rows[0].id}**\n\n` +
            `- IPv4 entries: ${v.ipv4_count}\n- CIDR entries: ${v.cidr_count}\n` +
            `- Hostname entries: ${v.hostname_count}\n- Free-text entries: ${v.free_text_count}\n` +
            `- Machine-readable: **${v.machine_readable}**\n\n`;
          const cls = v.classifications.map(c => `- [${c.kind}] \`${String(c.value).slice(0, 100)}\``).join("\n");
          const wrn = v.warnings.length ? `\n\n**Warnings:**\n${v.warnings.map(w => `- ⚠️ ${w}`).join("\n")}` : "";
          return { content: [{ type: "text", text: head + "**Classifications:**\n" + cls + wrn }] };
        } catch (e) {
          return { content: [{ type: "text", text: `validate_engagement_scope failed: ${e.message}` }], isError: true };
        }
      }

      case "list_engagements": {
        let query = `SELECT * FROM pentest_engagements`;
        const params = [];
        if (args.status) {
          query += ` WHERE status = $1`;
          params.push(args.status);
        }
        query += ` ORDER BY created_at DESC`;

        const result = await db.query(query, params);
        if (result.rows.length === 0) {
          return { content: [{ type: "text", text: "No pentest engagements found." }] };
        }

        const lines = await Promise.all(result.rows.map(async (eng) => {
          const findingsCount = await db.query(
            `SELECT COUNT(*) as count FROM pentest_findings WHERE engagement_id = $1`,
            [eng.id]
          );
          const count = findingsCount.rows[0].count;
          return `• **${eng.id}** — ${eng.client_name} (${eng.engagement_type}) — ${eng.status} — ${count} findings`;
        }));

        return {
          content: [{
            type: "text",
            text: `**Pentest Engagements:**\n\n${lines.join('\n')}`
          }]
        };
      }

      case "get_engagement": {
        const eng = await db.query(
          `SELECT * FROM pentest_engagements WHERE id = $1`,
          [args.engagement_id]
        );
        if (eng.rows.length === 0) {
          return { content: [{ type: "text", text: `Engagement ${args.engagement_id} not found.` }] };
        }

        const e = eng.rows[0];
        const findings = await db.query(
          `SELECT severity, COUNT(*) as count FROM pentest_findings
           WHERE engagement_id = $1 GROUP BY severity ORDER BY
           CASE severity
             WHEN 'critical' THEN 1
             WHEN 'high' THEN 2
             WHEN 'medium' THEN 3
             WHEN 'low' THEN 4
             WHEN 'info' THEN 5
           END`,
          [args.engagement_id]
        );

        const activity = await db.query(
          `SELECT agent_name, task, status, started_at FROM agent_audit_log
           WHERE engagement_id = $1 ORDER BY started_at DESC LIMIT 10`,
          [args.engagement_id]
        );

        let findingsSummary = findings.rows.map(f => `  - ${f.severity}: ${f.count}`).join('\n');
        if (!findingsSummary) findingsSummary = "  (none yet)";

        let activityLog = activity.rows.map(a => `  - ${a.agent_name}: ${a.task.substring(0, 50)}... (${a.status})`).join('\n');
        if (!activityLog) activityLog = "  (no activity yet)";

        return {
          content: [{
            type: "text",
            text: `**Engagement:** ${e.id}\n**Client:** ${e.client_name}\n**Type:** ${e.engagement_type}\n**Status:** ${e.status}\n**Period:** ${e.start_date || 'TBD'} → ${e.end_date || 'TBD'}\n**Lead:** ${e.lead_engineer || 'unassigned'}\n\n**Scope:**\n\`\`\`json\n${JSON.stringify(e.scope, null, 2)}\n\`\`\`\n\n**Findings:**\n${findingsSummary}\n\n**Recent Activity:**\n${activityLog}`
          }]
        };
      }

      case "add_finding": {
        // Attack-graph fields (dir_1780781999942): informed_by/enables/kind are optional;
        // backward-compatible for callers that don't pass them. kind defaults to 'confirmed'.
        // FIX 2 (dir_1782255739233): run the shared synchronous pre-insert gate before
        // writing so this strategist/manual path cannot bypass verification. Only the
        // stateless exposure-with-403 check applies (no active probe). A legitimate
        // human/strategist finding with no self-contradicting evidence passes through
        // UNCHANGED (verdict:'skip').
        // MINOR 1: applyPreInsertGate emits telemetry on BOTH a floor (VERIFY_GATE_FAIL)
        // and a gate-internal throw (gate_failed_open); the catch below covers the one
        // case the gate cannot self-report — its own module failing to load — by emitting
        // a gate_failed_open row so a broken gate is countable instead of silent.
        let addFindingKind = ["confirmed", "hypothesis", "refuted"].includes(args.kind) ? args.kind : "confirmed";
        let addFindingSeverity = args.severity;
        let _addGate = null;
        try { _addGate = require("/app/soc/claim-verifier").applyPreInsertGate; } catch (_) {}
        if (_addGate) {
          try {
            const gated = await _addGate(
              { title: args.title, description: args.description, severity: args.severity, kind: addFindingKind, affected_asset: args.affected_asset },
              { db, engagementId: args.engagement_id, source: 'add_finding' });
            addFindingSeverity = gated.severity;
            addFindingKind     = gated.kind;
          } catch (_) { /* applyPreInsertGate self-reports throws; never fatal for strategist submissions */ }
        } else {
          try {
            await db.query(
              `INSERT INTO offense_telemetry
                 (engagement_id, queue_item_id, model_used, intent_category,
                  n_hosts, n_findings, step_queued, in_scope, n_references,
                  latency_ms, outcome, outcome_notes)
               VALUES ($1, NULL, 'claim-verifier', 'manual_gate',
                       0, 1, false, true, 0, 0, 'gate_failed_open', $2)`,
              [args.engagement_id, 'source=add_finding; claim-verifier module failed to load; finding inserted at claimed severity']);
          } catch (_) { /* telemetry never blocks strategist submission */ }
        }
        await db.query(`
          INSERT INTO pentest_findings (
            engagement_id, severity, title, description, cvss_score, cvss_vector,
            affected_asset, affected_assets, refs, mitre_attack, reproduction, remediation, evidence_files, discovered_by,
            informed_by, enables, kind
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `, [
          args.engagement_id,
          addFindingSeverity,
          args.title,
          args.description,
          args.cvss_score || null,
          args.cvss_vector || null,
          args.affected_asset || null,
          JSON.stringify(args.affected_assets || []),
          JSON.stringify(args.refs || []),
          JSON.stringify(args.mitre_attack || []),
          JSON.stringify(args.reproduction || {}),
          args.remediation || null,
          JSON.stringify(args.evidence_files || []),
          'cipher',
          JSON.stringify(args.informed_by || []),
          JSON.stringify(args.enables || []),
          addFindingKind
        ]);

        return {
          content: [{
            type: "text",
            text: `Finding recorded\n\n**Severity:** ${addFindingSeverity.toUpperCase()}\n**Title:** ${args.title}\n**Asset:** ${args.affected_asset || 'N/A'}\n**Kind:** ${addFindingKind}\n**Engagement:** ${args.engagement_id}\n\nFinding added to engagement report.`
          }]
        };
      }

      case "get_finding_graph": {
        const { materializeFindingGraph, renderForPrompt } = require("/app/soc/finding-graph");
        const graph = await materializeFindingGraph(args.engagement_id);
        const format = args.format === "json" ? "json" : "ascii";
        if (format === "json") {
          return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
        }
        const ascii = renderForPrompt(graph);
        const summary = `**Attack graph for ${args.engagement_id}** — ${graph.nodes.length} nodes (${graph.nodes.filter(n => n.kind === "confirmed").length} confirmed, ${graph.nodes.filter(n => n.kind === "hypothesis").length} hypothesis, ${graph.nodes.filter(n => n.kind === "pending_probe").length} pending probes), ${graph.edges.length} edges, ${graph.open_frontiers.length} open frontiers.\n\n\`\`\`\n${ascii}\n\`\`\``;
        return { content: [{ type: "text", text: summary }] };
      }

      case "list_findings": {
        let query = `SELECT * FROM pentest_findings WHERE engagement_id = $1`;
        const params = [args.engagement_id];
        if (args.severity) {
          query += ` AND severity = $2`;
          params.push(args.severity);
        }
        query += ` ORDER BY
          CASE severity
            WHEN 'critical' THEN 1
            WHEN 'high' THEN 2
            WHEN 'medium' THEN 3
            WHEN 'low' THEN 4
            WHEN 'info' THEN 5
          END, discovered_at DESC`;

        const result = await db.query(query, params);
        if (result.rows.length === 0) {
          return { content: [{ type: "text", text: `No findings for ${args.engagement_id}` }] };
        }

        const lines = result.rows.map(f =>
          `• [${f.severity.toUpperCase()}] **${f.title}** — ${f.affected_asset || 'N/A'} — ${f.status}`
        );

        return {
          content: [{
            type: "text",
            text: `**Findings for ${args.engagement_id}:**\n\n${lines.join('\n')}\n\n**Total:** ${result.rows.length} finding(s)`
          }]
        };
      }

      case "note_model_behavior": {
        // dir_1780763057382 — log a v1.4 corpus quality signal.
        const r = await db.query(
          `INSERT INTO model_behavior_notes
             (engagement_id, queue_item_id, iter, model_used, tag, polarity, observation, suggested_fix, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, created_at`,
          [
            args.engagement_id,
            Number.isInteger(args.queue_item_id) ? args.queue_item_id : null,
            Number.isInteger(args.iter) ? args.iter : null,
            args.model_used || null,
            args.tag,
            args.polarity,
            args.observation,
            args.suggested_fix || null,
            'cipher',
          ]
        );
        const row = r.rows[0];
        return {
          content: [{
            type: "text",
            text: `📊 model_behavior_notes#${row.id} recorded for ${args.engagement_id}\n` +
                  `**${args.polarity.toUpperCase()} · ${args.tag}** ${args.iter != null ? `(iter ${args.iter})` : ''}\n` +
                  `${args.observation}` +
                  (args.suggested_fix ? `\n\n**suggested_fix:** ${args.suggested_fix}` : ''),
          }],
        };
      }

      case "list_model_behavior_notes": {
        const conds = [];
        const params = [];
        if (args.engagement_id) { conds.push(`engagement_id = $${params.length+1}`); params.push(args.engagement_id); }
        if (args.tag)           { conds.push(`tag = $${params.length+1}`);           params.push(args.tag); }
        if (args.polarity)      { conds.push(`polarity = $${params.length+1}`);      params.push(args.polarity); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 50;
        const result = await db.query(
          `SELECT id, engagement_id, iter, model_used, tag, polarity, observation, suggested_fix, created_at
             FROM model_behavior_notes ${where}
            ORDER BY created_at DESC LIMIT ${limit}`, params);
        if (result.rows.length === 0) {
          return { content: [{ type: "text", text: `No model_behavior_notes match.` }] };
        }
        const lines = result.rows.map(n => {
          const head = `• [${n.polarity}] **${n.tag}** ${n.iter != null ? `iter=${n.iter}` : ''} ${n.model_used ? `(${n.model_used})` : ''} — ${n.engagement_id}`;
          const fix = n.suggested_fix ? `\n  → fix: ${n.suggested_fix}` : '';
          return `${head}\n  ${n.observation}${fix}`;
        });
        return { content: [{ type: "text", text: `**${result.rows.length} model_behavior_notes:**\n\n${lines.join('\n\n')}` }] };
      }

      case "get_recon": {
        let q = `SELECT ip, mac, vendor, hostname, status, ports, discovered_at
                 FROM recon_hosts WHERE engagement_id = $1`;
        const p = [args.engagement_id];
        if (args.status) { q += ` AND status = $2`; p.push(args.status); }
        q += ` ORDER BY ip`;
        const result = await db.query(q, p);
        if (result.rows.length === 0) {
          return { content: [{ type: "text", text: `No recon hosts for ${args.engagement_id} yet. Run a recon queue item from the SOC app — scan output is parsed into structured rows automatically at ingest.` }] };
        }
        const lines = result.rows.map((h) => {
          const ports = Array.isArray(h.ports) ? h.ports : [];
          const open = ports.filter((pt) => (pt.state || "").includes("open"));
          const portStr = open.length
            ? open.map((pt) => `${pt.port}/${pt.proto} ${pt.service || "?"}${pt.version ? " (" + pt.version + ")" : ""}`).join(", ")
            : (ports.length ? "no open ports" : "—");
          const idStr = h.hostname ? `${h.ip} (${h.hostname})` : h.ip;
          const macStr = h.mac ? ` [${h.mac}${h.vendor ? " " + h.vendor : ""}]` : "";
          return `• ${idStr}${macStr} — ${h.status || "?"} — ${portStr}`;
        });
        return {
          content: [{
            type: "text",
            text: `**Recon hosts for ${args.engagement_id}** (structured; raw scan output not shown):\n\n${lines.join("\n")}\n\n**Total:** ${result.rows.length} host(s)`
          }]
        };
      }

      case "trace_dispatch": {
        // dir_1780846511537
        const tracer = require("../soc/dispatch-tracer");
        try {
          const trace = await tracer.traceDispatch(args.engagement_id, args.command, args.intent_class);
          if (trace.error) {
            return { content: [{ type: "text", text: `trace_dispatch failed: ${trace.error}` }], isError: true };
          }
          return { content: [{ type: "text", text: tracer.renderTraceMarkdown(trace) }] };
        } catch (e) {
          return { content: [{ type: "text", text: `trace_dispatch failed: ${e.message}` }], isError: true };
        }
      }

      case "register_engagement_cron": {
        // dir_1780846234615
        const cron = require("../soc/engagement-cron");
        try {
          const r = await cron.createCron({
            engagement_id: args.engagement_id,
            schedule: args.schedule,
            prompt: args.prompt,
            intent_class: args.intent_class,
            description: args.description,
            created_by: "operator",
          });
          if (r && r.error) {
            return { content: [{ type: "text", text: `register_engagement_cron failed: ${r.error}` }], isError: true };
          }
          return {
            content: [{
              type: "text",
              text: `⏰ Cron #${r.id} scheduled for ${r.engagement_id}\n\n` +
                    `- **Schedule:** \`${r.schedule}\` (UTC)\n` +
                    `- **Intent:** ${r.intent_class}\n` +
                    `- **Next fire:** ${r.next_run_at || "(none — schedule may not match in 1y)"}\n` +
                    `- **Prompt:** \`${(r.prompt || "").slice(0, 200)}\`\n` +
                    `${r.description ? `- **Description:** ${r.description}\n` : ""}` +
                    `\nWhen due, the prompt is queued as a soc_queue_items row with intent_class=${r.intent_class} and runs through the full gate stack.`,
            }]
          };
        } catch (e) {
          return { content: [{ type: "text", text: `register_engagement_cron failed: ${e.message}` }], isError: true };
        }
      }

      case "list_engagement_crons": {
        // dir_1780846234615
        const cron = require("../soc/engagement-cron");
        try {
          const rows = await cron.listCrons(args.engagement_id || null);
          if (rows.length === 0) {
            return { content: [{ type: "text", text: args.engagement_id ? `No crons for engagement ${args.engagement_id}.` : `No crons registered.` }] };
          }
          const lines = rows.map(c =>
            `- **#${c.id}** [${c.enabled ? "enabled" : "DISABLED"}] eng=${c.engagement_id} ` +
            `schedule=\`${c.schedule}\` intent=${c.intent_class} runs=${c.run_count || 0}` +
            `${c.last_run_at ? ` | last=${c.last_run_at}` : ""}` +
            `${c.next_run_at ? ` | next=${c.next_run_at}` : ""}\n` +
            `  prompt: \`${(c.prompt || "").slice(0, 180)}\`` +
            `${c.description ? `\n  desc: ${c.description}` : ""}`);
          return { content: [{ type: "text", text: `**Scheduled crons** (${rows.length}):\n\n${lines.join("\n\n")}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `list_engagement_crons failed: ${e.message}` }], isError: true };
        }
      }

      case "delete_engagement_cron": {
        // dir_1780846234615
        const cron = require("../soc/engagement-cron");
        try {
          const r = await cron.deleteCron(args.cron_id);
          if (!r) {
            return { content: [{ type: "text", text: `Cron ${args.cron_id} not found.` }], isError: true };
          }
          return { content: [{ type: "text", text: `🗑️ Deleted cron #${r.id}.` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `delete_engagement_cron failed: ${e.message}` }], isError: true };
        }
      }

      case "register_engagement_hook": {
        // dir_1780845861190
        const hooks = require("../soc/hooks");
        try {
          const r = await hooks.registerHook({
            engagement_id: args.engagement_id || null,
            event: args.event,
            command: args.command,
            timeout_ms: args.timeout_ms,
            created_by: "operator",
          });
          if (r && r.error) {
            return { content: [{ type: "text", text: `register_engagement_hook failed: ${r.error}` }], isError: true };
          }
          const scope = r.engagement_id ? `engagement ${r.engagement_id}` : "GLOBAL (all engagements)";
          return {
            content: [{
              type: "text",
              text: `✅ Hook #${r.id} registered\n\n` +
                    `- **Event:** ${r.event}\n` +
                    `- **Scope:** ${scope}\n` +
                    `- **Command:** \`${(r.command || "").slice(0, 200)}\`\n` +
                    `- **Timeout:** ${r.timeout_ms}ms\n` +
                    `- **Enabled:** ${r.enabled}\n\n` +
                    `Hook will receive JSON event payload on stdin. To deny dispatch, return JSON with \`{"allow": false, "deny_reason": "..."}\`. Returning nothing (or non-JSON) = fail-open / allow.`,
            }]
          };
        } catch (e) {
          return { content: [{ type: "text", text: `register_engagement_hook failed: ${e.message}` }], isError: true };
        }
      }

      case "list_engagement_hooks": {
        // dir_1780845861190
        const hooks = require("../soc/hooks");
        try {
          const rows = await hooks.listHooks(args.engagement_id);
          if (rows.length === 0) {
            return { content: [{ type: "text", text: `No hooks registered for engagement ${args.engagement_id} (or globally).` }] };
          }
          const lines = rows.map(h =>
            `- **#${h.id}** [${h.enabled ? "enabled" : "DISABLED"}] event=\`${h.event}\` scope=${h.engagement_id || "GLOBAL"} ` +
            `fires=${h.fire_count || 0}${h.last_fired_at ? ` last=${h.last_fired_at}(${h.last_outcome || "?"})` : ""} ` +
            `timeout=${h.timeout_ms}ms\n  command: \`${(h.command || "").slice(0, 180)}\``);
          return { content: [{ type: "text", text: `**Hooks for ${args.engagement_id}** (${rows.length}):\n\n${lines.join("\n\n")}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `list_engagement_hooks failed: ${e.message}` }], isError: true };
        }
      }

      case "list_recovery_state": {
        // dir_1780845298918
        const recovery = require("../infra/recovery-recipes");
        try {
          const r = await recovery.getRecoveryState(db, args.engagement_id);
          if (!r) {
            return { content: [{ type: "text", text: `Engagement ${args.engagement_id} not found.` }], isError: true };
          }
          if (r.error) {
            return { content: [{ type: "text", text: `list_recovery_state failed: ${r.error}` }], isError: true };
          }
          const state = r.recovery_state || {};
          const scenarios = Object.entries(state);
          if (scenarios.length === 0) {
            return { content: [{ type: "text", text: `Engagement ${r.id} — paused=${r.paused}. No recovery scenarios triggered yet (no failure patterns detected).` }] };
          }
          const lines = scenarios.map(([k, v]) =>
            `- **${k}**: ${v.attempts} attempt(s) ${v.escalated ? "(ESCALATED — paused)" : ""} — last: ${v.last_attempt_at || "?"} — evidence: ${(v.last_evidence || "").slice(0, 200)}`
          );
          return {
            content: [{
              type: "text",
              text: `**Recovery state for ${r.id}** (paused=${r.paused}):\n\n${lines.join("\n")}\n\n${r.paused ? "Operator must unpause to resume. Review the evidence above and either: (a) escalate permission_mode if it's a permission_streak, (b) fix the upstream condition (e.g. restore tablet for executor_offline), (c) manually unpause via SQL if false positive." : "Engagement still running — auto-recovery is in flight."}`,
            }]
          };
        } catch (e) {
          return { content: [{ type: "text", text: `list_recovery_state failed: ${e.message}` }], isError: true };
        }
      }

      case "set_engagement_permission_mode": {
        // dir_1780844590951
        const enforcer = require("../soc/permission-enforcer");
        if (!enforcer.isValidMode(args.mode)) {
          return { content: [{ type: "text", text: `Invalid mode '${args.mode}'. Valid: ${enforcer.ALL_MODES.join(", ")}` }], isError: true };
        }
        try {
          const prev = await db.query(
            `SELECT permission_mode FROM pentest_engagements WHERE id = $1`,
            [args.engagement_id]);
          if (prev.rows.length === 0) {
            return { content: [{ type: "text", text: `Engagement ${args.engagement_id} not found.` }], isError: true };
          }
          const prevMode = prev.rows[0].permission_mode || "enumeration";
          await db.query(
            `UPDATE pentest_engagements SET permission_mode = $2 WHERE id = $1`,
            [args.engagement_id, args.mode]);
          try {
            await db.query(
              `INSERT INTO offense_telemetry
                 (engagement_id, queue_item_id, model_used, intent_category,
                  n_hosts, n_findings, step_queued, in_scope, n_references,
                  latency_ms, outcome, outcome_notes)
               VALUES ($1, NULL, 'operator', 'mode_change', 0, 0, false, true, 0, 0,
                       'mode_changed', $2)`,
              [args.engagement_id, `${prevMode} → ${args.mode}${args.reason ? ` | reason: ${args.reason.slice(0, 200)}` : ""}`]);
          } catch (_) {}
          const isEscalation = enforcer.MODE_RANK[args.mode] > enforcer.MODE_RANK[prevMode];
          const arrow = isEscalation ? "↑" : (enforcer.MODE_RANK[args.mode] < enforcer.MODE_RANK[prevMode] ? "↓" : "→");
          return {
            content: [{
              type: "text",
              text: `Permission mode for ${args.engagement_id}: **${prevMode}** ${arrow} **${args.mode}**${args.reason ? `\n\nReason: ${args.reason}` : ""}\n\nNew allowed intent ceiling: ${({recon_only:"recon", enumeration:"enumeration", exploitation_auto:"exploit_test", exploitation_prompt:"exploit_test (with human dispatch)", full_engagement:"post_exploit (RCE + persistence)"})[args.mode]}`,
            }]
          };
        } catch (e) {
          return { content: [{ type: "text", text: `set_engagement_permission_mode failed: ${e.message}` }], isError: true };
        }
      }

      case "advance_offense": {
        const offense = require("../soc/offense-engine");
        try {
          const r = await offense.advanceOffense(args.engagement_id, args.intent, args.model_override);
          if (!r.queued) {
            return { content: [{ type: "text", text: `No step queued for ${args.engagement_id} — ${r.reason}.` }] };
          }
          return { content: [{ type: "text", text: `✅ Offensive step #${r.seq} queued (queue id ${r.queue_id}) for ${r.engagement_id}.\n\n${r.note}\n\nNext: the PA runs queue item #${r.seq} in the SOC app; results come back as structured findings (get_recon / list_findings).` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `advance_offense failed: ${e.message}\n\n(If this is a connection error, the L3 model isn't up yet — call start_offense_model + wait_offense_model first.)` }], isError: true };
        }
      }

      case "start_offense_model": {
        const startup = require("../soc/offense-startup");
        try {
          const r = await startup.startOffenseModel(args);
          const head = r.reused ? `♻️  Reusing ${r.gpu}` : `🚀 Rented ${r.gpu}`;
          return { content: [{ type: "text", text: `${head} (${r.cost_hr}, instance ${r.instance_id}). Model "${r.model}" — ${r.already_pulled ? "already present" : "pulling in remote-background"}.\n\n${r.note}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `start_offense_model failed: ${e.message}` }], isError: true };
        }
      }

      case "wait_offense_model": {
        const startup = require("../soc/offense-startup");
        try {
          const r = await startup.waitOffenseModel(args);
          return { content: [{ type: "text", text: `✅ L3 offense model "${r.model}" ready (instance ${r.instance_id}, ${r.elapsed_sec}s).\n\n${r.note}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `wait_offense_model failed: ${e.message}` }], isError: true };
        }
      }

      case "stop_offense_model": {
        const startup = require("../soc/offense-startup");
        try {
          const r = await startup.stopOffenseModel();
          return { content: [{ type: "text", text: `🔌 ${r.note}` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `stop_offense_model failed: ${e.message}` }], isError: true };
        }
      }

      case "start_engagement_run": {
        const agent = require("../soc/offense-agent");
        try {
          const loopVersion = process.env.SOC_LOOP_VERSION || "v2";
          const runFn = (loopVersion === "v2" && agent.runAgentV2) ? agent.runAgentV2 : agent.runAgent;
          const runOpts = {
            max_iter: args.max_iter,
            intent: args.intent,
            model_override: args.model_override,
          };
          // dir_1782420026188: fire-and-forget — don't await the full run (30+ min).
          // The old code blocked until completion, causing MCP timeout + run death.
          // Match the autonomy toggle pattern (routes/soc.js line ~459).
          runFn(args.engagement_id, runOpts).catch((e) =>
            console.error(`[mcp/start_engagement_run] ${args.engagement_id}:`, e && e.message));
          return { content: [{ type: "text", text: `🚀 Run launched for ${args.engagement_id} (model: ${args.model_override || "default"}, max_iter: ${args.max_iter || "default"}). Monitor via get_offense_telemetry.` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `start_engagement_run failed: ${e.message}` }], isError: true };
        }
      }

      case "reset_agent_run": {
        const agent = require("../soc/offense-agent");
        try {
          await agent.resetAgent(args.engagement_id);
          return { content: [{ type: "text", text: `🧹 Agent transcript + task graph reset for ${args.engagement_id}.` }] };
        } catch (e) {
          return { content: [{ type: "text", text: `reset_agent_run failed: ${e.message}` }], isError: true };
        }
      }

      case "get_task_graph": {
        const orch = require("../soc/offense-orchestrator");
        try {
          const g = await orch.loadGraph(args.engagement_id);
          const lines = [
            `# Task Coordination Graph for ${args.engagement_id}`,
            `Total tasks: ${g.tasks.length} · Unblocked pending: ${g.unblocked.length}`,
            "",
          ];
          if (g.tasks.length === 0) lines.push("_(empty — no tasks yet)_");
          else {
            lines.push("| id | phase | status | parents | directive | outcome_signals |");
            lines.push("|---|---|---|---|---|---|");
            for (const t of g.tasks) {
              const parents = (t.parent_ids || []).length ? (t.parent_ids).join(",") : "root";
              const directive = (t.directive || "").replace(/\|/g, "\\|").slice(0, 80);
              let outcome = "";
              if (t.outcome_summary) {
                try {
                  const o = typeof t.outcome_summary === "string" ? JSON.parse(t.outcome_summary) : t.outcome_summary;
                  outcome = Array.isArray(o.key_signals) ? o.key_signals.slice(0, 2).join("; ").slice(0, 80) : "";
                } catch (_) {}
              }
              lines.push(`| ${t.id} | ${t.phase || "?"} | ${t.status} | ${parents} | ${directive} | ${outcome} |`);
            }
            if (g.unblocked.length) lines.push(`\n**Unblocked pending:** ${g.unblocked.join(", ")}`);
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          return { content: [{ type: "text", text: `get_task_graph failed: ${e.message}` }], isError: true };
        }
      }

      case "probe_executor": {
        const probe = require("../soc/executor-probe");
        try {
          const r = await probe.probeExecutor(args.engagement_id, !!args.force);
          if (!r.probed) {
            return { content: [{ type: "text", text: `Skipped — last probe was ${r.cached_age_min} min ago (<24h). Pass force:true to override.\nCurrent tools on ${r.executor}: ${(r.current_tools || []).join(", ") || "(none declared)"}` }] };
          }
          const lines = [
            `🔎 Probed ${r.executor} for ${r.engagement_id}`,
            `${r.installed_count} tools actually installed: ${r.installed.join(", ")}`,
          ];
          if (r.added.length)   lines.push(`+ Added: ${r.added.join(", ")}`);
          if (r.removed.length) lines.push(`- Removed (was declared, not installed): ${r.removed.join(", ")}`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          return { content: [{ type: "text", text: `probe_executor failed: ${e.message}` }], isError: true };
        }
      }

      case "analyze_engagement_telemetry": {
        try {
          const analyzer = require("/home/gcp/ozzu/tools/diagnostics/telemetry-analyze.js");
          const r = await analyzer.analyzeEngagement(args.engagement_id);
          if (!r.ok) return { content: [{ type: "text", text: r.error || "engagement not found" }], isError: true };
          return { content: [{ type: "text", text: r.report_md }] };
        } catch (e) {
          return { content: [{ type: "text", text: `analyze_engagement_telemetry failed: ${e.message}` }], isError: true };
        }
      }

      case "diagnose_all_engagements": {
        try {
          const analyzer = require("/home/gcp/ozzu/tools/diagnostics/telemetry-analyze.js");
          const r = await analyzer.analyzeAllActive();
          return { content: [{ type: "text", text: r.report_md }] };
        } catch (e) {
          return { content: [{ type: "text", text: `diagnose_all_engagements failed: ${e.message}` }], isError: true };
        }
      }

      case "audit_membrane": {
        try {
          const auditor = require("/home/gcp/ozzu/tools/diagnostics/membrane-audit.js");
          const r = await auditor.audit({ since: args.since || null });
          const lines = [];
          lines.push(`# Membrane audit — historical sweep`);
          if (args.since) lines.push(`**Since:** ${args.since}`);
          lines.push(`**Rows scanned:** ${r.total_rows}`);
          lines.push(`**Total breaches:** ${r.total_breaches}`);
          lines.push("");
          if (r.total_breaches === 0) {
            lines.push("✅ **MEMBRANE INTACT** — no rows in offense_telemetry contain CVE IDs, raw IPs, exploit keywords, or credential-file refs in their text fields. The L3→L4 contract has held historically.");
          } else {
            lines.push("🚨 **MEMBRANE BREACH DETECTED** — sanitization has leaked. Per-engagement counts:");
            lines.push("| engagement | breaches |"); lines.push("|---|---|");
            for (const [eng, arr] of Object.entries(r.by_engagement).sort((a, b) => b[1].length - a[1].length)) {
              lines.push(`| ${eng} | ${arr.length} |`);
            }
            lines.push("\n## Sample (first 20, content redacted)");
            lines.push("| row_id | engagement | field | kind | model |"); lines.push("|---|---|---|---|---|");
            for (const b of r.breaches.slice(0, 20)) lines.push(`| ${b.row_id} | ${b.engagement_id} | ${b.field} | ${b.kind} | ${b.model_used} |`);
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          return { content: [{ type: "text", text: `audit_membrane failed: ${e.message}` }], isError: true };
        }
      }


      case "get_behavioral_scorecard": {
        try {
          const { getBehavioralScorecard } = require("/app/soc/behavioral-scorecard");
          const scorecard = await getBehavioralScorecard(args.engagement_id, db);
          return { content: [{ type: "text", text: JSON.stringify(scorecard, null, 2) }] };
        } catch (e) {
          return { content: [{ type: "text", text: `get_behavioral_scorecard failed: ${e.message}` }], isError: true };
        }
      }

      case "get_offense_telemetry": {
        const since = args.since || new Date(Date.now() - 30 * 86400 * 1000).toISOString();
        const limit = Math.min(Number(args.limit) || 50, 500);
        const filters = [`created_at >= $1`];
        const params = [since];
        if (args.engagement_id) { filters.push(`engagement_id = $${params.length + 1}`); params.push(args.engagement_id); }
        if (args.model)         { filters.push(`model_used = $${params.length + 1}`); params.push(args.model); }
        const where = filters.join(" AND ");

        const [total, byModel, byIntent, byOutcome, latency, recent] = await Promise.all([
          db.query(`SELECT COUNT(*)::int AS n FROM offense_telemetry WHERE ${where}`, params),
          db.query(`SELECT model_used, COUNT(*)::int AS calls,
                           ROUND(AVG(latency_ms))::int AS avg_latency_ms,
                           ROUND(100.0 * SUM(CASE WHEN step_queued THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0), 1) AS step_queued_pct,
                           ROUND(AVG(n_references)::numeric, 2) AS avg_n_refs,
                           ROUND(100.0 * SUM(CASE WHEN in_scope THEN 1 ELSE 0 END)::numeric / NULLIF(SUM(CASE WHEN in_scope IS NOT NULL THEN 1 ELSE 0 END),0), 1) AS in_scope_pct
                    FROM offense_telemetry WHERE ${where} GROUP BY model_used ORDER BY calls DESC`, params),
          db.query(`SELECT intent_category, COUNT(*)::int AS calls,
                           ROUND(100.0 * SUM(CASE WHEN step_queued THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0), 1) AS step_queued_pct
                    FROM offense_telemetry WHERE ${where} GROUP BY intent_category ORDER BY calls DESC`, params),
          db.query(`SELECT outcome, COUNT(*)::int AS n FROM offense_telemetry WHERE ${where} GROUP BY outcome ORDER BY n DESC`, params),
          db.query(`SELECT ROUND(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY latency_ms))::int AS p50_ms,
                           ROUND(PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY latency_ms))::int AS p90_ms,
                           ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms))::int AS p99_ms
                    FROM offense_telemetry WHERE ${where}`, params),
          db.query(`SELECT id, engagement_id, queue_item_id, model_used, intent_category, n_hosts, n_findings, step_queued, in_scope, n_references, latency_ms, outcome, error_message, created_at
                    FROM offense_telemetry WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length + 1}`, [...params, limit]),
        ]);

        const totalN = total.rows[0]?.n || 0;
        const lat = latency.rows[0] || { p50_ms: 0, p90_ms: 0, p99_ms: 0 };
        const lines = [
          `# Offense telemetry (since ${since})`,
          `**Total calls:** ${totalN}` + (args.engagement_id ? ` for ${args.engagement_id}` : "") + (args.model ? ` on ${args.model}` : ""),
          "",
          "## By model",
        ];
        if (byModel.rows.length === 0) lines.push("_(no rows)_");
        else {
          lines.push("| model | calls | avg latency | step queued% | avg refs | in-scope% |");
          lines.push("|---|---|---|---|---|---|");
          for (const r of byModel.rows) lines.push(`| ${r.model_used} | ${r.calls} | ${(r.avg_latency_ms / 1000).toFixed(1)}s | ${r.step_queued_pct ?? "-"}% | ${r.avg_n_refs ?? "-"} | ${r.in_scope_pct ?? "-"}% |`);
        }
        lines.push("", "## By intent");
        if (byIntent.rows.length === 0) lines.push("_(no rows)_");
        else {
          lines.push("| intent | calls | step queued% |");
          lines.push("|---|---|---|");
          for (const r of byIntent.rows) lines.push(`| ${r.intent_category ?? "(null)"} | ${r.calls} | ${r.step_queued_pct ?? "-"}% |`);
        }
        lines.push("", "## Outcomes");
        if (byOutcome.rows.length === 0) lines.push("_(no rows)_");
        else {
          lines.push("| outcome | n |");
          lines.push("|---|---|");
          for (const r of byOutcome.rows) lines.push(`| ${r.outcome ?? "(null)"} | ${r.n} |`);
        }
        lines.push("", `## Latency`, `p50=${(lat.p50_ms / 1000).toFixed(1)}s · p90=${(lat.p90_ms / 1000).toFixed(1)}s · p99=${(lat.p99_ms / 1000).toFixed(1)}s`);
        lines.push("", `## Recent (${recent.rows.length} of ${totalN})`);
        if (recent.rows.length === 0) lines.push("_(no rows)_");
        else {
          lines.push("| id | engagement | qi | model | intent | hosts | findings | queued | refs | latency | outcome | error | created |");
          lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
          for (const r of recent.rows) {
            const created = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
            const err = r.error_message ? (r.error_message.length > 40 ? r.error_message.slice(0, 37) + "..." : r.error_message) : "";
            lines.push(`| ${r.id} | ${r.engagement_id} | ${r.queue_item_id ?? "-"} | ${r.model_used} | ${r.intent_category ?? "-"} | ${r.n_hosts} | ${r.n_findings} | ${r.step_queued ? "✓" : "·"} | ${r.n_references} | ${(r.latency_ms / 1000).toFixed(1)}s | ${r.outcome ?? "-"} | ${err} | ${created} |`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "soc_queue_steps": {
        // Normalize input: accept singular `item` (atomic, preferred) or `items` array.
        // Defensively parse JSON-string forms — some MCP clients serialize nested objects as strings.
        const parseMaybeJson = (v) => {
          if (typeof v !== "string") return v;
          const s = v.trim();
          if (!s) return v;
          if (s[0] !== "{" && s[0] !== "[") return v;
          try { return JSON.parse(s); } catch { return v; }
        };

        const rawItem = parseMaybeJson(args.item);
        const rawItems = parseMaybeJson(args.items);

        let items;
        let inputForm;
        if (rawItem !== undefined && rawItem !== null) {
          items = [rawItem];
          inputForm = "item";
        } else if (rawItems !== undefined && rawItems !== null) {
          items = Array.isArray(rawItems) ? rawItems : null;
          inputForm = "items";
        } else {
          return {
            content: [{ type: "text", text: `❌ soc_queue_steps requires either \`item\` (single, preferred) or \`items\` (array). Neither was provided.` }],
            isError: true,
          };
        }

        if (items === null) {
          return {
            content: [{ type: "text", text: `❌ \`items\` must be an array (or JSON-encoded array). Received type=${typeof args.items}${typeof args.items === "string" ? `, value-preview=${String(args.items).slice(0, 80)}` : ""}.` }],
            isError: true,
          };
        }

        if (items.length === 0) {
          return {
            content: [{ type: "text", text: `❌ \`${inputForm}\` parsed to 0 entries. At least one step is required.` }],
            isError: true,
          };
        }

        // Per-item validation — surface offending indices instead of silently skipping.
        const invalid = [];
        const valid = [];
        items.forEach((it, idx) => {
          const obj = parseMaybeJson(it);
          if (!obj || typeof obj !== "object") {
            invalid.push({ index: idx, reason: `not an object (type=${typeof it})` });
            return;
          }
          if (!obj.title || typeof obj.title !== "string") {
            invalid.push({ index: idx, reason: "missing/invalid title" });
            return;
          }
          if (!obj.command || typeof obj.command !== "string") {
            invalid.push({ index: idx, reason: "missing/invalid command" });
            return;
          }
          valid.push(obj);
        });

        if (invalid.length > 0) {
          const detail = invalid.map(e => `  [${e.index}] ${e.reason}`).join("\n");
          return {
            content: [{ type: "text", text: `❌ ${invalid.length} of ${items.length} item(s) invalid — nothing queued.\n\n${detail}` }],
            isError: true,
          };
        }

        const replacePending = args.replace_pending !== false;

        const engRes = await db.query(`SELECT 1 FROM pentest_engagements WHERE id = $1`, [args.engagement_id]);
        if (engRes.rows.length === 0) {
          return { content: [{ type: "text", text: `Engagement ${args.engagement_id} not found.` }], isError: true };
        }

        if (replacePending) {
          await db.query(`DELETE FROM soc_queue_items WHERE engagement_id = $1 AND status = 'pending'`, [args.engagement_id]);
        }

        const maxSeqRes = await db.query(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM soc_queue_items WHERE engagement_id = $1`,
          [args.engagement_id]
        );
        let seq = parseInt(maxSeqRes.rows[0].max_seq, 10) || 0;

        const inserted = [];
        for (const item of valid) {
          seq += 1;
          const r = await db.query(
            `INSERT INTO soc_queue_items (engagement_id, seq, title, description, command, expected_artifact, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING id, seq, title`,
            [args.engagement_id, seq, item.title, item.description || null, item.command, item.expected_artifact || null]
          );
          inserted.push(r.rows[0]);
        }

        const lines = inserted.map(r => `  ${r.seq}. ${r.title} (id=${r.id})`).join('\n');
        return {
          content: [{
            type: "text",
            text: `✅ Queued ${inserted.length} step(s) for ${args.engagement_id} (form=${inputForm}):\n\n${lines}\n\nPA engineer will see these in the SOC tab and can run each one individually.`
          }]
        };
      }

      case "soc_get_queue": {
        const result = await db.query(
          `SELECT id, seq, title, description, status, session_id, started_at, completed_at,
                  CASE WHEN output IS NULL THEN NULL ELSE substr(output, 1, 500) END AS output_preview,
                  (output IS NOT NULL) AS has_output
           FROM soc_queue_items
           WHERE engagement_id = $1
           ORDER BY seq ASC`,
          [args.engagement_id]
        );
        if (result.rows.length === 0) {
          return { content: [{ type: "text", text: `No queue items for ${args.engagement_id}.` }] };
        }
        const lines = result.rows.map(r => {
          const marker = { pending: '⏳', running: '▶', done: '✅', failed: '❌', skipped: '⊘' }[r.status] || '•';
          return `${marker} [${r.status}] ${r.seq}. ${r.title} (id=${r.id})${r.has_output ? ' — output available via list_findings/audit log' : ''}`;
        });
        return {
          content: [{
            type: "text",
            text: `**Queue for ${args.engagement_id}:**\n\n${lines.join('\n')}`
          }]
        };
      }

      // ── Person / Identity tools ──────────────────────────────────────────────

      case "list_persons": {
        const { Person } = require("../person");
        const persons = await Person.findAll(ctx.db);
        if (persons.length === 0) return { content: [{ type: "text", text: "No persons registered yet." }] };
        const lines = persons.map(p => {
          const s = p.toSummary();
          const channels = s.channels.join(", ") || "no channels";
          return `• ${s.name}${s.nickname ? ` (${s.nickname})` : ""} [${s.relationship}] — ${channels} — ${s.devices} device(s), ${s.faces} face(s)`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "get_person": {
        const { Person } = require("../person");
        const p = args.name
          ? await Person.findByName(ctx.db, args.name)
          : args.id ? await Person.find(ctx.db, args.id) : await Person.owner(ctx.db);
        if (!p) return { content: [{ type: "text", text: `Person not found: ${args.name || args.id}` }], isError: true };
        const s = p.toSummary();
        const lines = [
          `**${s.name}**${s.nickname ? ` — "${s.nickname}"` : ""}`,
          `Relationship: ${s.relationship}`,
          `Channels: ${s.channels.join(", ") || "none"}`,
          `Devices: ${s.devices}`,
          `Faces linked: ${s.faces}`,
          p.notes ? `Notes: ${p.notes}` : null,
        ].filter(Boolean);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "reach_person": {
        const { Person } = require("../person");
        const p = args.name
          ? await Person.findByName(ctx.db, args.name)
          : args.id ? await Person.find(ctx.db, args.id) : null;
        if (!p) return { content: [{ type: "text", text: `Person not found: ${args.name || args.id}` }], isError: true };
        if (!args.message) return { content: [{ type: "text", text: "message is required" }], isError: true };
        const reachApproval = await requireMessageApproval(
          "reach_person",
          `Message to ${p.name}: "${args.message}"`,
          { recipient: p.name, message: args.message }
        );
        if (reachApproval.error) return { content: [{ type: "text", text: reachApproval.error }], isError: true };
        await p.reach(args.message, args.via || null);
        const channel = args.via || (p.channels.find(c => c.is_primary) || p.channels[0])?.type || "unknown";
        return { content: [{ type: "text", text: `✓ Reached ${p.name} via ${channel}: "${args.message}"` }] };
      }

      case "create_person": {
        const { Person } = require("../person");
        if (!args.name) return { content: [{ type: "text", text: "name is required" }], isError: true };
        const channels = [];
        if (args.whatsapp) channels.push({ type: "whatsapp", address: args.whatsapp.replace(/\D/g, ""), is_primary: true });
        if (args.email) channels.push({ type: "email", address: args.email, is_primary: !args.whatsapp });
        const p = await Person.create(ctx.db, {
          name: args.name,
          nickname: args.nickname,
          relationship: args.relationship || "contact",
          notes: args.notes,
          channels,
        });
        return { content: [{ type: "text", text: `✓ Created person: ${p.name} (${p.id})\nChannels: ${p.channels.map(c => `${c.type}:${c.address}`).join(", ") || "none"}` }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  }

  // ── MCP HTTP Protocol (Streamable HTTP transport) ──

  return async function handleMcpRoutes(req, res, pathname, url) {

    // MCP endpoint — handles JSON-RPC 2.0 over HTTP
    if (pathname === "/mcp" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body || !body.method) {
        sendJSON(res, 400, { jsonrpc: "2.0", error: { code: -32600, message: "Invalid request" }, id: body?.id || null });
        return true;
      }

      const { method, params, id } = body;

      switch (method) {
        case "initialize": {
          sendJSON(res, 200, {
            jsonrpc: "2.0",
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "ozzu-bridge", version: "1.0.0" },
            },
            id,
          });
          return true;
        }

        case "notifications/initialized": {
          // Client acknowledges init — no response needed for notifications
          sendJSON(res, 200, { jsonrpc: "2.0", result: {}, id });
          return true;
        }

        case "tools/list": {
          sendJSON(res, 200, {
            jsonrpc: "2.0",
            result: { tools: TOOLS },
            id,
          });
          return true;
        }

        case "tools/call": {
          const toolName = params?.name;
          const toolArgs = params?.arguments || {};
          try {
            const result = await handleTool(toolName, toolArgs);
            sendJSON(res, 200, { jsonrpc: "2.0", result, id });
          } catch (err) {
            sendJSON(res, 200, {
              jsonrpc: "2.0",
              result: { content: [{ type: "text", text: `Tool error: ${err.message}` }], isError: true },
              id,
            });
          }
          return true;
        }

        default: {
          sendJSON(res, 200, {
            jsonrpc: "2.0",
            error: { code: -32601, message: `Method not found: ${method}` },
            id,
          });
          return true;
        }
      }
    }

    return false;
  };
};
