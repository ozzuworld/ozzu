// safe — coerce a value to a renderable string.
// Prevents the literal text "undefined" / "null" from leaking into Text
// children when a backend field is missing. Use everywhere we interpolate
// or display engagement fields that the schema allows to be null.

export function safe(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return String(value);
  } catch {
    return fallback;
  }
}
