// SECOP display helpers — deadline countdown + category (overlay) styling.
// Shared by LicitacionCard and LicitacionDetailSheet.
import { colors } from "./design-tokens";

export const OVERLAY_STYLE: Record<string, { emoji: string; color: string }> = {
  "Desarrollo de Software": { emoji: "💻", color: colors.brand.blue },
  "Servicios y Soporte TI": { emoji: "🛠️", color: colors.accent },
  Ciberseguridad: { emoji: "🛡️", color: colors.error },
  "Datos e Inteligencia Artificial": { emoji: "📊", color: colors.brand.purple },
};
const DEFAULT_STYLE = { emoji: "📋", color: colors.accent };

export function categoryStyle(overlay?: string[] | null): { emoji: string; color: string } {
  const first = overlay && overlay[0];
  return (first && OVERLAY_STYLE[first]) || DEFAULT_STYLE;
}

export function daysUntil(dateStr?: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

// Deadline pill label + urgency color.
export function deadlineInfo(dateStr?: string | null): { label: string; color: string; days: number | null } {
  const days = daysUntil(dateStr);
  if (days === null) return { label: "sin fecha", color: colors.text.tertiary, days };
  if (days < 0) return { label: "vencida", color: colors.text.disabled, days };
  if (days === 0) return { label: "cierra hoy", color: colors.error, days };
  if (days === 1) return { label: "cierra mañana", color: colors.error, days };
  const color = days <= 3 ? colors.error : days <= 7 ? colors.brand.amber : colors.text.secondary;
  return { label: `cierra en ${days}d`, color, days };
}

export function toNum(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : 0;
}
