# Cipher Layer 3.5 — LLM-judge drift report

Generated: 2026-05-17T16:29:31.257Z
Elapsed: 188.6s
Model: haiku

Cipher: **read this for semantic drift findings** that the regex-based Layer 3 can't see.

## top-bar-reimplementation (warn)
*intent/ui.md — top bars should be a shared component, not reimplemented per screen. PRINCIPLES § VIII.25 — code wins; if the screen does its own top bar, that's drift from intent.*

**9/12 files flagged.**

- **`frontend/app/training.tsx`** — Lines 924-952 reimplement a top bar inline with paddingTop:insets.top, minHeight:layout.topBarHeight, back button, title, and status indicators. Should use a shared TopBar component instead of inline View.
- **`frontend/app/upload.tsx`** — No TopBar or shared header component is imported. The screen calls usePhoneLayout() to access insets (line 67), and uses layout/colors from design tokens, indicating a custom inline top bar is implemented in the truncated JSX (lines not shown). Lines 68–70 show layout and colors are available but no TopBar component is imported, violating the principle that top bars should be shared.
- **`frontend/app/(tabs)/identity.tsx`** — Lines 215–223 define an inline header View with hardcoded paddingTop: 60 (not insets.top) and no fixed height, containing profile name + lock button. This reimplements a top-bar-like pattern inline instead of using a shared component or design-token-based padding.
- **`frontend/app/(tabs)/directives.tsx`** — Lines 214–236 reimplement a top bar inline: View with paddingTop:insets.top, fixed height (insets.top + layout.topBarHeight), title, HamburgerMenu, and border styling. Should use a shared TopBar component instead.
- **`frontend/app/(tabs)/business.tsx`** — Lines 61–80 reimplement a top bar inline with paddingTop:insets.top, height:layout.topBarHeight+insets.top, HamburgerMenu, title text, and StatusBadge — instead of using a shared TopBar component.
- **`frontend/app/(tabs)/cipher.tsx`** — Lines 448-464 reimplement a top bar inline with paddingTop:insets.top, fixed height (48 + insets.top), and containing HamburgerMenu + StatusBadge, instead of using a shared TopBar component
- **`frontend/app/(tabs)/soc.tsx`** — Lines 6–17 reimplement a top bar inline with explicit styling (height: layout.topBarHeight, paddingHorizontal, backgroundColor, borderBottom) instead of using a shared TopBar component. The pattern of HamburgerMenu + title should be extracted into a reusable component.
- **`frontend/app/backup.tsx`** — Screen implements a fixed-height top bar inline within the ~103 hidden lines following the main View's paddingTop:insets.top setup (visible pattern: outer View with insets.top padding, then truncated section containing title/actions with likely height:layout.topBarHeight, rather than importing a shared TopBar component).
- **`frontend/app/(tabs)/finance.tsx`** — Screen imports and uses HamburgerMenu and StatusBadge directly (visible imports) for a top bar implementation instead of using a shared TopBar component; no TopBar import present despite the pattern of combining paddingTop:insets.top with title and control buttons.

## uses-design-tokens (warn)
*intent/ui.md — ALL colors come from design-tokens.ts. PRINCIPLES § VIII.25.*

**6/10 files flagged.**

- **`frontend/app/(tabs)/music.tsx`** — Line 23: const BAR_COLOR = "#FFFFFF" (white UI color); Line 24: const BAR_BG = "rgba(255,255,255,0.1)" (semi-transparent white); Line 62: backgroundColor: "#282828" (dark background); Line 69: backgroundColor: "rgba(255,255,255,0.1)" (duplicate semi-transparent white)
- **`frontend/app/metrics.tsx`** — Line 19: const BORDER = "#222"; — hardcoded hex color literal for border. Should be replaced with colors.gray[800] or appropriate design-token shade.
- **`frontend/components/ContentPanel.tsx`** — Line 27: rgba(10, 10, 20, 0.95) bg color. Line 28: rgba(59, 130, 246, 0.08) headerBg. Line 31: #E2E8F0 textBright. Line 32: #64748B textDim. Line 33: #60A5FA accent. All UI colors in the C object and animation constants (lines 22-24: BURST_COLOR, RAY_COLOR, PARTICLE_COLOR) are hardcoded instead of referenced from colors imported from design-tokens.ts.
- **`frontend/app/training.tsx`** — 8 hardcoded color literals found: (1) MAGENTA = "#EC4899" (line ~47), (2) BORDER = "#151515" (line ~49), (3) DATASET_INFO casia color "#6366F1" (line ~60), (4) DATASET_INFO imdb_wiki/wikidata color "#8B5CF6" (lines ~61, 63), (5) borderBottomColor "#0D0D0D" in styles (line ~1457), (6) sectionTitle color "#262626" (line ~1464). Also: celeba dataset color "#EC4899" (line ~62)
- **`frontend/app/(tabs)/files.tsx`** — Hardcoded hex literal found: color: "#ccc" in filename text styling (visible in otherFiles.map). Should use a color from design-tokens like colors.text.primary or colors.gray[300]
- **`frontend/app/(tabs)/identity.tsx`** — Found 20+ hardcoded hex color literals in StyleSheet. Examples: expiryBadge backgroundColor '#1e293b', tab backgroundColor '#1e293b', tabActive '#4c1d95', card backgroundColor '#1e293b', modalBg '#000', DIRECTION_COLOR transit '#a78bfa', infoLabel color '#64748b', infoValue color '#e2e8f0', travelBody backgroundColor '#1e293b', modalHeader backgroundColor '#0a0a0f'. All should use colors object from design-tokens.ts

## file-matches-intent (warn)
*.cipher/layer2/intent-index.json — every file has a recorded 2-sentence intent. PRINCIPLES § VIII.25 — code wins, but if code drifts past its declared intent, that's a signal the intent (or the code) is stale.*

**7/15 files flagged.**

- **`backend/bridge/routes/osint.js`** — File now includes DELETE /osint/profiles/:id, POST /osint/images/upload with thumbnail generation, and extensive face-crawling/embedding/search endpoints (faceCrawler, face-engine) beyond the recorded intent of just POST/GET profile CRUD.
- **`backend/bridge/routes/directives.js`** — File now includes thread management endpoints (POST /threads/:id/link, /unlink, GET /threads/:id/timeline) with directive-to-thread linking and cross-directive timeline aggregation — new infrastructure not captured in the original directive-lifecycle intent.
- **`backend/bridge/routes/mcp.js`** — File includes significant additions beyond the recorded intent: send_email with account management, get_system_state, check_pipeline, get_service_status, and integration with watchdog/recovery-engine/infra-monitor — turning it into a general system management MCP server rather than a focused directive-management and smart-deployment tool.
- **`backend/bridge/routes/dashboard.js`** — File has grown beyond 'displays system state' to include pipeline violation management (resolve buttons), approval workflows (banner items), detailed activity audit trails (per-actor badge tracking), CI build status polling/integration, and interactive controls — now covers operational management and workflow control, not just monitoring display.
- **`backend/bridge/routes/cipher.js`** — File includes action queue management endpoints (POST /cipher/actions/ack, DELETE /cipher/actions/), state/situation briefing endpoint (GET /cipher/state), and proactive reporter endpoints not described in recorded intent—scope extends beyond conversation history and metadata retrieval.
- **`backend/bridge/routes/pipeline.js`** — File contains additional endpoints for pipeline violation tracking (POST /api/pipeline-violations) and build status fetching (GET /api/build-status) not mentioned in the recorded intent.
- **`backend/bridge/routes/business.js`** — File has grown to include substantial receipt/invoice extraction and financial data parsing (extractReceiptWithGemini, line-item extraction, IVA calculation) beyond the stated intent of document verification against task requirements; also supports both Gemini and Anthropic APIs, not just Gemini.

## screen-anti-slop (warn)
*intent/ui.md anti-slop rules: (1) one focal point, (2) visual hierarchy (size+weight+color contrast for different info levels), (3) structured cards (header row + content + metadata, not just text), (4) interactive feedback on pressables (scale/opacity).*

**10/10 files flagged.**

- **`frontend/app/training.tsx`** — Rule 1: Multiple competing sections (datasets, training stats, Qdrant, topology) with no dominant focal point. Rule 2: All typography is tiny monospace (9-10px) with minimal size/weight/color differentiation — no visual hierarchy. Rule 3: Info rows are plain text containers without card structure — missing header row (icon+title+status), content area, metadata row. Rule 4: No Pressable feedback animations visible — no opacity or scale transforms on interactive elements.
- **`frontend/app/(tabs)/files.tsx`** — Rule 1: Multiple action buttons (New Folder, Pick Photos, Pick File) compete for attention instead of one focal point — the file list should dominate the screen. Rule 3: File/folder items lack structured metadata styling — size and date are appended plain text ("📎 · 3 days ago") rather than styled pills or badges as shown in ProjectCard reference.
- **`frontend/app/metrics.tsx`** — Rule 1: Dashboard has 4+ metric sections competing with equal visual weight—no focal point. Rule 2: MetricRow label and value are identical fontSize/fontWeight, differing only in color—no hierarchy. Rule 3: StatCard is exactly 'text on background'—value and label only, no icon/header row/metadata row/structure.
- **`frontend/app/(tabs)/identity.tsx`** — Rule 2: Info cards use 13px for title, labels, and values — no size differentiation, hierarchy relies only on color/weight. Rule 3: Cards lack proper structure; they're just title + label/value pairs with no header row (icon + title + status) or metadata row (pills, badges). Rule 4: No Pressable elements show opacity or scale transforms on press — tabs, document cards, and buttons have no interactive feedback styling.
- **`frontend/app/(tabs)/directives.tsx`** — Rule 4 violated: Pressable directive cards have no opacity change or scale animation on press—they're static with no onPress feedback styling (no transform:[{scale}] or opacity change).
- **`frontend/app/(tabs)/music.tsx`** — Rule 4 (Pressable Feedback): MiniPlayer main container (line 93) lacks opacity or scale feedback on press — the style prop does not use ({ pressed }) callback, so tapping provides zero visual feedback.
- **`frontend/app/(tabs)/cipher.tsx`** — Rule 4: The primary circular mic button (Pressable) has no opacity change or scale animation on press — the style object is static and doesn't handle pressed state.
- **`frontend/app/upload.tsx`** — Rule 1: Two equal-weight send buttons (flex:1, same padding) at bottom compete for focal point instead of one being primary. Rule 3: File list items are text + size + delete icon on a slightly darker background with no card structure (no header row, no content/metadata separation). Rule 4: Send buttons and other pressables show no transform or opacity feedback on press—only disabled-state opacity styling.
- **`frontend/app/(tabs)/home.tsx`** — Rule 4: Tab bar Pressables lack opacity or scale animation on press; no activeOpacity, pressedStyle, or transform feedback defined.
- **`frontend/app/(tabs)/finance.tsx`** — Rule 3: Transaction rows are flat list items (emoji + text + amount with a border) — no card structure with container, header row, content area, or metadata row. Rule 1: Screen shows multiple competing data sections (balance summary, bar chart, transaction list) without clear visual hierarchy or one focal point.

---

Run again: `node .cipher/bin/llm-judge.js [--rule NAME] [--files A B]`
