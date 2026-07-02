// voip-handoff.ts — one-shot signal from the screening gate (useCallBriefing) to the
// WebRTC leg (useWebrtcCall). When King Kazuma taps Accept on a briefing, we ARM
// auto-answer so the transfer INVITE that arrives moments later connects in a single tap
// instead of ringing a second time. Auto-disarms after a short window so a failed transfer
// can never make a later, unrelated call auto-answer.

let armed = false;
let disarmTimer: ReturnType<typeof setTimeout> | null = null;

// Wide enough to survive June's closing line + up to 8s jitter-buffer drain + Gemini
// latency before the transfer INVITE lands; short enough that a failed transfer can't
// auto-answer a much-later, unrelated call.
const DISARM_MS = 45000;

export function armAutoAnswer() {
  armed = true;
  if (disarmTimer) clearTimeout(disarmTimer);
  disarmTimer = setTimeout(() => {
    armed = false;
    disarmTimer = null;
  }, DISARM_MS);
}

// Read-and-clear: returns whether auto-answer was armed, then disarms.
export function consumeAutoAnswer(): boolean {
  const was = armed;
  armed = false;
  if (disarmTimer) {
    clearTimeout(disarmTimer);
    disarmTimer = null;
  }
  return was;
}
