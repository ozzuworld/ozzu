# Ozzu Component Catalog

Read this before creating new components. Reuse what exists.

## Design Foundation

| File | Purpose |
|------|---------|
| `lib/design-tokens.ts` | Colors, spacing, radius, fontSize, fontWeight, helpers (`withAlpha`, `statusPillStyle`) |
| `lib/directive-constants.ts` | Status/type emojis, colors, priority labels, `relativeTime()`, `HUMAN_STATUS` |
| `lib/bridge-api.ts` | All API types (`Directive`, `BusinessProject`, etc.) and fetch functions |

## Card Patterns (use these as templates)

### ProjectCard (`components/business/ProjectCard.tsx`)
**The gold standard.** Use this pattern for any entity card.
- Container: `bg:#1A1A1A`, `borderRadius:12`, `borderLeftWidth:3` (accent color), `padding:16`, thin border
- Row 1: 22px emoji + 15px semibold title + 8px status dot
- Row 2: 12px description, 2 lines, `color:#737373`
- Row 3: ProgressBar (full width, 4-5px height, colored)
- Row 4: "X/Y tasks" + "Z%" (monospace, 10px)
- Press: `scale:0.98`, `opacity:0.92`

### DirectiveListItem (`components/directives/DirectiveListItem.tsx`)
Compact version of ProjectCard for directive lists.
- Same container pattern (left border, elevated bg, rounded)
- Row 1: emoji + title + status dot + time
- Row 2: description/work_summary (2 lines)
- Row 3: status pill + type badge + priority badge
- Row 4 (epics): progress bar + phase count

### ServiceCard (`components/ops/ServiceCard.tsx`)
Expandable health card for services.
- Status dot + emoji + name + latency + last check
- Expandable detail grid

## Shared UI Elements

| Component | File | Use For |
|-----------|------|---------|
| `ProgressBar` | `components/business/ProgressBar.tsx` | Any progress visualization. Props: `done, total, color, height` |
| `StatusBadge` | `components/StatusBadge.tsx` | Connection status dot + clock in header |
| `HamburgerMenu` | `components/HamburgerMenu.tsx` | Global nav menu (12 items) |
| `Keypad` | `components/Keypad.tsx` | PIN entry modal |
| `TVPressable` | `components/TVPressable.tsx` | Rarity-colored pressable with glow |
| `ContentPanel` | `components/ContentPanel.tsx` | Rich markdown panel with animation |

## Directive Components

| Component | File | Use For |
|-----------|------|---------|
| `DirectiveListItem` | `components/directives/DirectiveListItem.tsx` | List/overview rows |
| `BuildRunBadge` | `components/directives/BuildRunBadge.tsx` | CI/CD build status badge |
| `PlanReviewModal` | `components/directives/PlanReviewModal.tsx` | Markdown plan review + approve/reject |
| `StatusChangeSheet` | `components/directives/StatusChangeSheet.tsx` | Status transition bottom sheet |
| `MessageApprovalModal` | `components/directives/MessageApprovalModal.tsx` | WhatsApp/Gmail approval gate |

## Business Components

| Component | File | Use For |
|-----------|------|---------|
| `ProjectCard` | `components/business/ProjectCard.tsx` | Venture card (gold standard) |
| `ProjectDetailSheet` | `components/business/ProjectDetailSheet.tsx` | Venture detail bottom sheet |
| `DashboardView` | `components/business/DashboardView.tsx` | KPI metrics + charts |
| `PipelineView` | `components/business/PipelineView.tsx` | Kanban shipment pipeline |
| `ContactsView` | `components/business/ContactsView.tsx` | Contact list + filters |
| `FinancialSummaryCard` | `components/business/FinancialSummaryCard.tsx` | Budget + category breakdown |
| `TaskCard` | `components/business/TaskCard.tsx` | Task with status/priority |
| `ProgressBar` | `components/business/ProgressBar.tsx` | Horizontal progress fill |
| `CostField` | `components/business/CostField.tsx` | COP currency input |

## Ops Components

| Component | File | Use For |
|-----------|------|---------|
| `ServiceCard` | `components/ops/ServiceCard.tsx` | Service health (expandable) |
| `GpuCard` | `components/ops/GpuCard.tsx` | GPU instance status |
| `GcpCard` | `components/ops/GcpCard.tsx` | GCP resource status |
| `NetworkBanner` | `components/ops/NetworkBanner.tsx` | Network status |
| `SystemBanner` | `components/ops/SystemBanner.tsx` | Overall system health |

## Screens (app/)

| Screen | File | Tab |
|--------|------|-----|
| Directives | `app/(tabs)/directives.tsx` | Main directive list (4 view modes) |
| Business | `app/(tabs)/business.tsx` | Ventures (Dashboard/Projects/Pipeline/Contacts) |
| Ops | `app/(tabs)/ops.tsx` | Infrastructure health |
| Home | `app/(tabs)/home.tsx` | Dashboard + shortcuts |
| Directive Detail | `app/directive/[id].tsx` | Directive overview + activity timeline |

## Hooks

| Hook | File | Returns |
|------|------|---------|
| `useDirectives()` | `lib/directive-hooks.ts` | `{ directives, buildStatus, summary, loading, error, refresh }` |
| `useBusiness()` | `lib/business-hooks.ts` | Projects, tasks, contacts, shipments, invoices, investments |
| `usePhoneLayout()` | `lib/usePhoneLayout.ts` | `{ insets, isPhone, screenWidth, screenHeight }` |
| `useEntity(id)` | `lib/ha-context.tsx` | Home Assistant entity state (HA decommissioned — dead code chain) |
| `usePosition()` | `lib/ha-context.tsx` | Current room position (HA decommissioned — dead code chain) |
