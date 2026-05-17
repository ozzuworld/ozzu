# Cipher Layer 1 — Codebase Map Summary

Generated: 2026-05-17T13:57:55.140Z

Cipher: **read this first** before answering questions about the codebase.
Raw outputs live in `.cipher/layer1/` next to this file.

## Repo map (`repomap.txt`)
- Size: 1911 KB
- Generated: 2026-05-17T13:57:19.205Z
- Use: pass to LLM context when you need to grep across the whole repo at once

## Dead code (knip)

### Frontend
- **Orphan files (zero imports):** 0
- **Unused symbols across 29 files:** 11 dependencies, 127 exports, 76 types

### Backend bridge
- **Orphan files (zero imports):** 5
```
  correlation-engine.js
  face-search-scraper.js
  kairos-identity-resolve.js
  kairos-osint-enrich.js
  osint-report.js
```
- **Unused symbols across 34 files:** 2 dependencies, 5 unresolved, 212 exports

## Import graph (dependency-cruiser)

### Frontend
- Modules cruised: 116
- Dependencies: 442
- Rule violations: 0 (warn=0, error=0)
- **Most-imported modules (top 10):**
```
   67 ← react-native
   58 ← react
   43 ← lib/bridge-api.ts
   17 ← expo-router
   16 ← lib/design-tokens.ts
   13 ← lib/usePhoneLayout.ts
   12 ← expo-status-bar
   12 ← components/GroupNav.tsx
   10 ← react-native-safe-area-context
    9 ← components/business/CostField.tsx
```
- **Orphan modules (no dependents, not entry):** 17
```
  app/(tabs)/business.tsx
  app/(tabs)/cipher.tsx
  app/(tabs)/directives.tsx
  app/(tabs)/files.tsx
  app/(tabs)/finance.tsx
  app/(tabs)/home.tsx
  app/(tabs)/identity.tsx
  app/(tabs)/music.tsx
  app/(tabs)/ops.tsx
  app/(tabs)/soc.tsx
  app/backup.tsx
  app/directive/[id].tsx
  app/glasses.tsx
  app/metrics.tsx
  app/soc/[id].tsx
  ... +2 more
```

### Backend bridge
- Modules cruised: 180
- Dependencies: 425
- Rule violations: 2 (warn=2, error=0)
- **Most-imported modules (top 10):**
```
   42 ← fs
   33 ← db.js
   27 ← child_process
   27 ← path
   18 ← http
   18 ← crypto
   14 ← osint-cli-runner.js
   14 ← osint-modules/co-utils.js
   11 ← https
    6 ← util
```

## Copy-paste duplication (jscpd)

- Total clones: 126
- Duplicated lines: 1648 / 65344 (2.52%)
- Duplicated tokens: 18335 / 672241

**Top duplications (first 10):**

1. `backend/bridge/routes/soc.js` ↔ `backend/bridge/routes/soc.js` (12 lines)
2. `backend/bridge/routes/pipeline.js` ↔ `backend/bridge/routes/pipeline.js` (11 lines)
3. `backend/bridge/routes/pipeline.js` ↔ `backend/bridge/routes/pipeline.js` (20 lines)
4. `backend/bridge/routes/pipeline.js` ↔ `backend/bridge/routes/pipeline.js` (20 lines)
5. `backend/bridge/routes/pipeline.js` ↔ `backend/bridge/routes/pipeline.js` (18 lines)
6. `backend/bridge/routes/ops.js` ↔ `backend/bridge/routes/vault.js` (12 lines)
7. `backend/bridge/routes/influence.js` ↔ `backend/bridge/routes/influence.js` (10 lines)
8. `backend/bridge/routes/influence.js` ↔ `backend/bridge/routes/influence.js` (10 lines)
9. `backend/bridge/routes/cedula.js` ↔ `backend/bridge/routes/cedula.js` (9 lines)
10. `backend/bridge/routes/business.js` ↔ `backend/bridge/routes/business.js` (31 lines)

---

**Next steps:**
- Layer 2 (intent index): not yet implemented — see `scripts/cipher-analyze.sh layer2`
- Layer 3 (drift checks): not yet implemented — see `scripts/cipher-analyze.sh layer3`
