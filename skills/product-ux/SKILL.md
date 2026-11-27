---
name: product-ux
agent: true
authoring: true
description: How a workspace's apps, pages and record representations should be composed.
---

Every concern has one home, every concept one name. Mechanics: `authoring-tenant-workspace` `references/app-structure.md`; review: `references/ui-standard.md`.

## Structure

1. **Workflow over schema.** Organize apps, pages and tabs around how users work, never around models, backend modules or schema reachability. Operational apps open on live records and actions, never landing cards.
2. **One home per concern.** Record tabs partition concerns: every field, figure, chart and list sits in the one tab it serves; the record's own tab holds identity plus unclaimed fields. Mount owned children in their parent and shared records only where users act on them. Never put one file's upload or metadata in its own tab — keep it inline in the primary tab that uses it.
3. **One scope per setting.** Place a setting at the narrowest scope where it varies (workspace, team, member or record), never two.
4. **Causal order.** In multi-stage or automated workflows, let users review and adjust generated findings or proposals in place before committing downstream outputs, and keep each stage repeatable when inputs change.

## Names

5. **User language.** Label every view, section, field and action in plain words the user speaks — never bare codes, abbreviations, enum values or internal terms. Explain domain terms in help or descriptions.
6. **One concept, one name.** Use one name per concept and distinct names for distinct concepts; never encode the same fact in two fields.

## Composition

7. **Primitives own their chrome.** Let native shells, toolbars, sections, fields and tables own titles, hints, search, filters, sort, empty states, spacing, scroll and Save; never add parallel headings, duplicate footers, hand-rolled table grids, suppressed table discovery without cause, or manual padding wrappers around full-bleed views.
8. **One view, one scroll.** Keep one primary data view (`Table` or `Board`) per page or tab, one scroll owner per axis, and flat navigation — cap horizontal tabs at two levels, use collapsible sections inside a view, and reserve inline toggles for lightweight filters.
9. **Linked views share selection.** When a list pairs with a spatial or visual view (map, model, schedule, chart), selecting in either focuses both; clearing restores the whole. Opening the record stays explicit.
10. **Match control weight to data.** Give polymorphic records a clear top-level variant switch showing only relevant fields, replace raw ID lists with domain or visual pickers, hide system/sync internals, and auto-allocate routine codes; use compact multi-column forms (scalars before wide inputs), plain text for short notes, rich editors for long-form prose, timelines for dated series, and bounded charts for decisions.
11. **Stable views, clear state.** Surface state, progress and the primary next action in place (badges, inline run status, one primary CTA per view). Never shift layout with transient blocks; open secondary forms in sheets.
12. **One path per action.** Give each action one control per view; repeat it only where the user works on the same object.
13. **Composable behaviors, agent-ready.** Never hand-roll interaction primitives; compose custom widgets from `@norbital-ai/ui/behaviors` and register stateful controls with `register_control`.
14. **Previewable, customizable outputs.** For formal external documents and standard-governed reports, capture required inputs on owning records, keep layouts editable as versioned templates rather than hardcoded exports, and provide an in-app preview with direct template revision.
15. **Simplest layout wins.** Use real assets with alt text and verify layout, scroll, media and console across widths and themes.
