# Classification rules

The decision tree behind SOP 2. Ask the questions in order; the first "yes" decides the verdict.
When in doubt between two tiers, choose the lower one and say why — overpromising is the expensive
error, and a mediated verdict can always be upgraded later by precedent.

## Decision tree

```
Q1  Is the sub-function data plus a workflow
    (records, states, transitions, permissions)?
        yes → NATIVE (collections, hooks, policies, approvals, apps)
        no  → Q2

Q2  Is it computation with rules (money, eligibility, accruals,
    rates, scheduling, statutory calculations, derived reporting)?
        yes → NATIVE (reckon, CEL, hooks, aggregate/findGrouped)
        no  → Q3

Q3  Does it run on a schedule or after an event?
        yes → NATIVE (automations — durable, idempotent)
        no  → Q4

Q4  Is it a custom endpoint, dashboard, or button beyond the
    standard surfaces?
        yes → NATIVE (functions, apps, agent tools)
        no  → Q5

Q5  Is it AI judgement (classification, extraction, summarisation,
    image reading, drafting)?
        yes → NATIVE (api.infer; bounded in hooks, durable in automations)
        no  → Q6

Q6  Is it people outside the company interacting (customers,
    contractors, suppliers over chat without accounts)?
        yes → NATIVE (envoy agent surface)
        no  → Q7

Q7  Is it math, graphics, or processing in the browser
    (3D/CAD review, physics simulation, volumetric visualisation,
    image/office-document processing)?
        yes → NATIVE (arbitrary JS/WASM in the bundle, e.g. three.js,
                     matter.js, pdf.js, exceljs — a dependency, not an integration)
        no  → Q8

Q8  Does it touch an external system of record (ERP, accounting,
    HRIS, other SaaS)?
        yes → MEDIATED (pull / webhook / send / connector; the external
                       system stays the owner of its data)
        no  → Q9

Q9  Does it move money, prove identity, or produce legally or
    regulatorily significant output?
        yes → MEDIATED or CERTIFIED (integrate a provider; the workspace
                implements the workflow and handoff, never the certification)
        no  → NOT-APPROPRIATE — see limits-and-boundaries.md
```

## Probe questions to settle each verdict

| Verdict                | Confirm by asking                                                                                            | If it fails, you are really looking at                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| native (data/workflow) | Can every state change be expressed as a status transition a hook can enforce?                               | an external system of record (Q8) or certified output (Q9)            |
| native (computation)   | Is the computation deterministic and auditable?                                                              | AI judgement (Q5) or a certified channel (Q9)                         |
| native (automation)    | Is the trigger a schedule or a write/event inside the workspace?                                             | external telemetry → mediated (Q8)                                    |
| native (AI)            | Does the host's model call through `api.infer` cover it? Can a structured output schema describe the result? | yes → native; otherwise the model call must go through an integration |
| native (channels)      | Does the person need an account to act?                                                                      | account-required internal users → ordinary policies, still native     |
| mediated               | Is there a provider whose business this is?                                                                  | a system Bolt has no surface for → not-appropriate                    |
| not-appropriate        | Is the need OS/hardware/scale outside a web workspace?                                                       | —                                                                     |

## Rules of thumb

- **Naming a third party is not the same as being impossible.** If the customer can name the
  company that already does the thing (payment provider, KYC vendor, bank, regulator portal),
  the verdict is mediated or certified, not not-appropriate.
- **A native claim should carry precedent or a primitive.** "Native" without naming either a
  template that does it or the exact primitive that supports it is an ungrounded claim.
- **Scale and volume change feasibility, not verdict.** A million-row stock movement table is
  still native; a live multiplayer game is not appropriate. If volume is a risk, list it as an
  open question, not a verdict change.
- **"Certified" is a qualification, not a verdict.** Payroll calculation is native; certified
  payroll is certified. Report both rows.
- **When a request spans jurisdictions** (tax, leave, statutory contributions), each
  jurisdiction is its own computation row and its own certification row.
