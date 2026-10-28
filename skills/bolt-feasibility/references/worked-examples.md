# Worked examples

Complete verdicts for classic asks, in the SOP 5 format. Use them as shape and evidence: they are
not a substitute for decomposing the specific request, and every row must be re-checked against the
actual ask (jurisdiction, volume, existing systems).

## "We want a CRM with invoicing and tax filing"

| Sub-function                                | Verdict   | How it is built                                                                      | Boundary                                          |
| ------------------------------------------- | --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Account and pipeline management             | native    | models + state lifecycles + boards                                              | —                                                 |
| Catalogue-backed quoting, revision-safe     | native    | quotes + snapshot line items, money computed in one place                            | —                                                 |
| Purchasing, goods receipts, three-way match | native    | order/invoice models with match checkpoint                                      | —                                                 |
| Master data from the ERP                    | mediated  | scheduled pulls with cursor + identity; mirrors in, documents out                    | the ERP owns customers, items, vendors            |
| Payment capture and settlement              | mediated  | integration to a payment provider; settlements reconciled against documents          | money movement is the provider's                  |
| Tax computation on documents                | native    | tax modes and rounding are first-class                                               | jurisdiction configuration lives in the workspace |
| Tax filing                                  | certified | records and export prepared in-workspace; submission through the authority's channel | filing is valid only through that channel         |

Precedent: norbital-hq demonstrates contact and activity management; trade-operations demonstrates
commercial documents and external-system reconciliation. Verify invoice and filing requirements
separately rather than treating either template as proof of the complete request. The
hr-payroll template is the reference for statutory configuration and export.

## "Payroll for our company"

| Sub-function                                   | Verdict   | How it is built                                                   | Boundary                       |
| ---------------------------------------------- | --------- | ----------------------------------------------------------------- | ------------------------------ |
| Employee facts, effective-dated, multi-country | native    | models + effective-dated facts                               | —                              |
| Attendance, leave, rostering, time entries     | native    | models + automations                                         | —                              |
| Contribution and eligibility computation       | native    | std/formula rules, custom fields                                  | —                              |
| Payroll runs, payslips, XLSX export            | native    | settlement automations, stored payslip values and `with: 'file'` export syncs | —                              |
| Disbursing pay                                 | mediated  | bank file handoff through a bank's channel                        | the bank moves money           |
| Statutory filing per jurisdiction              | certified | prepared and reconciled in-workspace; filed through the authority | certification per jurisdiction |

Precedent: the hr-payroll template is the native half of this table.

## "Inventory and warehouse management"

| Sub-function                             | Verdict  | How it is built                                                                     | Boundary                              |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------------- | ------------------------------------- |
| Item catalogue with stock position       | native   | models; stock position derived, never stored                                   | —                                     |
| Movements, receipts, issues, adjustments | native   | immutable event models + roll-ups for balances                                 | —                                     |
| Reorder triggers and expiry watches      | native   | automations + notifications/email                                                   | —                                     |
| Barcode / RFID scanning                  | mediated | scan capture via client-side camera/scanning library or handheld device integration | device specifics belong to the device |
| Live telemetry from warehouse systems    | mediated | integration pulls                                                                   | external system owns the sensors      |

## "Review CAD files and do volumetric take-offs"

| Sub-function                                       | Verdict  | How it is built                                                                                       | Boundary                                                             |
| -------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| View, rotate, measure CAD/3D models in the browser | native   | client-side library (three.js-class) bundled into the app                                             | —                                                                    |
| Annotate and link models to project records        | native   | models + apps                                                                                    | —                                                                    |
| Volumetric computation from geometry               | native   | WASM/JS computation client-side, or server-side in an automation                                          | heavy batch analysis may be delegated to an external compute service |
| Import model files                                 | mediated | upload + conversion via a format library; formats the bundle cannot parse go through a conversion API | proprietary formats need their vendor                                |

## "Physics simulation for load planning"

| Sub-function                          | Verdict  | How it is built                                     | Boundary                       |
| ------------------------------------- | -------- | --------------------------------------------------- | ------------------------------ |
| Interactive simulation in the browser | native   | physics engine library (matter.js-class) in the app | —                              |
| Scenario storage and comparison       | native   | models; results snapshotted as JSONB           | —                              |
| Heavy batch simulation at scale       | mediated | outbound send to a simulation service               | compute belongs to the service |

## "Customer KYC onboarding"

| Sub-function                                     | Verdict   | How it is built                                               | Boundary                            |
| ------------------------------------------------ | --------- | ------------------------------------------------------------- | ----------------------------------- |
| Onboarding workflow, document collection, status | native    | models + approvals + file upload                         | —                                   |
| Identity verification                            | mediated  | integration to a KYC provider; attestation stored with audit  | the provider proves identity        |
| Regulatory reporting of flagged cases            | certified | workflow + export; submission through the regulator's channel | reporting validity is the channel's |

## "A customer-facing chatbot"

| Sub-function                                | Verdict  | How it is built                                                                                                                                                                                                                                          | Boundary                                  |
| ------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| External chat with the workspace agent      | native   | a `public` envoy on a conversation connection; unknown senders act under the envoy's policies alone (operands null except `{ var: 'requestor.instance' }`), so they get only what the policy grants everyone on that instance                                    | —                                         |
| Reading and updating the user's own records | native   | per-person scoping needs a linked member: a `private` envoy, or a DM with `dm: 'envoy'` to bind operands to the member without their wider authority; precedent: the hr-payroll payroll hotline (own payslips of the entity whose number was written to) | —                                         |
| Escalation to staff                         | native   | notifications + guarded writes or automations                                                                                                                                                                                                                                  | —                                         |
| Integration with the customer's own systems | mediated | model syncs / webhooks / `ctx.request` / MCP                                                                                                                                                                                                             | the customer's system is the record owner |

Precedent: field-operations is the private, linked-member case (contractors over WhatsApp, scoped
policies, photo integrity).

## "Live multiplayer operations game"

| Sub-function                               | Verdict         | How it is built                     | Boundary                                                                                                 |
| ------------------------------------------ | --------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| The game itself                            | not-appropriate | —                                   | continuous real-time multiplayer is outside the sync model; SSE/WebSocket transport is not a game server |
| Player/team rosters, scores, league tables | native          | models + apps                  | —                                                                                                        |
| Turn-based play, planning, results         | native          | models + automations + guarded writes | —                                                                                                        |
