---
name: bolt-requirements
description: >-
  Turn a vague business requirement from a non-technical person into a concrete, buildable plan.
  Use when handed a rough concept, feature request, or "we want to manage X" statement and asked to
  plan, scope, or design what to build on Norbital. Elicits the missing facts, decomposes the
  function, maps it to Bolt primitives, draws the integration and out-of-scope boundary, and emits
  a plan document a non-technical stakeholder can read and confirm.
license: MIT
metadata:
  package: '@norbital-ai/bolt'
---

# Bolt requirements

A requirement is a hypothesis; the plan is the contract. The input is vague language from somebody
who knows the business but not the software ("we want to manage our spare parts and bill
customers"). The output is a plan a non-technical person can read, correct, and sign — with the
implementation decisions already made underneath. If the stakeholder cannot follow the plan, the
requirements process has not finished.

Five SOPs take a concept to a plan. Classification of each sub-function comes from the
`bolt-feasibility` skill — load it the moment any sub-function is uncertain, and its verdicts feed
directly into the boundary section of this plan.

## SOP 1 — Elicit

Close the seven ambiguity groups before writing anything. For each group, the full question bank
is in [elicitation-questions.md](references/elicitation-questions.md):

1. **Who** — which roles use it, which teams exist, who must see what.
2. **What** — the entities being managed and their meaningful states.
3. **Transitions** — how each entity moves between states, what is allowed and what is not.
4. **Numbers** — every quantity and amount: units, currencies, rounding, taxes, caps.
5. **Triggers** — what happens on a schedule or when events occur.
6. **The outside world** — existing systems of record, third parties, legal/regulatory
   obligations, compliance requirements.
7. **Outputs** — documents, exports, reports, messages, files.

**Trap words.** Treat these as signals that a fact is missing, and ask the follow-up:

| When they say… | They mean…               | Ask                                                                |
| -------------- | ------------------------ | ------------------------------------------------------------------ |
| "manage"       | CRUD + a lifecycle       | Which states does a record live through, and who moves it?         |
| "track"        | history + status         | What statuses, and what has to be provable later?                  |
| "integrate"    | something exists outside | Which system owns the data, who reads and who writes?              |
| "report"       | derived numbers          | Which numbers, for whom, how often?                                |
| "automate"     | work without a person    | On what trigger, with what approval, what if it fails?             |
| "dashboard"    | a view of numbers        | Which numbers, at what granularity, who may see them?              |
| "approve"      | a gate                   | Who approves, what happens before and after, is there an override? |

## SOP 2 — Decompose into functions

1. List the sub-functions by verb: _track, quote, approve, pay, dispatch, verify, file, report,
   chat_.
2. For each, write one sentence of the job it does and name the person who does it. A
   sub-function you cannot attach to a person is not yet a sub-function.
3. Classify each with `bolt-feasibility` (native / mediated / not-appropriate / certified).
   Keep the native ones, and keep the mediated ones — they become integration rows. The
   not-appropriate ones become explicit exclusions, which are part of the plan, not its failures.

## SOP 3 — Map to Bolt primitives

Convert each accepted sub-function into the primitives that will implement it. The full mapping
with defaults and anti-patterns is in [primitive-mapping.md](references/primitive-mapping.md);
the defaults that cover most cases:

| Requirement pattern                                                 | Default construction                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A record with a lifecycle                                           | a collection with a `status` enum, a hook enforcing the transition map, audit built in               |
| Money anywhere                                                      | a `money` datatype; amounts computed once per document, totals as sums of rounded lines              |
| Master data from another system                                     | a mirrored collection with the external key in `external_code`, kept in step by a scheduled pull     |
| A committed document (quote, order, invoice)                        | a document collection that locks when it leaves draft; lines snapshot the prices they were struck at |
| A number that must hold up to scrutiny (pay, accrual, contribution) | a reckon computation graph — deterministic, replayable, auditable                                    |
| Work on a schedule or after an event                                | an automation; idempotent, durable, `api.infer` when judgement is needed                             |
| A screen beyond the standard table                                  | an app; derived queries only (`$derived`), one scroll owner, bilingual copy                          |
| A custom endpoint or dashboard                                      | a function (query/command) or an app with `findGrouped`/`aggregate`                                  |
| External people with accounts                                       | policies + teams, approval flows where a second pair of eyes is needed                               |
| External people without accounts                                    | an envoy agent surface, scoped by policy to their own records                                        |
| An external system or provider                                      | an integration: pull / webhook / send / connector / MCP; decide its credentials and its outbox       |

Anti-patterns to refuse while mapping: storing a number that can be derived (stock position, paid
status), recomputing money in several places, exposing system UUIDs in UI, raw text in markup,
and one collection trying to be two lifecycles.

## SOP 4 — Draw the boundary

State explicitly what the plan does **not** include, in business terms:

- **External systems of record stay external** — the ERP still owns customers, items, vendors;
  the workspace mirrors and hands back.
- **Certified outputs go through certified channels** — the workspace prepares the payroll file,
  the filing, the documents; the bank, the authority, or the provider completes them.
- **Gold-plating is cut, and the cut is visible** — version-1 exclusions (no reorder automation,
  no barcode support, no audit-level reporting yet) are written down so the stakeholder can move
  them into scope deliberately.
- **Not-appropriate functions are named with their alternative** — "no live multiplayer; a
  shared board is the fit" — rather than left as an unspoken gap.

Every mediated row must name the meeting point: what Bolt does, what the third party does, where
they meet (pull, webhook, send, SDK, MCP), and what survives an outage (outbox, cursor, retry).

## SOP 5 — Write the plan

Emit the plan document in the structure of
[plan-template.md](references/plan-template.md), one page of reading per phase, in business
vocabulary:

1. **Goal** — one paragraph in the stakeholder's own words.
2. **Who uses it** — roles and teams, with what each may do.
3. **What it manages** — entities and their lifecycles, as a table.
4. **How work flows** — the numbered workflows, including approvals.
5. **What people see** — screens and views per role.
6. **Numbers and rules** — every money/quantity/rule decision, stated so a businessperson can
   check it.
7. **What connects to it** — integrations and third parties, with the meeting points.
8. **What it does not do** — the exclusions, each with the reason.
9. **Build order** — milestones in dependency order (foundation, then workflows, then
   integrations), each with what "done" means.
10. **Open questions** — only the facts that change the plan; each with who can answer.

Language rules for the confirmable sections: the stakeholder's vocabulary, no implementation
detail, no platform jargon ("collection", "hook", "policy" appear only in the notes that follow
each section). End with the explicit question: _does this match what you need?_ — and treat any
change to sections 1–8 as a plan change, not a formatting fix.

## Handoff

A confirmed plan is the input to authoring, not the output of it. The next steps are the
`authoring-tenant-workspace` skill (build the workspace source), `authoring-test-suites` (make the
promises falsifiable), and the `norbital-platform` skill (policy and approval behaviour). The
feasibility verdicts that shaped the boundary stay attached to the plan so later scope changes can
be re-classified instead of re-argued.

## Reference routing

- **[elicitation-questions.md](references/elicitation-questions.md)** — the seven-group question
  bank with follow-ups.
- **[primitive-mapping.md](references/primitive-mapping.md)** — requirement patterns to Bolt
  primitives, with defaults and anti-patterns.
- **[plan-template.md](references/plan-template.md)** — the plan document skeleton with example
  copy.
- **[worked-examples.md](references/worked-examples.md)** — a complete vague-concept-to-plan
  walkthrough.
