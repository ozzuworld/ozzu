# Intent: Work — directives, ventures, and the revenue side

## Two distinct work systems

OZZU has two work surfaces. They look similar but are structurally separate:

| | Directives | Ventures |
|---|---|---|
| What | Code work in the pipeline | Business projects |
| Created via | `create_directive` MCP / `POST /directives` | `create_venture` MCP / `POST /business/projects` |
| Lives in DB | `directives` table | `business_projects` + `business_project_tasks` tables |
| App surface | Cipher tab → Directives sub-tab | Work tab → Ventures sub-tab → PROJECTS |
| Has a branch? | Yes (`cipher/dir_<id>`) | No |
| Deploys? | Yes (HOT/WARM/STAGING via merge-and-deploy) | No (it's not code) |
| Tracked by | Pipeline (commits, builds, deploys) | Kanban / tasks / progress |

## Directives (code work)

See `intent/pipeline.md` for the deploy mechanics. Key shape:

- **Type:** `quick` (small fix), `feature` (significant new behavior), `epic` (multi-phase), `explore` (research/spike)
- **Lifecycle:** `pending → planning → approved → in_progress → completed` (or `blocked/failed/cancelled`)
- **Activity log:** every state change + work_update + commit + deploy event gets appended to `activity_log` JSONB column. This is the audit trail.
- **External memory:** `work_summary`, `working_state`, `handoff_context` columns are how Cipher tracks state across sessions. PRINCIPLES § II.4-7 govern the branch + commit + merge flow.

## Ventures (business projects)

The OZZU app has a "Ventures" surface for non-code business work. Examples in the wild:
- Colombian Specialty Coffee → Japan export business
- Government AI grants (Minciencias ColombIA Inteligente 2026)
- Wall-crawling recon robot (Gecko, Venture #8 — straddles hardware + business)

Code: `frontend/app/(tabs)/business.tsx` with 4 sub-tabs:
1. **DASHBOARD** — aggregated stats (total projects, tasks, done, in-progress, overall %)
2. **PROJECTS** — the actual venture cards. Each ProjectCard has emoji, name, description, progress bar, task count.
3. **PIPELINE** — funding/sales/grant pipeline view
4. **CONTACTS** — people/orgs associated with ventures

Backend: `routes/business.js`, `routes/business-contacts.js`, `routes/business-shipments.js`, `routes/business-invoices.js`, `routes/business-investments.js`.

## Why Work tab groups Ventures + SOC

The 2026-05-17 refactor put Business (Ventures) and SOC engagements in the same bottom tab because they share shape:
- Both have customers (own ventures have stakeholders/investors; SOC has clients)
- Both have projects/engagements with lifecycle states
- Both have billable work
- Both are about **revenue activities**

Different audiences (own vs client) but same UI pattern. The `<GroupNav group="work">` strip in business.tsx and soc.tsx lets the user swap views without thinking about it.

## When King Kazuma says...

| He says | What Cipher does |
|---|---|
| "Create a directive to refactor X" | `create_directive` (code work) |
| "Build a feature that does Z" | `create_directive` (code work) |
| "Fix bug N" | `create_directive` (quick type) |
| "New business idea: ..." | `create_venture` (business work) |
| "Add to Ventures" / "Add Y to the dashboard" | `create_venture` |
| "Track this consulting engagement" | `create_engagement` (SOC system — see `intent/security.md`) |
| "What's pending?" | List directives + ventures + engagements with status; mark which Cipher can autonomously progress |

## The historical mistake

Cipher used to create directives for business work. King Kazuma corrected: business work isn't code, doesn't deploy, doesn't go through the pipeline. Use ventures.

Memory: `feedback_ventures_not_directives.md`.

## REST API (when MCP unavailable)

```
# Directives
POST http://localhost:3333/directives                     # create
PATCH http://localhost:3333/directives/<id>               # update status
POST http://localhost:3333/directives/<id>/work-update    # log progress
POST http://localhost:3333/directives/<id>/merge-and-deploy  # ship it

# Ventures
POST http://localhost:3333/business/projects              # create venture
POST http://localhost:3333/business/projects/<id>/tasks   # add task
GET  http://localhost:3333/business/projects              # list

# SOC engagements (separate again)
POST http://localhost:3333/soc/engagements                # create engagement
GET  http://localhost:3333/soc/engagements                # list
```

## Income reality check

Ventures and SOC engagements are how OZZU eventually generates revenue. Cipher's job in this area is to:
- Keep the work-tracking surface honest (real progress, real states, no "all green" status when things are blocked)
- Surface bottlenecks early
- Generate compliance-format reports for SOC engagements when reporting phase hits
- NOT auto-propose ventures (King Kazuma decides what businesses exist)
- NOT promise outcomes — Cipher tracks effort, doesn't forecast results

## Related principles & memories

- PRINCIPLES § II (pipeline rules apply to directives)
- Memory: `feedback_ventures_not_directives.md`, `project_soc_redteam_consulting.md`
- Code: `backend/bridge/routes/directives.js`, `backend/bridge/routes/business*.js`, `backend/bridge/routes/soc.js`
- App: `frontend/app/(tabs)/directives.tsx`, `frontend/app/(tabs)/business.tsx`, `frontend/app/(tabs)/soc.tsx`
- Related intent: `intent/pipeline.md` (how directives deploy), `intent/security.md` (how SOC works)
