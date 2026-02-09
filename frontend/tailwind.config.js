/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        rarity: {
          legendary: "#F59E0B",
          "legendary-dim": "rgba(245,158,11,0.06)",
          epic: "#A855F7",
          "epic-dim": "rgba(168,85,247,0.06)",
          rare: "#3B82F6",
          "rare-dim": "rgba(59,130,246,0.06)",
          common: "#525252",
          "common-dim": "rgba(82,82,82,0.06)",
        },
        slot: {
          bg: "#1A1A1A",
          "bg-hover": "#222222",
        },
      },
    },
  },
  plugins: [],
};
