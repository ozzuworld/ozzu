// Immersive mode state machine for glasses.
// States: idle → activating → immersive → deactivating → idle (+ error)

export type ImmersiveState = "idle" | "activating" | "immersive" | "deactivating" | "error";

type StateListener = (state: ImmersiveState, error?: string) => void;

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class ImmersiveStateMachine {
  private _state: ImmersiveState = "idle";
  private _error: string | undefined;
  private _listeners: StateListener[] = [];
  private _lastActivity = 0;
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _onIdleTimeout: (() => void) | null = null;

  get state(): ImmersiveState {
    return this._state;
  }

  get error(): string | undefined {
    return this._error;
  }

  transition(state: ImmersiveState, error?: string): void {
    if (state === this._state && !error) return;
    this._state = state;
    this._error = error;
    console.log(`[ImmersiveState] ${state}${error ? ` (${error})` : ""}`);

    // Start/stop idle timer
    if (state === "immersive") {
      this._lastActivity = Date.now();
      this._startIdleTimer();
    } else {
      this._stopIdleTimer();
    }

    for (const listener of this._listeners) {
      listener(state, error);
    }
  }

  recordGesture(): void {
    this._lastActivity = Date.now();
    // Reset idle timer
    if (this._state === "immersive") {
      this._startIdleTimer();
    }
  }

  setIdleTimeoutCallback(cb: (() => void) | null): void {
    this._onIdleTimeout = cb;
  }

  subscribe(listener: StateListener): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }

  reset(): void {
    this._stopIdleTimer();
    this._state = "idle";
    this._error = undefined;
    this._lastActivity = 0;
  }

  private _startIdleTimer(): void {
    this._stopIdleTimer();
    this._idleTimer = setTimeout(() => {
      if (this._state === "immersive") {
        this._onIdleTimeout?.();
      }
    }, IDLE_TIMEOUT_MS);
  }

  private _stopIdleTimer(): void {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }
}

// Singleton
export const immersiveState = new ImmersiveStateMachine();
