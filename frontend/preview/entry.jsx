import React from "react";
import { createRoot } from "react-dom/client";

// The real screen under test. Mounted directly (NOT through app/_layout.tsx),
// so none of the 9 native modules are pulled in — home.tsx only needs the
// stubbed edges (router, status-bar, data hooks, phone insets).
import HomeScreen from "../app/(tabs)/home";

const root = createRoot(document.getElementById("root"));
root.render(React.createElement(HomeScreen));
