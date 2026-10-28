# Limits and boundaries

What is **not-appropriate** on the Norbital platform, why, and what you can offer instead. The
test for this list is the same as for everything else: the platform is a hosted business-application
workspace with a web client, a hosted Postgres, and a bounded server runtime. Anything that needs a
different execution context lives outside.

## Not-appropriate

| Function                                                                                                | Why                                                                                                                                                    | What you can offer instead                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw server execution: arbitrary binaries, daemons, native modules, OS access                            | Server code runs only as Bolt roles (inline write callbacks, policy checks, syncs, notices, automations and integration tests) in a bounded isolate | Move the compute client-side (JS/WASM in the bundle), or delegate it to an external service through an integration                                        |
| External databases                                                                                      | A workspace's data lives in its hosted Postgres                                                                                                        | Mirror it through a model sync's `read` over an `sqlserver` or `http` integration and hand back through its `write`; the external system stays the source |
| Hardware and device access: POS hardware, IoT sensors, biometric readers, local filesystem, native push | The client is a browser in the workspace shell                                                                                                         | Record device outputs through integrations or manual entry; alerting via workspace notifications on email or chat connections                             |
| Native mobile or desktop distribution                                                                   | The product is a responsive web workspace, not an app-store app                                                                                        | The workspace shell is mobile-responsive; external engagement through an envoy on WhatsApp, Telegram or email                                             |
| Game-scale real-time multiplayer                                                                        | The sync model is per-model business data with optimistic mutations; SSE/WebSocket transport is not a game server                                 | Turn-based or shared-board style collaboration fits; continuous real-time does not                                                                        |
| Arbitrary source/schema/policy editing exposed as a runtime record editor                               | Runtime configuration can choose only behaviour the source contracts admit                                                                             | Build normal model views for supported catalogues, rates, business schemas or integration instances; change source to add new capabilities           |
| The platform's billing/metering as a tenant facility                                                    | `@norbital-ai/std` billing prices the platform itself                                                                                                  | Integrate a payment/billing provider for tenant-facing billing                                                                                            |
| Legal identity, KYC, or signing _validity_                                                              | A workspace is not an identity provider or an e-signature authority                                                                                    | Integrate a provider (identity proofing, e-signature); store the attestation and its audit trail                                                          |
| Certified statutory output                                                                              | Certification belongs to a provider or regulator, not to software                                                                                      | Implement the workflow, the computation, the file, and the handoff through the certified channel                                                          |

## Public page boundary

Public and external workspace apps support sites, including marketing pages, through server-rendered
Svelte pages and requested-page hydration. Each page declares a `pageServer` loader and shared data
codec. The loader reads as the admitted caller inside the bounded guest; it has no writes, host
facilities, credentials or Node APIs. Components render synchronously, and interactive writes use
the existing browser protocol and authorization. Workspace routing and runtime limits still apply;
this capability does not supply arbitrary server processes or routes. See
`oss/packages/bolt/docs/client-bundling.md` for the authoring and host contract. Source support is
distinct from final-source browser acceptance.

## Certification catalog

These are the classic "can be done but is not certified" functions. For each: the native part
(the workflow Bolt implements) and the certified part (the channel that completes it).

| Function           | Native part (Bolt)                                                                                                                                  | Certified part (channel/provider)                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Payroll            | Attendance, leave, effective-dated facts, statutory configuration, computation (`std/formula`), payslips, bank-file export, reconciliation guidance | Disbursing money through a bank; filing statutory contributions with the authority |
| Tax                | Tax configuration, calculation, returns, records                                                                                                    | Filing and payment with the revenue authority                                      |
| E-signature        | Document preparation, signature workflow, binding-hash fingerprinting, audit trail                                                                  | Legal validity of the signature (provider)                                         |
| Medical / clinical | Case records, scheduling, document management, compliance workflows                                                                                 | Clinical certifications, device/regulatory approvals                               |
| Financial services | Onboarding workflows, records, reporting, audit                                                                                                     | Operating licences, regulated custody, insured balances                            |

The rule: **promise the workflow and the computation; never the certification.**

## Error directions

Two ways to get a feasibility answer wrong, and how to catch each:

- **Overpromise** (the expensive error): claiming native for something that needs a certified
  channel or an external system. Catch: ask "what happens when the authority/provider needs to
  receive or accept this?" If there is a mandatory outside party, the verdict is mediated or
  certified.
- **Underpromise**: declaring something impossible because it sounds specialised, when it is a
  client-side library or an integration. Catch: check the capability inventory and precedent
  before saying no — CAD review, physics simulation, and volumetric visualisation are browser
  libraries, not platform gaps.
