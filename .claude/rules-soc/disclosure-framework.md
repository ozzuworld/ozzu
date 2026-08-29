# Vulnerability Disclosure Framework — 0xReadingSteiner

All security research output from Cipher MUST follow this framework. Covers ALL Cisco products (CUCM, Expressway, FTD, and future targets). The naming system references the Science Adventure (SciADV) franchise (Steins;Gate, Anonymous;Code).

**Master repo:** `cisco-security-research` (pinned, indexes all products)
**Per-kill-chain repos:** one repo per named kill chain (e.g., `Silent-Call`)

## Three-Tier Naming System

| Level | Convention | Source | Meaning |
|-------|-----------|--------|---------|
| **Kill chain** | `Word;Word` | SciADV semicolon (Steins;Gate, Chaos;Head) | Complete attack — statement terminated. The semicolon = a full, executable instruction. |
| **Component vuln** | `[Name]hack` | Anonymous;Code (Cicada 3301 quests: Spoofhack, Facehack, Poolhack) | Individual vulnerability. The hack suffix = one step in the quest. |
| **Tool** | `FG#NNN` | Steins;Gate (Okabe's Future Gadgets: FG#001–FG#008) | Security instrument built by the researcher. Standalone, defensive framing, requires legitimate access. |

### Kill Chain Naming Rules (`;`)
- Two words joined by semicolon: `[Theme];[Mechanism]`
- Word A = attack character (Silent, Phantom, Dead, Ghost, Blind, Null, False, Open, Cold, Broken)
- Word B = telephony/comms term (Call, Wire, Tone, Signal, Line, Dial, Trunk, Switch, Channel, Carrier, Ring, Relay)
- Each kill chain owns its namespace — component vulns carry the chain's identity in their advisory
- Reserved for COMPLETE attack chains (entry → execution → impact), not individual vulns

### Component Vulnerability Naming Rules (`hack`)
- Format: `[Target/Action]hack` — one word, lowercase, fused with "hack"
- Describes what the vuln does: Spoofhack (spoofs identity), Keyhack (uses hardcoded key), Roothack (escalates to root)
- Each component vuln also gets a SKYLINE-YYYY-NNN tracking ID for CVE mapping
- One vuln can appear in multiple kill chains

### Tool Naming Rules (`FG#`)
- Format: `FG#NNN — [Descriptive Name]`
- Sequential numbering starting at FG#001
- Tools are STANDALONE — they require legitimate access (SSH, credentials), NOT chained to exploits
- Defensive framing: post-compromise assessment, security audit, incident response
- Each tool gets its own GitHub repo: `github.com/0xReadingSteiner/FG[NNN]-[slug]`

## Advisory Structure (per kill chain drop)

```
drops/NN/
├── ADVISORY.md      ← Full technical advisory (see template below)
├── poc.sh           ← PoC script (bash/curl/python). Cleans up after itself.
└── mitigations.md   ← Detailed mitigations for defenders (optional, can be in advisory)
```

## Advisory Template (ADVISORY.md)

Every kill chain advisory MUST include these sections in order:

1. **Advisory Information** — ID, title, CVSS, CWE, affected product, vendor coordination status, researcher
2. **Executive Summary** — 3-4 sentences. What, how many requests, what access it gives.
3. **Impact** — What an attacker can DO with this access on this specific product. Concrete, not generic.
4. **Technical Details** — Architecture background → each component vuln with code/config snippets
5. **Proof of Concept** — Step-by-step with exact commands. Expected output for each step.
6. **Root Cause Analysis** — WHY these flaws exist (design assumptions that failed)
7. **Affected Components** — Version table
8. **Remediation** — What defenders should do NOW (before vendor patches)
9. **Vendor Coordination Timeline** — Dated table of all coordination attempts
10. **Disclosure Statement** — Independent research, no proprietary access, coordination attempted
11. **References** — Product pages, CWE links, related research

## Individual Vuln Reference (vulns/SKYLINE-YYYY-NNN.md)

Short-form reference for CVE tracking:
- Metadata table (ID, CVE, CWE, CVSS, product, component, used-in)
- Description (one paragraph)
- Affected configuration (code snippet)
- Fix (what the vendor should change)
- Researcher credit

## Researcher Identity

- **Handle:** 0xReadingSteiner
- **Email:** 0xReadingSteiner@proton.me
- **GitHub:** github.com/0xReadingSteiner
- **Advisory ID format:** SKYLINE-YYYY-NNN
- **PGP:** D5E22255F645A8B935056C278C0958C5D533080A

## Campaign Cadence

- One kill chain drop per week
- Each drop is announced with its branded name
- The master README at the repo root updates with each new drop
- TIMELINE.md updates with vendor responses (or lack thereof)
- Individual vuln references accumulate in vulns/

## What NOT to Include in Public Advisories

- Compiled binaries or automated exploit kits
- Specific target IP addresses or organization names
- Credentials or keys from real production systems (lab creds only)
- Any reference to employment history or personal grievances
- Internal Ozzu infrastructure details
