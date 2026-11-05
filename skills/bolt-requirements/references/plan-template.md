# Plan template

Sections 1 to 8 are the confirmable contract: business vocabulary, no implementation detail. Each may carry a labelled build-notes line. Sections 9 and 10 are for builders.

| # | Section | Content | Build notes |
| --- | --- | --- | --- |
| 1 | Goal | one paragraph in the stakeholder's words: today, what changes, what done looks like | |
| 2 | Who uses it | role, job, may see, may change | policies, source teams, approval checks, member affiliation; no runtime editors |
| 3 | What it manages | thing, facts that are not derivable, states | model boundaries, inline values, effective periods, runtime configuration, how results keep the configuration they used |
| 4 | How work flows | numbered steps as a person performs them, approvals included | state edges, refusals, guarded writes, automations, approval routes |
| 5 | What people see | role, screen, useful content | apps, pages, representations, view choices |
| 6 | Numbers and rules | every money, quantity, rounding, tax, cap and rule decision | money fields, roll-ups, formula rules, checks, invariants |
| 7 | What connects to it | other side, what it owns, what comes in, what goes out, how they meet | integration definitions, syncs, connections, sealed credentials, retries |
| 8 | What it does not do | each exclusion with its reason | feasibility verdicts per exclusion |
| 9 | Build order | milestones in dependency order, each with what done means | |
| 10 | Open questions | only facts that change the plan, each with who can answer | |

Default build order: foundation (records and states), workflows, numbers, outside world, rollout.

A rule missing from section 6 will be invented later and usually wrong.

Close by asking: does this match what you need? Changes to 1 to 8 are plan changes: update and re-confirm. Changes to 9 and 10 are scheduling and facts.
