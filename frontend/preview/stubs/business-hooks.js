// Sample ventures — home only reads `projects` + counts active ones.
export function useBusiness() {
  return {
    projects: [
      { id: 1, status: "active", name: "Influence", emoji: "📈" },
      { id: 2, status: "active", name: "SOC red-team consulting", emoji: "🔐" },
      { id: 3, status: "active", name: "Ozzu platform", emoji: "🧠" },
      { id: 4, status: "paused", name: "Gecko recon robot", emoji: "🦎" },
    ],
  };
}

export default useBusiness;
