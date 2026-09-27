// Preview stub — Home Assistant is decommissioned; StatusBadge reads only
// connection-ish state from this context.
export function useHA() { return { entities: {}, connected: false, status: "preview" }; }
export function useEntity() { return undefined; }
export function usePosition() { return undefined; }
export function HAProvider({ children }) { return children ?? null; }
export default HAProvider;
