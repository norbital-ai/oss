# Plan template

The plan document skeleton from SOP 5. Sections 1–8 are the confirmable contract: business
vocabulary, no implementation detail. Sections 9–10 are for the people who will build it. Each
section can carry a short "notes" line under it with the implementation mapping (which primitives,
which collections, which policies), marked clearly as build notes rather than product description.

---

# <Name of the thing> — build plan

## 1. Goal

One paragraph in the stakeholder's own words: what the business does today, what changes, and
what "done" looks like on an ordinary day. No platform vocabulary.

> _Example: Field work is tracked on paper and WhatsApp. This system will give the office one
> place to see every job, who is on it, and what the site says happened — and it will let
> contractors send their job updates and photos from their phones without accounts._

## 2. Who uses it

| Role        | What they do                | What they may see     | What they may change         |
| ----------- | --------------------------- | --------------------- | ---------------------------- |
| (job title) | (their job in the workflow) | (scope of visibility) | (what they can start/finish) |

_Build notes: team names for `src/access/+teams.ts` and the policy file names each holds. A person is on exactly one team, so name a team for every combination of authority somebody actually holds — there are no roles to stack._

## 3. What it manages

| Thing (business name) | What must be known about it    | Its states                      |
| --------------------- | ------------------------------ | ------------------------------- |
| (e.g. a job)          | (facts that are not derivable) | (state list, in business words) |

_Build notes: collection names, datatypes, relationships, effective-dated facts._

## 4. How work flows

Numbered steps, written as a person would perform them, including the approvals:

1. The office creates a job with a site and a due date.
2. Contractors see jobs assigned to them on WhatsApp and accept.
3. …
4. The office approves the completed job; the variation goes to the director.

_Build notes: which steps are hook-enforced transitions, which are automations, which are
approval flows._

## 5. What people see

| Role   | Screen        | What is on it                            |
| ------ | ------------- | ---------------------------------------- |
| (role) | (screen name) | (the useful information, human-readable) |

_Build notes: app files, collection representations, charts/kanban/table choices._

## 6. Numbers and rules

Every money, quantity, rounding, tax, cap, and business rule decision, stated so a businessperson
can check it. A rule that is missing here will be invented later and usually wrong:

- A job's price is fixed when the job is created and does not change when rates change.
- Overtime is 1.5x above the 44th hour, per jurisdiction.
- A quote older than 30 days cannot be confirmed without the director.
- …

_Build notes: custom('money') columns, reckon graphs, CEL rules, hook invariants._

## 7. What connects to it

| The other side                      | What it owns    | What goes in                 | What goes out                   | How they meet                       |
| ----------------------------------- | --------------- | ---------------------------- | ------------------------------- | ----------------------------------- |
| (ERP / bank / provider / regulator) | (facts it owns) | (what the workspace mirrors) | (what the workspace hands over) | (pull / webhook / send / SDK / MCP) |

_Build notes: integration files, bindings, credentials in the vault, outbox behaviour._

## 8. What it does not do

Each exclusion with the reason, in business terms:

- This version does not send pay automatically — the bank does that, from the file we export.
- No barcode scanning yet — receipts are keyed in manually in version 1.
- The ERP remains the system of record for customers and items; this system mirrors them.
- …

_Build notes: verdicts from bolt-feasibility per exclusion (mediated / not-appropriate /
deferred), so a later scope change is re-classified, not re-argued._

## 9. Build order

Milestones in dependency order, each with what "done" means to a businessperson:

1. **Foundation** — the records and their states exist; staff can enter and read them.
2. **Workflows** — transitions, approvals, and screens behave as described in §4–§5.
3. **Numbers** — §6 rules are in effect and provable.
4. **Outside world** — §7 connections run with no data loss and survive failures.
5. **Rollout** — real users on real data, with training notes.

## 10. Open questions

Only facts that change the plan, each with who can answer them:

- Which jurisdiction's overtime rules apply to the plant in Penang? — HR.
- Who approves variations above RM 5,000? — Director.
- …

---

## Confirmation

Read back to the stakeholder: _does this match what you need?_ Changes to §1–§8 are plan changes
(update the plan, then re-confirm). Changes to §9–§10 are scheduling and facts, not scope.
