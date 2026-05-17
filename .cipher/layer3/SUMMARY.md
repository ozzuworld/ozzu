# Cipher Layer 3 — Drift Report

Generated: 2026-05-17T13:40:59.157Z
Scanned 8757 files in 3.8s

Cipher: **read this before claiming the codebase is clean.**

## hardcoded-hex-color
*Hex colors hardcoded outside design-tokens.ts (use the design system)*

**1548 findings:**

- `frontend/components/business/TaskDetailSheet.tsx` — **79** hex literals
- `frontend/app/(tabs)/music.tsx` — **71** hex literals
- `frontend/app/metrics.tsx` — **67** hex literals
- `frontend/app/training.tsx` — **57** hex literals
- `frontend/components/directives/DirectiveCard.tsx` — **55** hex literals
- `frontend/components/business/AddExpenseModal.tsx` — **53** hex literals
- `frontend/components/business/AddTaskModal.tsx` — **48** hex literals
- `frontend/components/business/ExpenseDetailSheet.tsx` — **48** hex literals
- `frontend/app/(tabs)/identity.tsx` — **47** hex literals
- `frontend/components/glasses/SettingsSheet.tsx` — **47** hex literals
- `frontend/app/upload.tsx` — **44** hex literals
- `frontend/components/business/ProjectDetailSheet.tsx` — **44** hex literals
- `frontend/components/business/FinancialSummaryCard.tsx` — **39** hex literals
- `frontend/app/(tabs)/finance.tsx` — **38** hex literals
- `frontend/components/business/DashboardView.tsx` — **33** hex literals
- `frontend/components/business/AddProjectModal.tsx` — **32** hex literals
- `frontend/components/home/HomeMap3D.tsx` — **30** hex literals
- `frontend/app/(tabs)/files.tsx` — **29** hex literals
- `frontend/components/business/ShipmentDetailSheet.tsx` — **28** hex literals
- `frontend/app/backup.tsx` — **26** hex literals
- ... +63 more files (1548 total)

## duplicated-layout-constants
*Layout constants like TOP_BAR_HEIGHT redefined per screen (move to shared)*

**1 findings:**

- **`TOP_BAR_HEIGHT`** defined 8× in:
  - frontend/app/(tabs)/business.tsx:17 (= 48)
  - frontend/app/(tabs)/directives.tsx:45 (= 48)
  - frontend/app/(tabs)/finance.tsx:15 (= 48)
  - frontend/app/(tabs)/music.tsx:30 (= 48)
  - frontend/app/(tabs)/soc.tsx:18 (= 48)
  - frontend/app/metrics.tsx:17 (= 48)
  - frontend/app/training.tsx:46 (= 52)
  - frontend/app/upload.tsx:13 (= 48)

## duplicated-format-helpers
*Time/format helpers reimplemented per screen (one shared lib should win)*

**5 findings:**

- **`formatBytes`** defined 2× in:
  - frontend/app/(tabs)/files.tsx:52
  - frontend/components/ops/InfraDeviceCard.tsx:19
- **`formatDate`** defined 3× in:
  - frontend/app/(tabs)/files.tsx:59
  - frontend/app/(tabs)/finance.tsx:60
  - frontend/app/(tabs)/identity.tsx:98
- **`formatCOP`** defined 2× in:
  - frontend/app/(tabs)/finance.tsx:54
  - frontend/lib/bridge-api.ts:1740
- **`formatTime`** defined 2× in:
  - frontend/app/(tabs)/music.tsx:70
  - frontend/components/ops/ServiceCard.tsx:36
- **`formatDuration`** defined 2× in:
  - frontend/app/(tabs)/music.tsx:77
  - frontend/app/metrics.tsx:37

## broken-route-references
*router.push() to routes that don't exist*

✅ No findings

## broken-menu-references
*HamburgerMenu / shortcut tile entries pointing at deleted screens*

✅ No findings

---

**To fix:** edit code, re-run `scripts/cipher-analyze.sh layer3` to verify.
