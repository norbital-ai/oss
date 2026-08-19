---
name: bolt-feasibility
description: >-
  Decide whether a business function or app can be built on the Norbital platform. Use when asked
  "can we build X", "is X possible or feasible", whether a feature needs a third-party integration,
  why a function is or is not buildable, or before promising a capability to a customer. Produces a
  per-sub-function verdict: native (first-class Bolt), mediated (possible via a third party), or
  not-appropriate (outside the platform contract).
license: MIT
metadata:
  package: '@norbital-ai/bolt'
---

# Bolt feasibility

Almost every business function is buildable on Norbital. The platform is a full business-application
stack — data model, enforced workflows, approvals, computation, AI, integrations, communication,
and a complete UI — so the interesting question is never "can it be done at all" but "where is the
line between what Bolt does and what somebody else must do". A feasibility answer is a line drawn,
per function, and stated so a customer can see it.

**A verdict applies to one sub-function, never to a whole request.** "We want a CRM with invoicing
and tax filing" is three verdicts, not one. Decompose first, then classify.

## The three verdicts

| Verdict             | Meaning                                                                         | What you promise                                                         |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **native**          | Built from first-class Bolt primitives, no third party required                 | Buildable now, in-workspace, with the standard authoring workflow        |
| **mediated**        | Buildable, but part of the function belongs to a third party or external system | Bolt implements its side; the boundary (integration) is part of the plan |
| **not-appropriate** | Outside the platform contract — do not promise it                               | The function cannot run inside a workspace; say what can run instead     |

A fourth label qualifies a native or mediated verdict rather than replacing it:
**certified** — the workspace can implement a process, but the _output_ is not
certified by any authority (tax filing, statutory payroll, legal signature). Certification lives
with a provider or regulator; Bolt implements the workflow around it. Say so in every verdict that
touches a regulated output.

## SOP 1 — Restate and decompose

1. Restate the request in plain business terms, as the customer would. Do not use platform
   vocabulary in the restatement.
2. Split it into sub-functions by **verbs**: _track, quote, approve, pay, dispatch, verify, file,
   report, chat_. Each verb is a candidate sub-function. A sub-function is roughly "one person's
   job on one screen": if you cannot name the person doing it, split again.
3. Keep the split until every sub-function fits one row of the verdict table below.
4. Verdict each row independently. A single mediated or not-appropriate row does not sink the
   others — it draws a boundary inside the plan.

## SOP 2 — Classify each sub-function

Run the probe questions in order. The first question that settles it decides the verdict; details
and the full decision tree are in [classification-rules.md](references/classification-rules.md).

1. **Is it data plus a workflow?** Records, states, transitions, who may see and do what — CRM,
   HR, inventory, procurement, project delivery, case management, maintenance, permits, documents.
   → **native** (collections, hooks, policies, approvals, apps).
2. **Is it computation with rules?** Money math, eligibility, accruals, rates, scheduling,
   statutory calculations, derived reports. → **native** (reckon, CEL, hooks, `findGrouped` /
   `aggregate`; money and rounding are first-class).
3. **Is it work that runs on a schedule or after an event?** Expiry watchers, nightly syncs,
   reminder runs, status nudges. → **native** (automations, durable and idempotent).
4. **Is it a custom endpoint or dashboard?** Reads, writes, or buttons beyond the standard
   surfaces. → **native** (remotes, apps, agent tools).
5. **Is it AI judgement?** Classification, extraction, summarisation, image reading, drafting.
   → **native** (`api.infer` with structured output; bounded in hooks, durable in automations).
6. **Is it people talking to the workspace from outside?** Customers, contractors, suppliers
   over WhatsApp or chat, without accounts. → **native** (channels, the agent surface).
7. **Is it math or graphics in the browser?** 3D/CAD review, physics simulation, volumetric
   visualisation, image processing. → **native** — the bundle ships arbitrary JavaScript and WASM
   (precedent: `pdq-wasm`, `fast-png`, `jpeg-js`, `exifr` in field-operations; `exceljs` in
   hr-payroll). Client-side libraries such as three.js and physics engines are dependencies, not
   integrations.
8. **Does it touch an external system of record?** The company's ERP, accounting system, HRIS,
   another SaaS. → **mediated** — Bolt mirrors its masters and hands documents back (pull /
   webhook / send / connector). The external system stays the owner of its data.
9. **Does it move money, verify identity, or produce legally/regulatorily significant output?**
   Payments, KYC, e-signatures, statutory filing, bank disbursement. → **mediated** (integrate a
   provider) or **certified** (implement the workflow; the output is valid only through the
   certified channel).
10. **Is it anything else?** OS-level access, hardware, native apps, public websites, game-scale
    real-time, raw server execution, external databases. → **not-appropriate**; see
    [limits-and-boundaries.md](references/limits-and-boundaries.md).

## SOP 3 — Draw the mediation boundary

For every mediated row, name the meeting point. A mediated verdict is incomplete until this is
stated:

- **What Bolt does** — the sub-function inside the workspace (the mirror, the document, the
  workflow, the decision record).
- **What the third party does** — the part Bolt must not reimplement (money movement, identity
  proof, certified filing, system of record).
- **Where they meet** — one of the integration surfaces: scheduled pull, signed inbound webhook,
  outbound HTTP send, connector facility, MCP server, email/WhatsApp, or a client-side library
  when the third party is a browser SDK.
- **What survives an outage** — outbox semantics on sends, cursor-based pulls, idempotent
  automations, so the boundary is re-runnable, not once-and-lucky.

## SOP 4 — Apply the certification reality check

Distinguish _implements the process_ from _certified to produce the output_:

- Payroll calculation, statutory contribution configuration, payslips, and bank file export are
  **native** — this is what the hr-payroll template does.
- Moving the money, filing with the authority, or signing with legal force is a **certified**
  channel: the workspace prepares and hands over; the provider or regulator completes.
- Never promise "certified payroll", "valid e-signature", or "approved filing" from the workspace
  itself. Promise the workflow, the computation, the audit trail, and the handoff.

## SOP 5 — Write the verdict

Answer with one table plus callouts. Per sub-function:

| Sub-function     | Verdict   | How it is built                                           | Boundary                                            |
| ---------------- | --------- | --------------------------------------------------------- | --------------------------------------------------- |
| order tracking   | native    | collections + lifecycle hook                              | —                                                   |
| payment capture  | mediated  | integration to a payment provider                         | money movement and card handling are the provider's |
| statutory filing | certified | workflow + export, submission via the authority's channel | the filing is valid only through that channel       |

Then, in prose: what is explicitly **excluded** (the not-appropriate rows), what **changes the
verdict** (open questions — data volumes, jurisdictions, whether an external system exists), and
**precedent** (which existing template already does something similar; templates are the strongest
evidence a claim is native). If a claim rests on the capability inventory rather than precedent,
say so.

## Reference routing

- **[capability-inventory.md](references/capability-inventory.md)** — everything a workspace can
  do natively, with the precedent that proves it.
- **[classification-rules.md](references/classification-rules.md)** — the full decision tree and
  probe questions behind SOP 2.
- **[limits-and-boundaries.md](references/limits-and-boundaries.md)** — what is not-appropriate,
  and why; the certification catalog.
- **[worked-examples.md](references/worked-examples.md)** — complete verdicts for classic asks:
  payroll, CRM, inventory, CAD review, physics simulation, KYC, tax filing, customer chatbot.

For how the platform behaves at runtime (approvals, policies, audit, agent limits) read the
`norbital-platform` skill. For turning an accepted function into a build plan, load
`bolt-requirements`.
