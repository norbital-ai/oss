# Classification rules

Ask in order; the first yes decides. Between two tiers choose the lower and say why: overpromising is the expensive error.

| # | Question | Yes |
| --- | --- | --- |
| 1 | Data plus a workflow: records, states, transitions, permissions? | native: models, callbacks, state locks, policies, approvals, apps |
| 2 | Computation with rules: money, eligibility, accruals, rates, scheduling, statutory calculations, derived reports? | native: std formula and decimal, callbacks, reads with helpers, aggregates, roll-ups |
| 3 | Runs on a schedule or after an event? | native: automations, durable and idempotent |
| 4 | Custom endpoint, dashboard, public or external site, button beyond standard surfaces? | native: read requests, guarded writes, automations, apps, public page queries, the agent |
| 5 | AI judgement: classification, extraction, summarisation, image reading, drafting, tool-using research ending in structured data? | native: `ctx.ai.sys_2.infer`, `ctx.ai.sys_1.decide`, `ctx.web.read`, host browser tools |
| 6 | People outside the company over chat, without accounts? | native: a public envoy on a conversation connection |
| 7 | Math, graphics or processing in the browser: 3D, CAD, physics, image or office documents? | native: JS and WASM dependencies in the bundle, not integrations |
| 8 | Touches an external system of record: ERP, accounting, HRIS, other SaaS? | mediated: model sync, webhook or request; the external system owns its data |
| 9 | Moves money, proves identity, or produces legally significant output? | mediated or certified: integrate a provider; the workspace implements workflow and handoff |
| 10 | Anything else: OS access, hardware, native apps, game-scale real-time, raw server execution, external databases? | not-appropriate: [limits-and-boundaries.md](limits-and-boundaries.md) |

## Probes

| Verdict | Confirm | If it fails |
| --- | --- | --- |
| native data | every state change is a `state` edge, grant or callback refusal | Q8 or Q9 |
| native computation | deterministic and auditable | Q5 or Q9 |
| native automation | trigger is a schedule or workspace event | external telemetry: mediated |
| native AI | an automation's infer or decide covers it with a structured output | the call goes through an integration |
| native envoy | does the person need an account? | account-required users are ordinary policies, still native |
| mediated | there is a provider whose business this is | no Bolt surface: not-appropriate |
| not-appropriate | the need is OS, hardware or scale outside a web workspace | |

## Rules of thumb

- A nameable third party means mediated or certified, not impossible.
- A native claim carries a primitive or precedent.
- Scale changes feasibility, not verdict: list it as an open question.
- Certified qualifies; report the native row and the certified row.
- Each jurisdiction is its own computation and certification row.
