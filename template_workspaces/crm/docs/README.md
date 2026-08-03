# CRM documentation

## Goal

Run a B2B deal from account qualification through quote revision, operational confirmation, fulfilment,
invoicing, and payment — and run the buy side and stock position that make those commitments
deliverable — without losing the commercial evidence behind each step.

## Who it serves

| User        | Outcome                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Sales       | Owns accounts, contacts, catalogue-backed quotes, and the active pipeline.                       |
| Operations  | Confirms won quotes, records fulfilment, and manages shipping warehouse and terms.               |
| Finance     | Issues invoices, records currency-matched payments, and reviews invoiced, paid, and outstanding. |
| Procurement | Raises purchase orders against suppliers and maintains stock levels and lots.                    |

## Workspace guarantees

- Quote lines snapshot product data when created; later catalogue edits do not rewrite history.
- A sent quote can return to draft as a linked revision rather than a duplicate deal.
- Server hooks enforce valid document transitions and block cancellation when payments exist.
- Customer-specific active prices override a catalogue price, and a markup-derived floor price flags
  below-floor selling without blocking it.
- Invoicing cannot exceed the quantity sold on the originating quote line.
- Payments are positive, use the parent document currency, and attach to exactly one sales or
  purchase document.
- Document totals equal the sum of their rounded lines, because all rounding goes through
  `src/lib/pricing.ts`.

## Scope boundary

This workspace covers quote-to-cash plus the procurement and stock position behind it. It does not
provide ledger accounting, exchange-rate conversion, partial shipment or carrier tracking,
customer-facing PDF rendering, or messaging-channel delivery. Add those as explicit collections,
remotes, integrations, and policies — not as untracked process workarounds.

External system synchronisation is deliberately generic: `external_synced_table` plus its pipelines
and integrations, rather than per-collection coupling to a specific ERP.

## Start points

- [Workspace README](../README.md) — end-to-end workflow, money arithmetic, and verification.
- `src/lib/pricing.ts` and `src/lib/numbering.ts` — rounding, tax modes, floor price, document numbers.
- `src/collections/quotes/+hooks.ts` — sales lifecycle and revision rules.
- `src/collections/quote_lines/+hooks.ts` — price snapshot, floor derivation, draft-only line editing.
- `src/collections/purchase_orders/+hooks.ts` and `src/collections/invoices/+hooks.ts` — buy-side and
  billing lifecycles.
- `src/collections/external_synced_table/+integrations.ts` — outbound and inbound sync wiring.
- `src/remotes/+pipeline_dashboard.ts`, `+revenue_summary.ts` and `+procurement_dashboard.ts` — the
  sales, revenue and buy-side summaries behind each app's header.
- `src/policies/+sales_rep.policy.ts` and `+procurement_officer.policy.ts` — where the sales /
  procurement boundary is actually drawn, and why each omission is deliberate.
- `src/channels/+sales_desk.channel.ts` — the Telegram sales desk, answering under the sales policy.
