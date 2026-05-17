# Cipher Layer 3 — Drift Report

Generated: 2026-05-17T17:56:35.264Z
Scanned 8720 files in 3.7s

Cipher: **read this before claiming the codebase is clean.**

## hardcoded-hex-color
*Hex colors hardcoded outside design-tokens.ts (use the design system)*

**292 findings:**

- `frontend/app/(tabs)/music.tsx` — **70** hex literals
- `frontend/app/(tabs)/identity.tsx` — **32** hex literals
- `frontend/app/backup.tsx` — **19** hex literals
- `frontend/app/training.tsx` — **18** hex literals
- `frontend/components/directives/MessageApprovalModal.tsx` — **13** hex literals
- `frontend/app/(tabs)/home.tsx` — **11** hex literals
- `frontend/app/metrics.tsx` — **11** hex literals
- `frontend/app/(tabs)/files.tsx` — **10** hex literals
- `frontend/components/ContentPanel.tsx` — **7** hex literals
- `frontend/components/business/AddExpenseModal.tsx` — **7** hex literals
- `frontend/components/glasses/PhotoCaptureOverlay.tsx` — **7** hex literals
- `frontend/app/upload.tsx` — **6** hex literals
- `frontend/components/business/ExpenseDetailSheet.tsx` — **6** hex literals
- `frontend/components/directives/DirectiveListItem.tsx` — **6** hex literals
- `frontend/components/ops/RouterCard.tsx` — **5** hex literals
- `frontend/app/directive/[id].tsx` — **4** hex literals
- `frontend/app/(tabs)/cipher.tsx` — **3** hex literals
- `frontend/app/(tabs)/finance.tsx` — **3** hex literals
- `frontend/app/glasses.tsx` — **3** hex literals
- `frontend/components/business/AddTaskModal.tsx` — **3** hex literals
- ... +29 more files (292 total)

## duplicated-layout-constants
*Layout constants like TOP_BAR_HEIGHT redefined per screen (move to shared)*

✅ No findings

## duplicated-format-helpers
*Time/format helpers reimplemented per screen (one shared lib should win)*

✅ No findings

## broken-route-references
*router.push() to routes that don't exist*

✅ No findings

## bridge-tmp-path-usage
*Bridge code referencing /tmp/ paths for non-ephemeral content (see intent/cipher.md mount contract)*

**26 findings:**


## broken-menu-references
*HamburgerMenu / shortcut tile entries pointing at deleted screens*

✅ No findings

---

**To fix:** edit code, re-run `scripts/cipher-analyze.sh layer3` to verify.
