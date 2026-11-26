# Limits and boundaries

Norbital is a hosted web workspace with isolated Postgres and a bounded server guest (public SSR reads as admitted caller with no writes/Node APIs/credentials).

## Not-appropriate

| Function | Alternative |
| --- | --- |
| Raw server binaries, daemons, native addons, OS access | client JS/WASM or external service via integration |
| External databases | mirror via `sqlserver`/`http` sync |
| Hardware/device access (POS, IoT, biometrics, local FS, native push) | integration or manual entry + notifications |
| Native mobile/desktop app stores | responsive web / mobile shell / envoys |
| Game-scale real-time multiplayer | turn-based or shared-board collaboration |
| Runtime editors for source, schema or policies | runtime catalogues for supported variation; source change for new capability |
| Tenant payment via platform billing; legal KYC/e-signature validity; certified statutory filing | integrate a provider; store attestation, workflow, computation, files & audit trail |

## Certification catalog

Promise the workflow, calculation and handoff — never the regulated certification:
- **Payroll / Tax:** attendance, leave, rules, calculation, payslips, returns, bank-file export (native) vs bank disbursement / authority filing (certified).
- **E-signature / Medical / Financial:** document prep, binding hash, case records, compliance workflows, reporting, audit (native) vs legal validity, clinical/device approvals, regulated custody/licences (certified).
