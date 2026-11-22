# Classification rules

Ask in order; first yes decides. Between two tiers pick the lower and explain why (overpromising is costlier).

1. **Data & workflow** (records, states, permissions, approvals) → `native`: models, `state`, locks, policies, apps.
2. **Deterministic rules & math** (money, eligibility, rates, accruals, statutory calcs) → `native`: CEL + Effect `BigDecimal`, callbacks, aggregates/roll-ups.
3. **Scheduled or event-driven work** → `native`: automations + model effects (external telemetry → `mediated`).
4. **Custom screens, dashboards, public/external sites, portals, kiosks** → `native`: apps, SSR `ctx.query`, automations, agent.
5. **AI judgement** (classification, extraction, drafting, structured research) → `native`: `ctx.ai.sys_1`/`sys_2`, `ctx.web.read`, browser.
6. **External chat without accounts** → `native`: public envoy on conversation connection (account users → ordinary policies, still native).
7. **Browser math/graphics/parsing** (3D, CAD, office/image WASM) → `native`: client JS/WASM bundle.
8. **External system of record** (ERP, accounting, HRIS, SaaS) → `mediated`: model sync, webhook or `ctx.request`.
9. **Moves money, proves legal identity, or legally certified output** → `mediated` or `certified`: integrate provider; Bolt owns workflow/computation/handoff.
10. **OS access, hardware, native apps, game-scale real-time, raw server processes, external DBs** → `not-appropriate`: [limits-and-boundaries.md](limits-and-boundaries.md).

Rules: name a primitive/precedent for every `native` claim; list scale as an open question; report each jurisdiction's computation and certification row separately.
