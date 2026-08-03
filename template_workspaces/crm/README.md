# CRM — How It Works

A quote-to-cash workspace for B2B distribution and trading: qualify accounts, quote from a catalogue,
confirm and fulfil orders, invoice, buy replenishment stock, and record money moving in both
directions.

## Orientation and boundaries

This is an executable Pod template, not a production-operations manual. It demonstrates a sales /
operations / procurement split, server-enforced document lifecycles, and money arithmetic that holds
up to reconciliation. Start with the workflow below, then use the [collections](#collections),
[apps](#apps), [remotes](#remotes), and [verification](#verification) sections when changing it.

The workspace owns commercial records, tenant users, policies, and document workflow. The host
authenticates the requestor and supplies external facilities. Ledger accounting, exchange-rate
sourcing, customer-facing document rendering, and carrier tracking stay outside this template.

For the template's goal, users, and extension boundaries, see the
[CRM documentation hub](./docs/README.md).

---

## How it works — the full user flow

### Quoting

1. A rep creates a quote against an account: title, currency, tax-inclusive flag, validity date, and
   whether the trade is `domestic` or `export`. The server assigns a sequential document number
   (`QT-2026-0001`).
2. Lines are added from the product catalogue. Each line snapshots the product code, name, unit, and
   price at creation, so later catalogue edits never rewrite a historical deal.
3. If an active `customer_prices` row exists for that account and product, the line takes the
   customer price instead of the catalogue price.
4. Each line computes `net`, `tax`, and `line_total` from the parent document's tax mode, and the
   parent's `net` / `tax` / `gross` are rolled up from the rounded line amounts.
5. The quote starts in `draft`, where lines are freely editable.

### Floor price and margin protection

`pricing_settings` holds a markup percentage per scope. Quote-line creation derives the floor from the
product's recorded cost and the applicable markup, then stores `below_floor` when the quoted unit
price falls under it.

The flag is advisory, not blocking: a rep can quote below floor deliberately, and the record carries
the evidence.

The floor itself is deliberately **not** stored on the line. Sales holds read on `quote_lines` and Pod
policies are collection-scoped rather than column-scoped, so a `floor_price` column here would hand
the sales floor the buy cost — the floor is cost times markup, and dividing one out recovers the
other. Only the boolean is persisted, which is the part anyone acts on and carries no cost basis.
Cost lives in `stock_levels` and `purchase_order_lines`, which sales has no grant for.

### Sending, revising, winning

- `draft → sent` delivers the quote to the customer.
- `sent → draft` reopens it for revision. The server increments `revision_number` and sets
  `revision_of`, forming a traceable V1 → V2 → V3 chain instead of duplicate deals.
- `draft → won` and `sent → won` record customer acceptance. `won` is a soft state: agreed
  commercially, not yet committed operationally.

### Operations confirmation and fulfilment

1. Operations moves a won quote to `confirmed`, which stamps `confirmed_at`. From this point the
   document also carries the fulfilment facts: shipping warehouse, logistics owner, payment terms,
   and shipping terms.
2. `confirmed → fulfilled` stamps `fulfilled_at`.
3. Confirmed and fulfilled documents lock their commercial fields — lines, prices, currency, and tax
   mode can no longer change. The operational fields stay editable so a shipment can be re-routed
   without reopening the deal.

`cancelled` and `lost` are terminal, except that a lost deal may be reopened to `won`. Cancellation
is refused when payments already exist against the document, and requires a `cancel_reason`.

### Invoicing

An invoice is raised against a confirmed or fulfilled quote and inherits its account, currency, and
tax mode. Invoice lines reference the originating quote line, and the server guards against
over-billing: the cumulative invoiced quantity for a quote line can never exceed the quantity sold.
This is what makes partial and staged billing safe across multiple invoices.

Invoices follow `draft → issued → settled`, with `cancelled` available before settlement. Issuing
requires at least one line.

### Purchasing

1. Procurement raises a purchase order against an active supplier. Supplier code, name, currency,
   and payment terms are snapshotted onto the document, and the server assigns a `PO-YYYY-NNNN`
   number.
2. Lines snapshot the product and default their unit cost from the product's recorded stock cost.
   Amounts use the purchase order's own tax mode and currency, not the sales side's.
3. Lifecycle is `draft → submitted → confirmed → received`, with `cancelled` blocked once payments
   exist. Submitting requires at least one line.

### Stock

`stock_levels` holds one row per product: quantity on hand, unit cost, and the timestamps at which
each was last established. `stock_lots` breaks that quantity down by warehouse and lot, with a
`sellable` flag.

Lot changes are authoritative: creating, updating, or deleting a lot recomputes the product's
on-hand quantity as the sum of its sellable lots and restamps `qty_as_of`. Unit cost is maintained
separately, since cost and quantity move for different reasons.

### Payments

`payment_records` is a single ledger for both directions. Exactly one of `quote_id` or
`purchase_order_id` is set, and `direction` (`incoming` / `outgoing`) is derived from which one it
is. The server validates that the parent document is in a state that can accept money, that the
payment currency matches the document currency, and that a settled payment is never moved to a
different document.

Receivable and payable status therefore both derive from one table rather than two parallel ledgers
that can disagree.

### Activities

Activities are polymorphic: `regarding_type` (`accounts`, `quotes`, `projects`) paired with
`regarding_id`. One table serves calls, meetings, emails, tasks, and notes across every entity.
Task activities default `due_date` to today when left blank.

### Pipeline and revenue views

- **Pipeline** is a kanban over the five active quote lanes; `cancelled` and `lost` are hidden.
  An owner dropdown, populated from `client.db.user`, re-runs the `pipeline_dashboard` remote.
- **Revenue** shows invoiced, paid, and outstanding totals plus per-order payment status, powered by
  the `revenue_summary` remote.

> **Known limitation:** pipeline and revenue totals sum raw currency amounts without conversion. A
> CNY 100,000 quote and a USD 100,000 quote each count as 100,000. Exchange-rate sourcing is out of
> scope, so either quote in one currency per view or add a rate collection and convert in the remote.

### External system interoperability

`external_synced_table` is a generic sync registry rather than a per-collection integration. Each row
records which tenant collection and record it maps to, the external system's own code and id, sync
direction, sync state, a payload hash for change detection, and the last error.

Around it:

- `+pipelines.ts` imports inbound records and exports the registry as CSV.
- `+integrations.ts` defines the connection, an hourly cursor-paged pull of changed records, and an
  outbound publish binding that fires on create and update for pending, non-inbound rows.
- The bearer token is declared in `src/+env.ts` as `EXTERNAL_SYSTEM_TOKEN` and read from the
  environment — never committed.

Because the registry is decoupled from the domain collections, pointing this at a different ERP means
changing the connection and field mapping, not the schema.

### Exporting

The quotes export pipeline produces `quote_<docno>.json` under the
`norbital.crm.interoperability.v1` schema plus `quote_<docno>_lines.csv`. These are integration and
audit artefacts, not customer-facing documents.

---

## Money arithmetic

All money passes through `src/lib/pricing.ts`, which is the only place rounding is decided:

- `roundHalfUp` rounds half away from zero via exponent shifting, so `1.005` at two decimal places
  gives `1.01` rather than the `1.00` that naive float multiplication produces.
- `lineAmounts` computes `net`, `tax`, and `gross` for a line, handling tax-exclusive and
  tax-inclusive modes.
- `documentTotals` sums already-rounded line amounts in minor units, so a document total always
  equals the sum of the lines a reader can see on it.
- `deriveFloorPrice` and `isBelowFloor` handle the cost-plus-markup floor across both tax modes.

`src/lib/numbering.ts` owns document numbering: `nextDocNo` derives the next sequence for a prefix
and year, giving `QT-YYYY-NNNN`, `PO-YYYY-NNNN`, and `INV-YYYY-NNNN` from one implementation.

---

## What the platform provides — do not rebuild it

The Pod platform supplies a `user` table, policies, audit trail, temporal history, notifications,
attachments, import/export pipelines, integrations, automations, live query, and the command palette.
This template authors domain models and rules on top of them.

Every quote, activity, and project stores an `owner_id` holding a user's `norbital_id`. The
`user.metadata` jsonb column is the designated extension point for operational attributes:

```json
{
	"telegram": "@rep_handle",
	"employee_id": "SL-042",
	"region": "east",
	"channel_preference": ["email"]
}
```

Do not create a `users`, `reps`, `sales_people`, or `profiles` collection, do not duplicate `email` /
`name` / `phone` onto tenant collections, and do not hand-roll access control. Contacts are
customer-facing entities and are deliberately distinct from platform users who operate the system.

---

## Collections

### Sales

| Collection         | Purpose                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `accounts`         | Customer companies, with a currency preference.                                                                                      |
| `contacts`         | People at accounts — decision-makers, buyers, day-to-day contacts.                                                                   |
| `products`         | Sellable catalogue, including specification fields and unit pricing.                                                                 |
| `customer_prices`  | Account-and-product price overrides. Quote-line creation prefers an active override to the catalogue price.                          |
| `pricing_settings` | Markup percentage per scope, used to derive quote-line floor prices.                                                                 |
| `projects`         | Customer or internal projects. Quotes and activities can reference one.                                                              |
| `quotes`           | Sales document and the pipeline itself: draft → sent → won, then confirmed → fulfilled. Carries fulfilment and terms once confirmed. |
| `quote_lines`      | Line items. Snapshot product data, compute net/tax/total, and flag below-floor pricing. Editable only while the parent is draft.     |
| `invoices`         | Billing document raised against a confirmed or fulfilled quote. draft → issued → settled.                                            |
| `invoice_lines`    | Invoice lines tied to a quote line, guarded against cumulative over-billing.                                                         |
| `activities`       | Polymorphic interaction log linked via `regarding_type` + `regarding_id`.                                                            |

### Procurement and stock

| Collection             | Purpose                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `suppliers`            | Vendors, with currency and payment terms that seed their purchase orders.                                   |
| `purchase_orders`      | Buy-side document: draft → submitted → confirmed → received. Snapshots supplier identity and terms.         |
| `purchase_order_lines` | Purchase lines. Default unit cost from recorded stock cost and compute amounts in the order's own tax mode. |
| `warehouses`           | Physical locations that hold stock and ship orders.                                                         |
| `stock_levels`         | One row per product: on-hand quantity, unit cost, and when each was last established.                       |
| `stock_lots`           | Quantity by product, warehouse, and lot, with a sellable flag. Lot changes recompute the product's on-hand. |

### Shared

| Collection              | Purpose                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `payment_records`       | One ledger for incoming and outgoing money, attached to exactly one sales or purchase document. |
| `external_synced_table` | Generic external-system sync registry: mapping, direction, state, payload hash, and last error. |

## Apps

| App               | Purpose                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `crm_sales`       | Sales workspace — pipeline lanes, accounts, contacts, catalogue, and projects.                                 |
| `crm_admin`       | Operations and finance workspace — order fulfilment, invoices, payments, revenue, quote lines, and activities. |
| `crm_procurement` | Buy-side workspace — purchase orders and lines, suppliers, warehouses, stock levels, and stock lots.           |

## Policies

Two roles ship with the workspace rather than being seeded, so a fresh database has them and a change
to either shows up in a diff.

| Policy                | App               | What it owns                                                                                                           |
| --------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `sales_rep`           | `crm_sales`       | Its own quotes and activities; reads accounts, contacts, catalogue, customer prices, and invoices raised on its deals. |
| `procurement_officer` | `crm_procurement` | Suppliers, purchase orders and lines, warehouses, stock, and outgoing payments.                                        |

The sales / procurement split is drawn by omission, not by masking. Pod policies are
collection-scoped rather than column-scoped, so the way to keep buy cost off the sales surface is to
grant no read on suppliers, purchase orders, purchase order lines, stock levels, pricing settings, or
outgoing payments at all. The boundary runs both ways: procurement gets no invoice grant, because an
invoice is a receivable carrying the sell price of every deal, and handing it over would give the buy
side the customer pricing the split exists to protect.

`crm_admin` is granted by neither. It is the whole-business view, and these two roles exist precisely
to divide that view.

## Remotes

| Remote                  | Purpose                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pipeline_dashboard`    | Stage-by-stage counts, total pipeline value, and kanban cards enriched with account names. Accepts `owner_id`. |
| `revenue_summary`       | Per-order invoiced, paid, and outstanding totals, filterable by currency.                                      |
| `procurement_dashboard` | Purchase-order counts by status, committed spend per currency, and payable status per order.                   |

## Automations

| Automation           | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `quote_expiry_watch` | Daily read-only report of sent quotes past `valid_until`. |
| `user_onboarding`    | Reacts to new tenant users.                               |

## The sales desk channel

`src/channels/+sales_desk.channel.ts` puts the workspace on Telegram as a customer-facing sales desk.
The agent answers there under the `sales_rep` policy, so an inbound question reaches quote and account
data through exactly the grants a rep already has — a channel is another caller of the permission
model, never a way around it.

That is also why `sales_rep` holds read on invoices even though `crm_sales` surfaces no invoice table.
"Has my order been billed, and when is it due" reaches the agent long before it reaches a screen.

## State machines

Sales document:

```
draft ──→ sent ──→ won ──→ confirmed ──→ fulfilled
  ▲         │        │
  └─────────┘        └──→ cancelled (terminal, blocked when payments exist)
                     │
                     └──→ lost (terminal, except lost → won)
```

Purchase order: `draft → submitted → confirmed → received`, with `cancelled` reachable before
receipt and blocked once payments exist.

Invoice: `draft → issued → settled`, with `cancelled` reachable before settlement.

---

## Not in scope

Deliberate omissions, each of which should be added as explicit collections, remotes, integrations,
and policies rather than as untracked process workarounds:

- Partial fulfilment and shipment tracking — fulfilment is a single document-level state, with no
  shipment entity, container, or bill-of-lading number.
- Effective-dated catalogue prices — a price change overwrites the current value; history is not
  queryable.
- Exchange-rate sourcing and multi-currency roll-up.
- Customer-facing document rendering (PDF quotations, proforma and commercial invoices).
- Ledger accounting, sales targets, and commissions.
- Messaging-channel delivery to customers.

Platform-level constraint worth knowing: `owner_id` columns render as raw UUIDs in `CollectionTable`,
because Pod relationships do not target platform tables. The pipeline filter works around this by
populating a dropdown from `client.db.user`.

## Verification

```bash
pnpm --dir template_workspaces/crm sync
pnpm --dir template_workspaces/crm lint
pnpm --dir template_workspaces/crm build
```

`sync` may create or update `.norbital/migrations/`; commit that migration history with the authored
change. Publish the revised template and deploy a new tenant checkpoint before it affects an existing
tenant. See the [template lifecycle](../README.md#release-and-tenant-lifecycle) and the
[Pod overview](../../packages/pod/docs/OVERVIEW.md).
