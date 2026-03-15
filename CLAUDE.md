# Ozzu — Project Rules

## RULE 1 — READ BEFORE RESPONDING

When King Kazuma asks "what we worked on", "where we left off", or anything about previous work:
1. **READ the Last Conversation in CLAUDE.local.md word by word.**
2. **ANSWER DIRECTLY from that conversation.** Quote what King Kazuma said and what you said.
3. **Do NOT summarize.** Do NOT make API calls first. Do NOT give status dumps.
4. **The last thing King Kazuma said and the last thing you said — that is "where we left off."**

If you give a summary instead of quoting the conversation, you have FAILED.

## RULE 2 — CHECK INVENTORY BEFORE BUILDING

**READ `/home/gcp/ozzu/INVENTORY.md` before writing ANY code.**
If what you're about to build already exists in the inventory, USE IT. Do NOT rebuild it.
This has cost a full week of wasted work. Every script, every optimization is documented there.

## RULE 3 — FOLLOW THE PIPELINE

Before touching any file:
1. **CREATE A DIRECTIVE** — `POST /directives` with title, description, type, emoji
2. **SET STATUS** — features need `planned` + approval; fixes go straight to `in_progress`
3. **CREATE A BRANCH** — `git checkout -b cipher/dir_xxx`
4. **THEN write code**
5. **VERIFY** — run checks before merging
6. **MERGE AND DEPLOY** — `POST /directives/{id}/merge-and-deploy` (NEVER merge manually)

Skip any step = pipeline violation. Git hooks will block direct commits to main.

## RULE 4 — MANDATORY RULES

- **NEVER commit directly to main.** Work on `cipher/dir_xxx` branches.
- **NEVER manually trigger builds.** smartDeploy handles CI builds automatically after merge.
- **Every change needs a directive** — even quick fixes.
- **Every commit MUST reference a directive ID** (e.g., `Directive: dir_1234567890`).
- **NEVER stop after merging.** Monitor deploy. Report result to King Kazuma.
- **Ozzu is a React Native app — NO website.** "dashboard" = the RN app in `frontend/`.
- **iPhone NEVER receives OTA.** All iPhone changes require native build + sideload.
- **NEVER state face counts from memory.** Query Qdrant live first.
- **NEVER tell King Kazuma something works without VERIFYING FIRST.**

## Cipher Workflow

**YOUR FIRST ACTION when asked to change code: create/find a directive. NOT reading files. NOT writing code.**

1. Does this require code changes? NO → handle directly. YES → continue.
2. Create directive: `POST http://localhost:3333/directives`
3. Feature? Set `planned`, wait for approval. Fix? Set `in_progress`, proceed.
4. Create branch: `git checkout -b cipher/dir_xxx`
5. Do the work, commit with `Directive: dir_xxx`
6. Verify, then `POST /directives/{id}/merge-and-deploy`
7. Monitor deploy — job is NOT done until deploy completes.

## Pipeline Enforcement

**Git hooks** (`.githooks/`): block direct commits to main without directive ID.
Install: `git config core.hooksPath .githooks` (cipher.sh auto-installs).

**Exception tags** (commit message): `[pipeline-fix]`, `[config]`, `[docs]`, `[security]`

## Verification Commands

| Change Type | Command |
|-------------|---------|
| Frontend JS/TS | `cd frontend && npx expo export --platform android` |
| Backend JS | `node -c <file>` |
| Docker | `docker compose config -q` |
| Config plugins | `node -c frontend/plugins/<file>.js` |

## Key Personas

- **King Kazuma**: The user/architect
- **June**: Gemini Live AI companion (tablet/TV app)
- **Cipher**: Claude Code agent (GCP VM)

## Compact Instructions

When context is compacted, the summary MUST preserve:
1. **The current task** — what Cipher was working on, exact file paths, what's done vs pending
2. **The directive ID and branch** — so work continues on the right branch
3. **King Kazuma's last instruction** — exact words, not a summary
4. **Any uncommitted changes** — list modified files and what changed

After compaction, your FIRST response MUST be:
> "Context was compacted. What would you like me to work on?"

**DO NOT auto-resume any task.** DO NOT jump to BLE, GPU, face training, or any work.
WAIT for the user to tell you what to do.

## Reference

Network architecture, devices, services, deploy workflows, iOS sideloading details → see **INVENTORY.md**

Bridge server: `docker compose restart bridge`
Deploy Android: `./scripts/deploy.sh [device-names]`
OTA (Android only): `./scripts/ota-deploy.sh --restart`
Deploy iOS: `gh workflow run build-ios.yml` → King Kazuma installs via AltStore
