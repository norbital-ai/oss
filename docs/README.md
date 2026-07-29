# CRM documentation

## Goal

Run a B2B deal from account qualification through quote revision, operational confirmation, fulfilment,
payment recording, and customer activity history—without losing the commercial evidence behind each step.

## Who it serves

| User       | Outcome                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Sales      | Owns accounts, contacts, catalogue-backed quotes, and the active pipeline.                       |
| Operations | Confirms won quotes after ERP handoff, records fulfilment, and manages payment visibility.       |
| Finance    | Records currency-matched incoming payments and reviews invoiced, paid, and outstanding balances. |

## Core guarantees

- Quote lines snapshot product data when created; later catalogue edits do not rewrite history.
- A sent quote can return to draft to create a linked revision rather than a duplicate deal.
- Server hooks enforce valid quote transitions and block cancellation when payments exist.
- Customer-specific active prices can override a catalogue price for a quote line.
- Payments are positive, use the order currency, and apply only to eligible order states.

## Scope boundary

This workspace is a CRM and quote-to-cash workflow. It does not provide inventory, supplier purchasing,
margin, partial shipment, exchange-rate conversion, customer-facing PDF documents, or messaging-channel
delivery. Add those capabilities as explicit collections, remotes, integrations, and policies—not as
untracked process workarounds.

## Start points

- [Workspace README](../README.md) — end-to-end workflow, known limitations, and verification.
- `src/collections/quotes/+hooks.ts` — lifecycle and revision rules.
- `src/collections/quote_lines/+hooks.ts` — price snapshot and draft-only line editing.
- `src/remotes/+pipeline_dashboard.ts` and `+revenue_summary.ts` — sales and revenue summaries.
