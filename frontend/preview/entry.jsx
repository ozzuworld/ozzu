import React from "react";
import { createRoot } from "react-dom/client";

// Screens under test — picked with ?screen= (default: home). Each is mounted
// DIRECTLY (not through app/_layout.tsx), so no native module is pulled in;
// only the stubbed edges wrap them (expo-router, bridge-api, streams, insets,
// ha-context, status-bar). Route params arrive via the preview URL query
// (?slug=false-relay, ?id=SKYLINE-SOC-2026-001).
import HomeScreen from "../app/(tabs)/home";
import WorkScreen from "../app/(tabs)/business";
import SocHomeScreen from "../app/(tabs)/soc";
import SocChainScreen from "../app/soc/chain/[slug]";
import SocFindingsScreen from "../app/soc/findings";
import SocEngagementScreen from "../app/soc/[id]";

const params = new URLSearchParams(location.search);
const screen = params.get("screen") || "home";

const SCREENS = {
  home: HomeScreen,
  work: WorkScreen,
  "soc-home": SocHomeScreen,
  "soc-chain": SocChainScreen,
  "soc-findings": SocFindingsScreen,
  "soc-eng": SocEngagementScreen,
};

const Screen = SCREENS[screen] || HomeScreen;

const root = createRoot(document.getElementById("root"));
root.render(React.createElement(Screen));
