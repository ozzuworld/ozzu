// Preview stub — SSE streams are a no-op; screens render their first fetch.
export const bridgeStream = { subscribe: () => () => {}, connected: false };
export function useBridgeStream() {}
export function useBridgeStreamConnected() { return false; }
