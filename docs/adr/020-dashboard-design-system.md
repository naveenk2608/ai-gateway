# ADR 020: A small design system for the dashboard

- Status: accepted
- Date: 2026-10-21
- Milestone: M7 (redesign)

## Context

The M7 dashboard worked but every page was laid out by hand: stat boxes, tables and charts with
their own spacing and colours. A redesign had to give all eight pages one look without adding a
component library, without changing the admin API, and without weakening the M7 rules: no
hand-written numbers, loading, empty and error states on every view, no edit controls for
viewers, usable at 375 px. The design reference shows things the gateway does not record (change
against a previous period, provider uptime, an activity feed, global search, an "add model"
button), so the system also has to say plainly what is not measured.

## Decision

Plain CSS custom properties plus a handful of shared components, built on the ADR 018 stack:

- **Tokens** (`src/styles/tokens.css`): surfaces, text, one blue accent, status colours, five
  chart colours, spacing, radii, type and motion. Components use tokens only. Dark is the
  default theme; `data-theme="light"` on `<html>` switches, and the choice is kept per browser.
  Cards are flat: borders, no shadows; only menus, drawers and tooltips float.
- **Shell** (`src/shell/`): a collapsible sidebar, a top bar with the project and time range, and
  a page header. Pages live in the URL hash (`#cost`); a page may add a section (`#settings/keys`)
  for in-page tabs, so tabs can be linked and survive a reload.
- **Building blocks** (`src/ui/`, `src/charts/`): `QueryCard` (one query with its loading, error
  and empty states), `KpiCard` (icon, value, note and a sparkline or a reason there is none),
  `Meter` (a share of a limit, warning from 80%), `ShareTable` (a breakdown with each row's share
  of the API's total), tiles, `Tabs`, `Drawer`, and charts with one shared theme: area and bar
  series over time, horizontal grouped bars per category, and a share ring that folds small
  parts into "Other".
- **Honesty rules**: every number comes from an API response; a value the gateway does not
  record is shown as "not measured" (or "not tracked") with a `docs/PLAN-NOTES.md` row labelled
  UI, or left out. Charts have one value axis and categorical colours in a fixed order.

## Alternatives considered

- A component library (MUI, Chakra, shadcn/ui with Tailwind): faster first screens, but a large
  dependency and a theme layer to fight for a dense, flat look; the dashboard needs about ten
  components.
- CSS-in-JS: runtime cost and another dependency for what custom properties already do,
  including theme switching without re-rendering.
- A router library for tabs: the hash already carries the page; one more segment is enough.

## Consequences

- New pages are mostly composition: a KPI row, `QueryCard`s with charts or tables, tiles. The
  look stays consistent because the pieces own spacing and colour.
- The palette is fixed at five chart colours; a breakdown with more parts folds into "Other".
  The dark chart colours are brighter than a strict lightness band would allow; colour-blind
  separation and contrast against the card surface pass, and legends carry names and shares so
  colour is never the only cue.
- "Not measured" values are visible debts, each with a PLAN-NOTES row; filling one needs an API
  change, never a dashboard change alone.
- Tests check the states and roles per page in jsdom, every page and every settings tab at
  375 px in Chromium, and the CI data check still rejects numbers written into dashboard source.
