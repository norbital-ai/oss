# Limits and boundaries

The platform is a hosted workspace with a web client, hosted Postgres and a bounded server runtime. Anything needing a different execution context lives outside.

## Not-appropriate

| Function | Why | Offer instead |
| --- | --- | --- |
| Raw server execution, binaries, daemons, native modules, OS access | server code runs only as Bolt roles in a bounded isolate | client-side JS or WASM, or an external service through an integration |
| External databases | data lives in hosted Postgres | mirror through a sync over an `sqlserver` or `http` integration; the external system stays the source |
| Hardware and device access: POS, IoT, biometrics, local filesystem, native push | the client is a browser | device outputs through integrations or manual entry; alerts through notifications |
| Native mobile or desktop distribution | a responsive web workspace | the mobile shell; envoys for external engagement |
| Game-scale real-time multiplayer | sync is per-model business data | turn-based or shared-board collaboration |
| Source, schema or policy editing as a runtime record editor | runtime configuration chooses only what source admits | model views for supported catalogues; source change for new capability |
| Platform billing as a tenant facility | it prices the platform | a payment provider |
| Legal identity, KYC, signing validity | a workspace is no identity provider or signature authority | a provider; store the attestation and audit trail |
| Certified statutory output | certification belongs to a provider or regulator | workflow, computation, file, handoff |

## Public pages

Public and external apps support sites through SSR and requested-page hydration. A loader reads as the admitted caller in the bounded guest, with no writes, facilities, credentials or Node APIs. Interactive writes use the normal authorized protocol. This adds no arbitrary server processes or routes.

## Certification catalog

| Function | Native part | Certified part |
| --- | --- | --- |
| Payroll | attendance, leave, effective-dated facts, statutory configuration, computation, payslips, bank-file export | disbursing through a bank; filing contributions |
| Tax | configuration, calculation, returns, records | filing and payment with the authority |
| E-signature | document preparation, signature workflow, binding-hash fingerprint, audit trail | legal validity |
| Medical | case records, scheduling, documents, compliance workflows | clinical and device approvals |
| Financial services | onboarding, records, reporting, audit | licences, regulated custody, insured balances |

Promise the workflow and the computation; never the certification.

## Error directions

- Overpromise: claiming native for a certified channel or external system. Ask what happens when the authority or provider must accept this.
- Underpromise: declaring a specialised thing impossible when it is a client-side library or integration. Check the inventory first.
