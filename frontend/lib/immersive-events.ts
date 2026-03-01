// Shared callback module for glasses immersive mode.
// Lets bridge-session trigger navigation from any screen.

type ImmersiveCallback = (enable: boolean) => void;

let callback: ImmersiveCallback | null = null;

export function setImmersiveCallback(cb: ImmersiveCallback | null): void {
  callback = cb;
}

export function triggerImmersive(enable: boolean): void {
  callback?.(enable);
}
