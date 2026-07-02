// Minimal expo-router shim for standalone preview: a no-op router + inert
// route components, enough for any single screen that only calls useRouter().
export function useRouter() {
  return {
    push: (r) => { try { console.log("[preview nav]", r); } catch {} },
    replace: () => {},
    navigate: () => {},
    back: () => {},
    setParams: () => {},
  };
}
export function useLocalSearchParams() { return {}; }
export function useGlobalSearchParams() { return {}; }
export function usePathname() { return "/home"; }
export function useSegments() { return []; }
export const Redirect = () => null;
export const Stack = () => null;
export const Tabs = () => null;
export const Slot = () => null;
export const Link = ({ children }) => children ?? null;
