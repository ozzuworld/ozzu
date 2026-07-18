"use strict";

// Turn a SECOP licitación into a Skyline venture ("our format"): a pre-filled
// business_project + a bid pipeline of business_tasks whose due dates are computed
// backward from the offer deadline (fecha_recepcion). Pure builder + a persist helper.

// Overlay category -> venture emoji/color (matches overlay.json).
const OVERLAY_STYLE = {
  "Desarrollo de Software": { emoji: "💻", color: "#3B82F6" },
  "Servicios y Soporte TI": { emoji: "🛠️", color: "#06B6D4" },
  Ciberseguridad: { emoji: "🛡️", color: "#EF4444" },
  "Datos e Inteligencia Artificial": { emoji: "📊", color: "#A855F7" },
};
const DEFAULT_STYLE = { emoji: "📋", color: "#06B6D4" };

// Bid pipeline. offset = days relative to the offer deadline (negative = before).
const PIPELINE = [
  { phase: "Análisis", title: "Revisión de pliegos y requisitos", priority: "high", offset: -14 },
  { phase: "Análisis", title: "Decisión Go / No-Go", priority: "high", offset: -10 },
  { phase: "Preparación", title: "Reunir requisitos habilitantes (RUP, experiencia, capacidad financiera)", priority: "medium", offset: -7 },
  { phase: "Preparación", title: "Tramitar garantía de seriedad de la oferta", priority: "medium", offset: -5 },
  { phase: "Preparación", title: "Elaborar propuesta técnica", priority: "high", offset: -3 },
  { phase: "Preparación", title: "Elaborar propuesta económica", priority: "high", offset: -2 },
  { phase: "Presentación", title: "Enviar oferta en SECOP II", priority: "high", offset: 0 },
  { phase: "Resultado", title: "Seguimiento a evaluación y adjudicación", priority: "medium", offset: 30 },
];

function truncate(s, n) {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Normalize a Date | ISO-string to "YYYY-MM-DD" (pg returns TIMESTAMPTZ as a Date).
function ymd(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

// deadline (Date | ISO string) + offsetDays -> "YYYY-MM-DD" (or null if no deadline).
function dueFrom(deadline, offsetDays) {
  if (!deadline) return null;
  const d = deadline instanceof Date ? new Date(deadline.getTime()) : new Date(deadline);
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function styleFor(lic) {
  const first = (lic.overlay_categories || [])[0];
  return OVERLAY_STYLE[first] || DEFAULT_STYLE;
}

// Build the venture plan (no DB). lic is a secop_licitaciones row.
function buildVenturePlan(lic) {
  const style = styleFor(lic);
  const deadline = lic.fecha_recepcion || null;
  const url = lic.url_proceso || null;

  const descParts = [
    `${lic.modalidad || "Licitación"} · ${lic.entidad || "Entidad"}${lic.departamento ? " (" + lic.departamento + ")" : ""}`,
    lic.descripcion ? truncate(lic.descripcion, 240) : truncate(lic.nombre, 240),
  ];
  if (lic.referencia) descParts.push(`Ref: ${lic.referencia}`);
  if (url) descParts.push(url);

  const project = {
    name: truncate(`${lic.entidad || "SECOP"} — ${lic.nombre || lic.referencia || lic.id_proceso}`, 90),
    description: descParts.filter(Boolean).join("\n"),
    emoji: style.emoji,
    color: style.color,
    budget: lic.precio_base != null ? Number(lic.precio_base) : null,
  };

  const tasks = PIPELINE.map((step) => {
    const t = {
      title: step.title,
      phase: step.phase,
      priority: step.priority,
      due_date: dueFrom(deadline, step.offset),
      notes: "",
    };
    if (step.offset === -14 && url) t.notes = `Pliegos y detalle: ${url}`;
    if (step.offset === 0 && deadline) t.notes = `Fecha límite de recepción de ofertas: ${ymd(deadline)}`;
    return t;
  });

  return { secop_id: lic.id_proceso, project, tasks };
}

// Persist the plan. `db` is the bridge db.js module (has createBusinessProject,
// createBusinessTask, query). Dedups by secop_id.
async function createVentureFromLicitacion(db, lic) {
  const existing = await db.query(
    `SELECT id FROM business_projects WHERE secop_id = $1 AND status <> 'archived' LIMIT 1`,
    [lic.id_proceso]
  );
  if (existing.rows.length) {
    return { created: false, venture_id: existing.rows[0].id };
  }

  const plan = buildVenturePlan(lic);
  const proj = await db.createBusinessProject({
    name: plan.project.name,
    description: plan.project.description,
    emoji: plan.project.emoji,
    color: plan.project.color,
  });
  await db.query(
    `UPDATE business_projects SET secop_id = $1, budget = $2, currency = 'COP', updated_at = NOW() WHERE id = $3`,
    [plan.secop_id, plan.project.budget, proj.id]
  );
  for (const t of plan.tasks) {
    await db.createBusinessTask({ project_id: proj.id, ...t });
  }
  return { created: true, venture_id: proj.id, task_count: plan.tasks.length };
}

module.exports = { buildVenturePlan, createVentureFromLicitacion, PIPELINE, OVERLAY_STYLE };
