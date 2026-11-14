# Primitive mapping

Business requirement to default construction. Use the default unless a requirement breaks it.

## Data and lifecycles

| Requirement | Construction | Note |
| --- | --- | --- |
| A record with a lifecycle | model with a `state` field | history is built in |
| Independent lifecycles | separate models when identity, authority or evidence differs | screen sections do not require one |
| A fact that changes and must be provable | `period` + `no_overlap` constraint, successors by callback or automation | in-force is a read |
| A structured value, not a row | custom field | check built-in kinds first |
| Values of one parent | shaped JSON or custom datatype | child model only for row semantics |
| A child with row semantics under a parent lock | `owned` relationship | never delete by omission |
| Supported business variation | validated runtime records | source defines language and evaluator |
| Numbering | `seq` | never reused |
| Totals over children | `sum`, `count` | never a stored number kept in step |
| Deletion | none by default | deletions are grants; prefer terminal states |

## Rules and money

| Requirement | Construction | Note |
| --- | --- | --- |
| Money | `money` fields, std decimal | exact, never float |
| A document's amounts | derive once in the write pipeline; roll-ups for lines | never recompute in UI |
| A committed document | locks on leaving draft; lines snapshot prices | |
| A figure for audit | automation or callback over std formula and decimal | deterministic, replayable |
| Derived status | roll-up, computed field or query | never stored |
| A row invariant | `check`; cross-row is a callback refusal | who-may is a grant |

## Work

| Requirement | Construction | Note |
| --- | --- | --- |
| Schedule, event or webhook | automation | durable, reruns from the start, owns external I/O |
| Judgement | `sys_2.infer` structured output; `sys_1.decide` typed choices | the output shape is the contract |
| Research before deciding | automation with `ctx.web.read` and granted browser tools | |
| Computed read, or a write beyond verbs | read plus helper, or automation | |
| A screen beyond the table | a page with a shared view | `$derived`, one scroll owner, catalog copy |
| A report | root `aggregate` or roll-ups | never regroup in memory |
| A shared calculation | a plain `src/lib` module | |

## People

| Requirement | Construction | Note |
| --- | --- | --- |
| Internal permissions | policies and source teams | no team or policy editing UI |
| Approval | write grant `check` returning `ctx.approve` | any allow executes, else first approve, else first deny |
| Customers or vendors with accounts | external members scoped to `party` | invited from a party record |
| No accounts, forms | public app | create a submission, read published rows |
| No accounts, chat | public envoy on a conversation connection | unknown senders hold the envoy's policies alone |

## Outside world

| Requirement | Construction | Note |
| --- | --- | --- |
| Master data owned elsewhere | sync `read` with `$id`, `$version`, cursor | source fields protected; local annotations stay |
| Local records command elsewhere | sync `write` with engine idempotency | define which system owns each field |
| A provider writes in | integration `webhook` with `verify` and `handle` | unsigned deliveries refused |
| Workspace writes out | connection plus `ctx.request`, or sync `write` | stable request identity; verify retry behaviour |
| Browser SDK | page dependency | not an integration |
| Remote agent tools | MCP role | granted by policy |
| Secrets | `credential` per instance; `+secrets.ts` names | never in source or seeds |

## Anti-patterns

- Storing a derived number. Use a roll-up, computed field or query.
- Money computed in more than one place.
- System UUIDs or `*_id` keys in UI beyond the record-label fallback.
- Raw text in Svelte markup.
- `refetch` thinking: reads are live.
- Wide datasets regrouped in memory.
- One model, two lifecycles.
- Editing committed history: corrections are new records or transitions with reasons.
- A model created only to display a nested value.
