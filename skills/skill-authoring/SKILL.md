---
name: skill-authoring
agent: true
authoring: false
description: Protocol for deciding when to create a personal or workspace skill and how to structure, scope and write it.
---

1. Write a skill only for a repeatable procedure or decision protocol that recurs across turns. Standing workspace-wide rules belong in `+agent.md` or `+agent.external.md`; deterministic writes, transactions, schedules and policy-guarded operations belong in model transforms, effects or automations; tunable business rules, catalogues and thresholds live in runtime records. Skills are procedure, never authority or secret storage.
2. Choose the right scope: save a personal skill (`personal_skill_save`) for one person's recurring workflow (private, never enters releases), or author a workspace skill (`src/agent/skill/<name>/+skill.md`) for shared team procedures versioned with workspace source.
3. Keep one cohesive job per skill so turns load only what they need. Check existing skills and briefs before creating a new one: update or merge an overlapping skill rather than duplicating rules.
4. Make the frontmatter `description:` a concrete trigger contract: state clearly when to load the skill and what procedure or decisions it governs, since the catalogue shows only the name and description before the skill is read.
5. Keep the protocol short, numbered and general. State imperative steps, decision criteria, refusals and required verification evidence. Validity rules and exclusions come from the task, declared constraints or supplied evidence — never turn one example into a universal rule or embed customer data, sample records, hardcoded IDs or code blocks.
6. Split reference material progressively: keep the entry file lean (well under 4 KB) and place bulky checklists, lookup tables or sub-topic guides in `references/<topic>.md` inside the skill folder, indexed by when to open each.
7. Bundle scripts or vendored pure-JavaScript packages (≤ 10 MiB total, no symlinks) only for repeatable local computation or parsing via `run_js { file }` over `/in` and `/out`. For documents or large files, specify which part to inspect rather than reading whole files.
8. Follow the required format and naming: personal skills use kebab-case names (`^[a-z0-9][a-z0-9-]{0,62}$`) with `SKILL.md`; workspace skills use `src/agent/skill/<name>/+skill.md` with snake_case names (`^[a-z][a-z0-9_]*$`). Both open with `---` frontmatter containing `description:`.
9. Verify a new or edited skill (and any bundled script) on a real case; tighten ambiguous rules and delete stale skills that no longer earn their keep.
