// Minimal expo-router shim for standalone preview: a no-op router + inert
// route components. Search params come from the preview URL (?slug=…, ?id=…)
// so dynamic-route screens (soc/chain/[slug], soc/[id]) render with real args.
function q() {
  try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); }
}
export function useRouter() {
  return {
    push: (r) => { try { console.log("[preview nav]", r); } catch {} },
    replace: () => {},
    navigate: () => {},
    back: () => {},
    setParams: () => {},
    canGoBack: () => true,
  };
}
export function useLocalSearchParams() { return Object.fromEntries(q().entries()); }
export function useGlobalSearchParams() { return Object.fromEntries(q().entries()); }
export function usePathname() { return q().get("path") || "/home"; }
export function useSegments() { return []; }
export const Redirect = () => null;
export const Stack = () => null;
export const Tabs = () => null;
export const Slot = () => null;
export const Link = ({ children }) => children ?? null;
