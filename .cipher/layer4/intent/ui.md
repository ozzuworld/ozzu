# Intent: UI — the shape of the Ozzu app

## What the app is

A React Native + Expo phone/tablet app — NOT a website. "The dashboard" means this app, not a web URL. It runs on:
- King Kazuma's iPhone (PRIMARY — sideloaded via AltStore on Windows PC)
- Android tablets (secondary surfaces around the house — OTA on every deploy)
- TV (separate `tv/` codebase, similar Expo stack)

The app is the **face of OZZU**. It's where King Kazuma sees what Cipher is doing, talks to Cipher, sees ventures, sees personal data, monitors infra. The UI is not decoration — it's the primary command surface.

## The 5-tab structure (decided 2026-05-17)

Bottom tabs, rendered inline in `home.tsx`, hidden everywhere else:

| Tab | Icon | Primary route | Groups |
|---|---|---|---|
| Home | ⌂ | `/` | Dashboard, shortcuts, top-right (🔔 attention, 📤 upload) |
| Cipher | ⚡ | `/directives` | Voice orb · Directives · Training · Metrics |
| Work | 💼 | `/business` | Ventures (Dashboard/Projects/Pipeline/Contacts) · SOC engagements |
| Me | 🪪 | `/identity` | Identity · Finance · Files · Backups (all auth-gated personal data) |
| Ops | 🖥️ | `/ops` | Infrastructure · Glasses |

Each tab's primary screen shows a `<GroupNav group="...">` strip below the top bar, with the other group members as quick-switch entries. This was the answer to "13 flat routes with 4-way redundant paths to Messages and Directives is a maze."

## Why these groups (the WHY behind the WHAT)

- **Home** — landing. Doesn't try to be everything; it's the dashboard.
- **Cipher** — "the agent's world." Voice (talk to it) + Directives (its work) + Training (its ML) + Metrics (its cost). All four are aspects of the same entity.
- **Work** — "revenue activities." Business ventures (own projects, contacts, pipeline) + SOC engagements (client pentest work). Same shape: customer, project lifecycle, billable. Different audience.
- **Me** — "private personal data." Identity vault (passport/visas/travel), Finance, Files, Backups. All require auth in the app. The grouping is **the auth gate**.
- **Ops** — "things you operate." Infrastructure status + Meta glasses + (future smart-home devices). Admin-of-your-own-stuff.

What's NOT a tab:
- Messages — deleted with the WhatsApp integration removal
- OSINT / Influence — both titled INTELLIGENCE, both deleted (redundant)
- Music, audio-routing, vacuum, agrovision, equipment — moved to hamburger or deleted entirely

## What's IN the hamburger menu

After the refactor: just 🎵 Music. Everything else is in tabs or top-bar icons.

## Top-right icons on home

- 🔔 attention badge → routes to `/directives`. Badge shows count of directives needing attention.
- 📤 upload → routes to `/upload`. Shareable single utility action.

## The design system

**Source of truth:** `frontend/lib/design-tokens.ts`

| Token group | Contents |
|---|---|
| `colors.bg.*` | Surface elevation (base/elevated/surface/overlay) |
| `colors.text.*` | Text hierarchy (primary/secondary/tertiary/disabled) |
| `colors.accent` / `colors.accentLight` | Linear indigo `#5e6ad2` |
| `colors.border.*` | Borders by strength |
| `colors.status.*` | Status pills (pending/planning/approved/in_progress/completed/failed/cancelled/blocked) |
| `colors.success/warning/error/info` | Semantic |
| `spacing.*` | 8pt grid (xs/sm/md/lg/xl/xxl/xxxl) |
| `radius.*` | Border radius (xs/sm/md/lg/xl/full) |
| `fontSize.*`, `fontWeight.*` | Typography |
| `layout.topBarHeight` | 48 — single source (was redefined in 8 files, one with wrong value 52) |

**Format helpers:** `frontend/lib/format.ts` — formatBytes, formatCOP, formatCOPCompact, formatShortDate, formatLongDate, formatRelativeOrShortDate, formatRelativeTime, formatTrackTime, formatTrackDuration, formatLongDuration.

**Component catalog:** `frontend/Components.md`. Read before building new components — reuse what exists.

**Gold-standard card:** `ProjectCard.tsx`. Reference visual language: colored left border, big emoji, 2-line description, progress bars, proper padding.

## Anti-slop rules (canonical in CLAUDE.md § "UI Design Rules")

LLM-generated UI tends to be "data dump with no design." Counter that:

1. **Never treat a screen as a data dump.** Progressive disclosure > showing everything.
2. **Visual hierarchy is mandatory.** Every screen needs one focal point, title/subtitle separation (size + weight + color contrast), breathing room.
3. **Cards need structure.** Not "text on a slightly different background." Container (bg + border or left accent), header row (icon + title + status), content (description, progress), metadata row (pills, badges, timestamps).
4. **Spacing creates rhythm.** 8pt grid. Card padding 14-16px. Gap between cards 10-12px. Never 0px gaps.
5. **Color has meaning.** Status colors from tokens. Left borders = status identity. Tinted pill backgrounds = category. Never decorative.
6. **Font hierarchy.** Title: 15px semibold white. Subtitle: 12px normal tertiary. Metadata: 10-11px disabled. Never the same size+weight+color for different info levels.
7. **Interactive feedback.** Pressables need opacity change OR scale animation (e.g., `scale: 0.98`, `opacity: 0.92`).

## The drift system

`.cipher/layer3/SUMMARY.md` runs on every commit and flags:
- Hardcoded hex colors (currently 1193 across 83 files — known gap, cleanup pass planned)
- Duplicated layout constants (currently 0 ✓)
- Duplicated format helpers (currently 0 ✓)
- Broken route references (currently 0 ✓)
- Broken HamburgerMenu / shortcut tile references (currently 0 ✓)

When Cipher writes UI code, the drift report is the empirical answer to "did I drift from the design system?" Read the SUMMARY after any UI change.

## The visual feedback loop

Historical setup (broken right now): iPhone 16 mirror Redroid + android-mcp would let Cipher screenshot any change and visually verify. The mirror is currently down. UI verification falls back to King Kazuma's actual phone/tablet post-deploy.

When the mirror is up, the loop is mandatory: OTA deploy → screenshot the device → analyze (does it match the design target? are cards structured? is hierarchy clear?) → fix → repeat until correct → only THEN report done.

## Two screens that aren't yet in a tab but live in groups

- `/upload` — top-right icon on home, not in a group
- `/backup` — in Me group via GroupNav; reachable from Me tab + GroupNav

## What "Ozzu UI" feels like (the soul)

Linear-inspired dark mode. Progressive disclosure. Dense without clutter. Small in surface area (5 tabs, not 13). Big in capability (each tab is a whole universe). King Kazuma's words on the gold-standard card: "colored left border, big emoji, 2-line description, progress bars, proper padding."

References that informed the direction:
- **Linear** — cards, typography, spacing, status badges (primary visual reference)
- **ServerCat** — infra monitoring, service health (informed Ops tab)
- **Beeper** — unified messaging (no longer relevant; Messages tab is gone)
- **Spotify** (in `music.tsx`) — library → playlist → now-playing flow

## Related principles & memories

- PRINCIPLES § VII.23 (personal data requires biometric)
- Memory: `project_ui_redesign.md`, `feedback_visual_loop_mandatory` (deleted, mirror down)
- Rules: `.claude/rules/frontend.md`, CLAUDE.md § "UI Design Rules"
- Code: `frontend/app/(tabs)/home.tsx` (bottom bar), `frontend/components/GroupNav.tsx`, `frontend/lib/design-tokens.ts`, `frontend/lib/format.ts`
- Drift: `.cipher/layer3/SUMMARY.md`
