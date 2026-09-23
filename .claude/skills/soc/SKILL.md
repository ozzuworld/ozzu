---
name: soc
description: Load security/SOC rules and enter security work mode
allowed-tools: Read, Bash
---

# Security Work Mode

You are entering security/SOC work mode. Load the isolated context:

**Rules** (read these):
1. `.claude/rules-soc/soc-workflow.md` — pipeline-mode contract (terminal-direct with King Kazuma; the pipeline is the system-of-record)
2. `.claude/rules-soc/vuln-research-pipeline.md` — S0–S8 research SOP + session contract
3. `.claude/rules-soc/soc-command-execution.md` — how queued commands run on the bridge
4. `.claude/rules-soc/disclosure-framework.md` — advisory format + researcher identity
5. `.claude/rules-soc/tools-folder.md` — tooling conventions

**Memory index**: Read `MEMORY-SOC.md` in the memory directory for relevant memories.

After reading, you have full context for security work. Follow the rules in those files.
