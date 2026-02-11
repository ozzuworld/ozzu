// Gemini function declarations for Command Bridge — Claude Code status & approvals

export const BRIDGE_FUNCTION_DECLARATIONS = [
  {
    name: "get_dev_status",
    description:
      "Get the latest development activity from Claude Code. " +
      "Returns recent tool uses, file edits, and session events.",
    parameters: {
      type: "OBJECT" as any,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_pending_approvals",
    description:
      "Check if Claude Code has any pending approval requests. " +
      "These are dangerous actions (force push, delete branch, etc.) that need user authorization.",
    parameters: {
      type: "OBJECT" as any,
      properties: {},
      required: [],
    },
  },
  {
    name: "approve_action",
    description:
      "Approve or deny a pending Cipher (Claude Code) action. " +
      "Set needs_user_pin to false for routine dev operations June can auto-approve, " +
      "or true for architectural/high-risk decisions that need King Kazuma's PIN.",
    parameters: {
      type: "OBJECT" as any,
      properties: {
        approval_id: {
          type: "STRING" as const,
          description: "The ID of the approval request to resolve",
        },
        approved: {
          type: "BOOLEAN" as const,
          description: "Whether to approve (true) or deny (false) the action",
        },
        needs_user_pin: {
          type: "BOOLEAN" as const,
          description:
            "Set to true for architectural/high-risk decisions that need King Kazuma's PIN. " +
            "Set to false for routine dev operations (tests, builds, file edits, non-destructive git) " +
            "that June can auto-approve.",
        },
      },
      required: ["approval_id", "approved", "needs_user_pin"],
    },
  },
  {
    name: "send_dev_directive",
    description:
      "Send a development directive to Cipher (Claude Code). " +
      "Use 'quick' for small fixes/tasks, 'feature' for new features (requires plan + approval), " +
      "'explore' for research/investigation tasks. " +
      "Translate King Kazuma's casual requests into clear, actionable directives.",
    parameters: {
      type: "OBJECT" as any,
      properties: {
        type: {
          type: "STRING" as const,
          description:
            "Directive type: 'quick' (immediate small task), 'feature' (needs plan + approval), 'explore' (research/report back)",
        },
        title: {
          type: "STRING" as const,
          description: "Short title for the directive (e.g. 'Cooking Mode', 'Fix login bug')",
        },
        description: {
          type: "STRING" as const,
          description:
            "Detailed description of what Cipher should do. Be specific and actionable.",
        },
      },
      required: ["type", "title", "description"],
    },
  },
  {
    name: "get_directives",
    description:
      "Get development directives and their current status. " +
      "Use to check on directive progress, find planned directives needing review, " +
      "or see what Cipher is working on.",
    parameters: {
      type: "OBJECT" as any,
      properties: {
        status: {
          type: "STRING" as const,
          description:
            "Optional filter: 'pending', 'planning', 'planned', 'approved', 'in_progress', 'completed'",
        },
      },
      required: [],
    },
  },
];

export const BRIDGE_TOOL_NAMES = new Set(
  BRIDGE_FUNCTION_DECLARATIONS.map((d) => d.name)
);
