// routes/mcp.js — MCP (Model Context Protocol) server for Claude Code
// Exposes directive management as native Claude Code tools
// Spec: https://modelcontextprotocol.io/specification/2025-03-26

"use strict";

module.exports = function mcpRoutes(ctx) {
  const { sendJSON, parseBody, db, log: logObj, getDirectives, saveDirectives,
          broadcastToAll, sendNotification } = ctx;
  const log = typeof logObj === "function" ? logObj : (...args) => (logObj?.bridge?.info?.(...args) || console.log(...args));

  const watchdog = (() => { try { return require("../watchdog"); } catch { return null; } })();
  const recoveryEngine = (() => { try { return require("../recovery-engine"); } catch { return null; } })();
  const buildVerifier = (() => { try { return require("../build-verifier"); } catch { return null; } })();
  const infraMonitor = (() => { try { return require("../infra-monitor"); } catch { return null; } })();
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
      description: "Get live infrastructure state. TOPOLOGY: Rock Pi (172.168.0.55) is the ESP32 hub — it runs the ozzu-nodes WiFi AP and the positioning service. ESP32 nodes connect to the Rock Pi, NOT to dev-01. dev-01 (172.168.0.57) is a separate x86 Linux workstation. Sections: network (VPN, routes, LAN), devices (Rock Pi, dev-01 with reachability/services/resources), esp32 (nodes connected to Rock Pi AP), gcp (Docker, disk, memory), hub (positioning service status), router (ER605 DHCP/WAN/VPN). Cached 60s, use refresh=true for fresh probe.",
      inputSchema: {
        type: "object",
        properties: {
          refresh: { type: "boolean", description: "Force fresh probe instead of using cache (takes ~15s)" },
          section: { type: "string", enum: ["network", "devices", "esp32", "gcp", "hub", "router", "all"], description: "Return only a specific section. Default: all" },
        },
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
        },
        required: ["engagement_id", "severity", "title", "description"],
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
      name: "soc_queue_steps",
      description: "Push one or more orchestration steps to the SOC app for a pentest engagement. Prefer the atomic single-item form (`item:{...}`) — call once per step. `items:[...]` array form is still accepted for batches. PA engineer runs each step from the app; output streams back and is visible to Cipher in the same session. Each step is a single shell command to run on dev-01. By default, existing pending items are replaced on the first call of a batch — set replace_pending:false for subsequent calls in the same batch.",
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
              command: { type: "string", description: "Shell command to run on dev-01" },
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
                command: { type: "string", description: "Shell command to run on dev-01" },
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
        const { ObjectiveEngine } = require("../objective-engine");
        const { AttackPlanner } = require("../attack-planner");
        const { AutonomousLoop } = require("../autonomous-loop");

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

        return {
          content: [{
            type: "text",
            text: `✅ Pentest engagement created\n\n**ID:** ${engagementId}\n**Client:** ${args.client_name}\n**Type:** ${args.engagement_type}\n**Status:** scoping\n\n**Scope:**\n\`\`\`json\n${JSON.stringify(args.scope, null, 2)}\n\`\`\`\n\n**Next:** Call \`invoke_joko\` to begin reconnaissance with this engagement_id.`
          }]
        };
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
        await db.query(`
          INSERT INTO pentest_findings (
            engagement_id, severity, title, description, cvss_score, cvss_vector,
            affected_asset, mitre_attack, reproduction, remediation, evidence_files, discovered_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          args.engagement_id,
          args.severity,
          args.title,
          args.description,
          args.cvss_score || null,
          args.cvss_vector || null,
          args.affected_asset || null,
          JSON.stringify(args.mitre_attack || []),
          JSON.stringify(args.reproduction || {}),
          args.remediation || null,
          JSON.stringify(args.evidence_files || []),
          'cipher'
        ]);

        return {
          content: [{
            type: "text",
            text: `✅ Finding recorded\n\n**Severity:** ${args.severity.toUpperCase()}\n**Title:** ${args.title}\n**Asset:** ${args.affected_asset || 'N/A'}\n**Engagement:** ${args.engagement_id}\n\nFinding added to engagement report.`
          }]
        };
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
