---
name: bolt-requirements
description: Turn a vague business requirement into a concrete Norbital build plan a stakeholder can confirm.
license: MIT
metadata:
  package: '@norbital-ai/bolt'
---

# Bolt requirements

The output is a plan a non-technical person can read, correct and sign, with implementation decisions underneath.

## Protocol

1. **Elicit.** Close seven groups before writing: who, what, transitions, numbers, triggers, the outside world, outputs. Questions: `references/elicitation-questions.md`.
2. **Decompose.** List sub-functions by verb, each one sentence with a named person. Classify with `bolt-feasibility`. Keep native and mediated rows; not-appropriate rows become explicit exclusions.
3. **Map.** Convert each accepted sub-function to primitives: `references/primitive-mapping.md`. Refuse its anti-patterns.
4. **Draw the boundary.** State what the plan excludes, in business terms. External systems of record stay external. Certified outputs go through certified channels. Version-1 cuts are written down. Each not-appropriate function names its alternative. Each mediated row names what Bolt does, what the third party does, where they meet, and what survives an outage.
5. **Write.** Emit the plan from `references/plan-template.md`. Sections 1 to 8 use the stakeholder's vocabulary with no platform jargon outside build notes. End by asking whether it matches. A change to sections 1 to 8 is a plan change.

## Trap words

| They say | Ask |
| --- | --- |
| manage | Which states does a record live through, and who moves it? |
| track | What statuses, and what must be provable later? |
| integrate | Which system owns the data, who reads, who writes? |
| report | Which numbers, for whom, how often? |
| automate | On what trigger, with what approval, what if it fails? |
| dashboard | Which numbers, at what granularity, who may see them? |
| approve | Who approves, what happens before and after, is there an override? |

## Handoff

A confirmed plan is the input to authoring: `bolt-primer`; another skill only for what it leaves open. Keep feasibility verdicts attached so a scope change is re-classified, not re-argued.
