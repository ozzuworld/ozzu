// Jobs display helpers (dir_1785424018953) — salary, posted-ago, source + role styling.
// Shared by JobCard and the Empleos screen. Mirrors secop-format.ts.
import { colors } from "./design-tokens";

export function toNum(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : 0;
}

// Compact salary: annual "$140k" / range "$120–160k"; hourly "$50/h". null when unknown.
export function formatSalary(
  min: number | string | null | undefined,
  max: number | string | null | undefined,
  currency?: string | null,
  period?: string | null
): string | null {
  const lo = toNum(min), hi = toNum(max);
  if (!lo && !hi) return null;
  const sym = currency === "EUR" ? "€" : currency === "GBP" ? "£" : "$";
  const per = period === "hourly" ? "/h" : "";
  const k = (n: number) =>
    period === "hourly" ? String(Math.round(n)) : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
  if (lo && hi && lo !== hi) return `${sym}${k(lo)}–${k(hi)}${per}`;
  return `${sym}${k(hi || lo)}${per}`;
}

// "hoy" | "ayer" | "hace 3d" | "hace 2sem" | "hace 1mes"
export function postedAgo(dateStr?: string | null): string | null {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 14) return `hace ${days}d`;
  if (days < 60) return `hace ${Math.floor(days / 7)}sem`;
  return `hace ${Math.floor(days / 30)}mes`;
}

export const SOURCE_STYLE: Record<string, { label: string; color: string }> = {
  himalayas: { label: "Himalayas", color: colors.brand.purple },
  remoteok: { label: "RemoteOK", color: colors.brand.orange },
};
export function sourceStyle(source?: string | null): { label: string; color: string } {
  return (source && SOURCE_STYLE[source]) || { label: source || "—", color: colors.text.tertiary };
}

// Role emoji inferred from title/tags/skills — gives each card a visual identity.
export function roleEmoji(title?: string | null, tags?: string[] | null, skills?: string[] | null): string {
  const hay = [title || "", ...(tags || []), ...(skills || [])].join(" ").toLowerCase();
  if (/security|pentest|infosec|appsec|\bsoc\b|cyber|malware/.test(hay)) return "🛡️";
  if (/devops|\bsre\b|infrastructure|platform|kubernetes|terraform|\bcloud\b/.test(hay)) return "⚙️";
  if (/react native|android|\bios\b|mobile|flutter/.test(hay)) return "📱";
  if (/\bai\b|\bml\b|machine learning|\bllm\b|data scien|genai|generative/.test(hay)) return "🤖";
  if (/front.?end|react|vue|svelte/.test(hay)) return "🎨";
  if (/back.?end|\bapi\b|node|python|golang|\bgo\b|rust|database/.test(hay)) return "🧩";
  return "💻";
}

// Left-border accent: LatAm-reachable = cyan (his lane), otherwise the source color.
export function accentFor(latam: boolean, source?: string | null): string {
  return latam ? colors.accent : sourceStyle(source).color;
}
