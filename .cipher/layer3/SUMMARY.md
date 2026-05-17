# Cipher Layer 3 — Drift Report

Generated: 2026-05-17T13:57:06.410Z
Scanned 8717 files in 0.4s

Cipher: **read this before claiming the codebase is clean.**

## hardcoded-hex-color
*Hex colors hardcoded outside design-tokens.ts (use the design system)*

**1193 findings:**

- `frontend/components/business/TaskDetailSheet.tsx` — **79** hex literals
- `frontend/app/(tabs)/music.tsx` — **71** hex literals
- `frontend/app/metrics.tsx` — **67** hex literals
- `frontend/app/training.tsx` — **57** hex literals
- `frontend/components/business/AddExpenseModal.tsx` — **53** hex literals
- `frontend/components/business/AddTaskModal.tsx` — **48** hex literals
- `frontend/components/business/ExpenseDetailSheet.tsx` — **48** hex literals
- `frontend/app/(tabs)/identity.tsx` — **47** hex literals
- `frontend/app/upload.tsx` — **44** hex literals
- `frontend/components/business/ProjectDetailSheet.tsx` — **44** hex literals
- `frontend/components/business/FinancialSummaryCard.tsx` — **39** hex literals
- `frontend/app/(tabs)/finance.tsx` — **38** hex literals
- `frontend/components/business/DashboardView.tsx` — **33** hex literals
- `frontend/components/business/AddProjectModal.tsx` — **32** hex literals
- `frontend/app/(tabs)/files.tsx` — **29** hex literals
- `frontend/components/business/ShipmentDetailSheet.tsx` — **28** hex literals
- `frontend/app/backup.tsx` — **26** hex literals
- `frontend/components/business/AddShipmentModal.tsx` — **23** hex literals
- `frontend/components/business/ContactDetailSheet.tsx` — **23** hex literals
- `frontend/components/business/TaskCard.tsx` — **23** hex literals
- ... +36 more files (1193 total)

## duplicated-layout-constants
*Layout constants like TOP_BAR_HEIGHT redefined per screen (move to shared)*

✅ No findings

## duplicated-format-helpers
*Time/format helpers reimplemented per screen (one shared lib should win)*

**3 findings:**

- **`formatDate`** defined 3× in:
  - frontend/app/(tabs)/files.tsx:53
  - frontend/app/(tabs)/finance.tsx:54
  - frontend/app/(tabs)/identity.tsx:98
- **`formatTime`** defined 2× in:
  - frontend/app/(tabs)/music.tsx:70
  - frontend/components/ops/ServiceCard.tsx:36
- **`formatDuration`** defined 2× in:
  - frontend/app/(tabs)/music.tsx:77
  - frontend/app/metrics.tsx:36

## broken-route-references
*router.push() to routes that don't exist*

✅ No findings

## broken-menu-references
*HamburgerMenu / shortcut tile entries pointing at deleted screens*

✅ No findings

---

**To fix:** edit code, re-run `scripts/cipher-analyze.sh layer3` to verify.
