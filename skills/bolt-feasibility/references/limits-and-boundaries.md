# Limits and boundaries

What is **not-appropriate** on the Norbital platform, why, and what you can offer instead. The
test for this list is the same as for everything else: the platform is a hosted business-application
workspace with a web client, a hosted Postgres, and a bounded server runtime. Anything that needs a
different execution context lives outside.

## Not-appropriate

| Function                                                                                                | Why                                                                                                                                 | What you can offer instead                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Raw server execution: arbitrary binaries, daemons, native modules, OS access                            | Server code runs only as Bolt roles (hooks, pipelines, automations, remotes, agent tools, integrations) inside the platform runtime | Move the compute client-side (JS/WASM in the bundle), or delegate it to an external service through an integration |
| External databases                                                                                      | A workspace's data lives in its hosted Postgres                                                                                     | Sync via scheduled pulls / webhooks / sends; the external system stays the source                                  |
| Hardware and device access: POS hardware, IoT sensors, biometric readers, local filesystem, native push | The client is a browser in the workspace shell                                                                                      | Record device outputs through integrations or manual entry; alerting via workspace notifications/email/channels    |
| Native mobile or desktop distribution                                                                   | The product is a responsive web workspace, not an app-store app                                                                     | The workspace shell is mobile-responsive; external engagement through chat channels                                |
| Public websites and marketing sites                                                                     | Workspaces are internal business applications                                                                                       | External-facing interaction is channels + agent (chatbots), not public pages                                       |
| Game-scale real-time multiplayer                                                                        | The sync model is per-collection business data with optimistic mutations; SSE/WebSocket transport is not a game server              | Turn-based or shared-board style collaboration fits; continuous real-time does not                                 |
| An admin console                                                                                        | Configuration is source code (models, enums, policies, approval routing), not runtime UI                                            | Changes are made in the repository and deployed, with migrations                                                   |
| The platform's billing/metering as a tenant facility                                                    | `@norbital-ai/std` billing prices the platform itself                                                                               | Integrate a payment/billing provider for tenant-facing billing                                                     |
| Legal identity, KYC, or signing _validity_                                                              | A workspace is not an identity provider or an e-signature authority                                                                 | Integrate a provider (identity proofing, e-signature); store the attestation and its audit trail                   |
| Certified statutory output                                                                              | Certification belongs to a provider or regulator, not to software                                                                   | Implement the workflow, the computation, the file, and the handoff through the certified channel                   |

## Certification catalog

These are the classic "can be done but is not certified" functions. For each: the native part
(the workflow Bolt implements) and the certified part (the channel that completes it).

| Function           | Native part (Bolt)                                                                                                                           | Certified part (channel/provider)                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Payroll            | Attendance, leave, effective-dated facts, statutory configuration, computation (reckon), payslips, bank-file export, reconciliation guidance | Disbursing money through a bank; filing statutory contributions with the authority |
| Tax                | Tax configuration, calculation, returns, records                                                                                             | Filing and payment with the revenue authority                                      |
| E-signature        | Document preparation, signature workflow, binding-hash fingerprinting, audit trail                                                           | Legal validity of the signature (provider)                                         |
| Medical / clinical | Case records, scheduling, document management, compliance workflows                                                                          | Clinical certifications, device/regulatory approvals                               |
| Financial services | Onboarding workflows, records, reporting, audit                                                                                              | Operating licences, regulated custody, insured balances                            |

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
