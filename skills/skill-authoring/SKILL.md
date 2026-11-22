---
name: skill-authoring
agent: true
authoring: false
description: Protocol for deciding when to create a personal or workspace skill and how to structure, scope and write it.
---

1. Write a skill only for a repeatable procedure or decision protocol that recurs across turns. Standing workspace rules belong in `+agent.md` / `+agent.external.md`; deterministic writes, transactions and schedules belong in transforms, effects or automations; tunable rules and catalogues live in runtime records. Skills are procedure, never authority or secret storage.
2. Scope: use `personal_skill` (`action: 'save' | 'delete'`) for one person's private recurring workflow (never enters releases), or `src/agent/skill/<name>/+skill.md` for shared team procedures versioned in source.
3. One cohesive job per skill. Check existing skills and briefs first — update or merge instead of duplicating rules.
4. Make frontmatter `description:` a concrete trigger contract (when to load and what procedure it governs), since the catalogue shows only name and description before reading.
5. Keep protocols short, numbered and general: imperative steps, decision criteria, refusals and required verification evidence. Never turn one example into a universal rule or embed customer data, sample records, IDs or code blocks.
6. Split progressively: keep the entry file lean (< 4 KB) and put bulky checklists or lookup tables in `references/<topic>.md`, indexed by when to open each.
7. Bundle scripts or vendored pure-JS packages (≤ 10 MiB total, no symlinks) only for repeatable local computation/parsing via `run_js { file }` over `/in` and `/out`. Specify which part of large files to inspect.
8. Naming & format: personal skills use kebab-case (`^[a-z0-9][a-z0-9-]{0,62}$`) with `SKILL.md`; workspace skills use `src/agent/skill/<name>/+skill.md` with snake_case (`^[a-z][a-z0-9_]*$`). Both open with `---` frontmatter containing `description:`.
9. Verify new or edited skills (and scripts) on a real case; tighten ambiguous rules and delete stale skills.
