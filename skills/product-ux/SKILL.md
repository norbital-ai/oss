---
name: product-ux
agent: true
authoring: true
description: How a workspace's apps, pages and record representations should be composed.
---

Every concern has one home, every concept one name. Mechanics: `authoring-tenant-workspace` `references/app-structure.md`; review: `references/ui-standard.md`.

## Structure

1. **Workflow over schema.** Organize apps, pages and tabs around how users work, never around models, backend modules or schema reachability. Operational apps open on live records and actions, never landing cards.
2. **One home per concern.** A record's tabs partition its concerns: every field, figure, chart and list lives in the single tab it serves, and the record's own tab holds identity plus fields no other tab owns. Mount owned children inside their parent and shared/polymorphic records only where users act on them — never duplicate a roll-up elsewhere.
3. **One scope per setting.** Place a setting at the narrowest scope where its value actually varies (workspace, team, member or record), never two.
4. **Causal order.** In multi-stage or automated workflows, let users review and adjust generated findings or reference proposals in place before committing downstream outputs, and keep each stage repeatable when inputs change.

## Names

5. **User language.** Label every view, section, field and action in plain words the user speaks — never bare codes, abbreviations, enum values or internal terms. Explain unavoidable domain terms in help or descriptions.
6. **One concept, one name.** Use one name for one concept and distinct names for distinct concepts; never encode the same fact in two fields.

## Composition

7. **Primitives own their chrome.** Let native shells, toolbars, sections and fields own titles, hints, search, filters, empty states, scroll and Save; never add parallel headings, action bars or duplicate footers.
8. **One view, one scroll.** Keep one primary data view (`Table` or `Board`) per page or tab, one scroll owner per axis, and flat navigation — cap horizontal tabs at two levels, use collapsible sections for sibling groups inside a view, and reserve inline toggles for lightweight filters.
9. **Linked views share selection.** When a list pairs with a spatial or visual representation of the same records (map, model, schedule, chart), selecting in either focuses and frames that item in both; clearing restores the whole. Opening the record stays an explicit action.
10. **Match control weight to data.** Choose the simplest control that fits the data's shape — domain pickers for structured values, compact multi-column forms with scalars before wide inputs, plain text for short notes and rich editors only for long-form documents, timelines for dated series, and bounded charts answering concrete decisions.
11. **Stable views, clear state.** Surface state, progress and the primary next action directly in place (badges, inline run status, one primary CTA per view). Never shift layout by inserting or removing transient blocks; open secondary forms in sheets.
12. **One path per action.** Give each action one control per view; repeat it elsewhere only where the user already works on that same object.
13. **Composable behaviors, agent-ready.** Compose custom interactive widgets from `@norbital-ai/ui/behaviors` rather than hand-rolling interaction primitives, and register stateful controls with `register_control` so Norbius can drive them.
14. **Simplest layout wins.** Use real assets with alt text and verify layout, scroll, media and console in preview across widths and themes.
