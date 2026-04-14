import { useState, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { fetchPendingApprovals, type ApprovalRequest } from "../lib/bridge-api";
import { MessageApprovalModal } from "./directives/MessageApprovalModal";

const POLL_INTERVAL = 3000;

export function GlobalApprovalGate() {
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const lastSeenId = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        const approvals = await fetchPendingApprovals();
        const pending = approvals.find(
          (a) => a.type === "message_send" && !a.resolved && a.id !== lastSeenId.current
        );
        if (pending) {
          setApproval(pending);
          lastSeenId.current = pending.id;
        }
      } catch {}
    };

    poll();
    timerRef.current = setInterval(poll, POLL_INTERVAL);

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") poll();
    });

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      sub.remove();
    };
  }, []);

  return (
    <MessageApprovalModal
      visible={approval !== null}
      approval={approval}
      onDismiss={() => setApproval(null)}
      onResolved={() => setApproval(null)}
    />
  );
}
