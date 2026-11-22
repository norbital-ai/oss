# Plan template

Sections 1–8 are the stakeholder contract (business vocabulary; optional labelled build-notes line); 9–10 are for builders.

1. **Goal:** one paragraph — today, what changes, what done looks like.
2. **Who uses it:** role, job, may see, may change *(notes: policies, teams, approval checks, affiliation)*.
3. **What it manages:** things, non-derivable facts, states *(notes: model boundaries, inline values, effective periods, runtime config & versioning)*.
4. **How work flows:** numbered user steps + approvals *(notes: state edges, refusals, guarded writes, automations, approval routes)*.
5. **What people see:** role, screen, content *(notes: apps, pages, representations, view choices)*.
6. **Numbers and rules:** money, quantities, rounding, tax, caps, rules *(notes: money, roll-ups, CEL/BigDecimal, checks — missing rules get invented wrong)*.
7. **What connects to it:** external system, owner, in/out, boundary *(notes: integrations, syncs, sealed credentials, retries)*.
8. **What it does not do:** exclusions + reasons *(notes: feasibility verdicts)*.
9. **Build order:** dependency-ordered milestones (default: foundation → workflows → numbers → external → rollout) with done criteria.
10. **Open questions:** only plan-changing facts, with who can answer.

Close by asking if it matches; changes to 1–8 require re-confirmation.
