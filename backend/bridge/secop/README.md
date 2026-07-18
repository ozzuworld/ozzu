# SECOP II — Licitaciones ingester + UNSPSC index + category overlay

Ingests Colombian public-procurement **opportunities** (SECOP II / Colombia Compra
Eficiente) into postgres, indexes them, and categorizes them — so you can browse and
search the government contracts that are **currently open to bid on**.

Built under directive `dir_1784390326425`.

## 1. Purpose

Answer "which public tenders can we bid on right now, and which are relevant to us?"
without touching the slow SECOP II web portal. Pulls the open-opportunity feed, keeps a
deduped postgres index refreshed on a schedule, tags each with its canonical UNSPSC
category **and** a tunable Skyline overlay (redes/telecom/TI/seguridad/…).

## 2. Architecture

```
datos.gov.co (Socrata SODA API, dataset p6dx-8zbt)
        │  https GET, paginated ($where + $limit/$offset), no auth
        ▼
secop/ingest.js ── buildRecord() ── secop/categories.js (UNSPSC + overlay)
        │  upsert on id_del_proceso (dedupes multi-lote/phase rows)
        ▼
postgres: secop_licitaciones  (+ secop_categories ref, secop_ingest_runs log)
        │  GIN full-text (spanish) + btree indexes
        ▼
routes/secop.js  ──  GET /secop/{stats,categories,licitaciones,licitaciones/:id}
        ▼
Ozzu app (future SECOP tab)
```

- `unspsc.json` — UNSPSC segment (2-digit) → readable Spanish name. The **canonical** taxonomy SECOP already tags every process with (`codigo_principal_de_categoria`, format `V1.NNNNNNNN`).
- `overlay.json` — **tunable** "relevant-to-us" categories. Matched by UNSPSC segment/family OR keyword (accent/case-insensitive) in entity+name+description. Edit freely; re-run `--recategorize`.
- `categories.js` — pure derivation (`deriveCategory(row)`), no I/O.
- `schema.js` — table DDL, reference seeding, and all query helpers (list/browse/stats/upsert).
- `ingest.js` — Socrata pull + upsert + close-expired; runnable standalone or in-process.

## 3. Data source

- Portal: `https://www.datos.gov.co/resource/p6dx-8zbt.json` ("SECOP II - Procesos de Contratación", ~8.8M rows all-time).
- **Scope ingested:** competitive, biddable modalities (Licitación Pública ×3 + Selección Abreviada ×3 + Concurso de Méritos ×2 + Mínima Cuantía) whose **offer deadline (`fecha_de_recepcion_de`) has not passed** → ~2.5K live rows.
- No API key required. Optional `SOCRATA_APP_TOKEN` raises rate limits.

## 4. Configuration (env, all optional)

| Var | Default | Meaning |
|---|---|---|
| `SECOP_DATASET` | `p6dx-8zbt` | Socrata dataset id |
| `SECOP_MODALITIES` | (9 competitive modalities) | `\|`-separated include-list |
| `SECOP_PAGE_SIZE` | `1000` | rows per Socrata page |
| `SECOP_MAX_PAGES` | `50` | safety cap |
| `SOCRATA_APP_TOKEN` | — | optional, higher rate limit |

Tune **categories** by editing `overlay.json` (add categories / keywords / UNSPSC codes),
then `POST /secop/recategorize` or `./scripts/secop-ingest.sh --recategorize` — no re-fetch.

## 5. Deployment

- Code is bind-mounted (`/home/gcp/ozzu/backend/bridge → /app`), so no rebuild needed.
- Tables auto-create on bridge boot (`db.js init()` calls `ensureSchema`) or on first ingest.
- Routes go live after `merge-and-deploy` → bridge restart (smartDeploy waits 60s).

## 6. Operation

| Need | Command |
|---|---|
| Full refresh (cron-safe) | `./scripts/secop-ingest.sh` |
| Re-apply overlay changes only | `./scripts/secop-ingest.sh --recategorize` |
| Direct (in container) | `docker exec bridge node /app/secop/ingest.js [--dry-run\|--recategorize]` |
| On-demand via API | `POST /secop/ingest` (202, runs in background) |
| Cron (every 6h) | `0 */6 * * * /home/gcp/ozzu/scripts/secop-ingest.sh` |

## 7. API

| Endpoint | Purpose |
|---|---|
| `GET /secop/stats` | open count, total value, top departamentos, last ingest run |
| `GET /secop/categories[?all=true]` | UNSPSC segments + overlay tags, with counts & value |
| `GET /secop/licitaciones` | list/search — filters below |
| `GET /secop/licitaciones/:id` | full record (raw SECOP row included) |
| `POST /secop/ingest` | refresh in background |
| `POST /secop/recategorize` | re-apply taxonomy in background |

`/secop/licitaciones` query params: `segment` (UNSPSC 2-digit), `overlay` (tag name),
`modalidad`, `departamento`, `entidad` (ILIKE), `q` (Spanish full-text over
entity+name+description), `min_value`/`max_value`, `sort`
(`deadline`|`newest`|`value_desc`|`value_asc`|`seen`), `limit` (≤200), `offset`,
`all=true` (include closed).

## 8. Troubleshooting

- **HTTP 000 / timeout to datos.gov.co** — the first call to a cold Socrata endpoint can be slow; general egress is fine (verify: `curl -sI https://www.datos.gov.co`). Retry.
- **Fewer open rows than fetched** — expected: `id_del_proceso` dedupes multi-lote/phase rows, and `closeExpired` flips rows whose deadline just passed to `is_open=false`.
- **`SECOP schema ensure failed`** in bridge log — check postgres is up; schema is idempotent, safe to re-run.
- **New keyword not matching** — keywords are compared accent/case-folded; write them unaccented & lowercase in `overlay.json`, then `--recategorize`.

## 9. Limits

- Only ingests **currently-open** opportunities by default — not historical/closed (change `SECOP_MODALITIES` + drop the deadline filter in `ingest.js` for full history).
- UNSPSC categorization is **segment-level** (top category) + raw family code; sub-family names are not mapped.
- `precio_base` is the estimated base value, not the awarded value.
- No semantic (vector) search yet — full-text only. Qdrant embedding of descriptions is a natural future add.
