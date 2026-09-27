// Findings moved INTO the SOC screen as a sub-tab (ventures-style UI, KK order
// 2026-09-27). This route survives only so old deep links land on the board.

import { Redirect, useLocalSearchParams } from "expo-router";

export default function FindingsRedirect() {
  const { lifecycle, severity } = useLocalSearchParams<{ lifecycle?: string; severity?: string }>();
  const params: Record<string, string> = { tab: "findings" };
  if (severity) params.severity = severity;
  if (lifecycle) params.lifecycle = lifecycle;
  return <Redirect href={{ pathname: "/soc", params }} />;
}
