# CRM — How It Works

A B2B trade workspace with two sides, bridged into the company's external system of record (an
ERP or accounting system that owns the master data): the **sales side** qualifies accounts and
contacts, quotes from a product catalogue, runs the pipeline to won, and confirms the deal; the
**purchase side** raises purchase orders against suppliers and confirms the buy. Both sides hand
their committed documents across the boundary. One entry, no re-keying.

This is an executable Pod template, not a production-operations manual. It demonstrates a sales
pipeline and a buying pipeline with server-enforced document lifecycles, revision-safe quoting,
snapshot line items, money arithmetic that holds up to reconciliation, a cost-secrecy boundary
between the two sides, and a sync registry that keeps the workspace in step with an external
system. Start with the workflow below, then use the [collections](#collections),
[app](#app), [policy](#policy), and [verification](#verification) sections when changing it.

The workspace owns commercial records, tenant users, and policies. The host authenticates the
requestor and supplies external facilities.

## Orientation and boundaries

- **Sales owns the commercial record** — accounts, contacts, quotes, lines, and the interaction
  log. Sales people operate the pipeline; the policy scopes each rep to their own deals.
- **Procurement owns the buy side** — suppliers, purchase orders, and their lines, including the
  unit cost a buy is struck at. The sales policy has no grant for any of it, which is what keeps
  cost off the sales surface — Pod policies are collection-scoped, so the boundary is drawn by
  omission of grants, and the cost column lives only on the buy-side document.
- **The external system owns the master data.** Customers, items, and suppliers mirror _in_; the
  workspace never invents a customer, an item, or a vendor. Confirmed quotes and confirmed
  purchase orders go _out_ — that is the handoff the whole bridge exists for.
- **The platform owns the plumbing** — users, teams, policies, audit trail, temporal history,
  notifications, attachments, import/export pipelines, integrations, automations, live query, and
  the command palette. This workspace authors domain models and rules on top of them.
- **Stock, warehousing, payment tracking, and ledger accounting stay outside** — see
  [Not in scope](#not-in-scope).

## The user flow

### Quoting

1. A rep creates a quote against an account: title, currency, tax-inclusive flag, validity date,
   and owner. The server assigns a sequential document number (`QT-2026-0001`).
2. Lines are added from the product catalogue. Each line snapshots the product code, name, unit,
   and price at creation, so later catalogue edits never rewrite a historical deal.
3. Each line computes `net`, `tax`, and `line_total` from the parent document's tax mode, and the
   parent's `net` / `tax` / `gross` are rolled up from the rounded line amounts.

### Sending, revising, winning

- `draft → sent` delivers the quote to the customer.
- `sent → draft` reopens it for revision. The server increments `revision_number` and sets
  `revision_of`, forming a traceable V1 → V2 → V3 chain instead of duplicate deals.
- `draft → won` and `sent → won` record customer acceptance.
- `won → confirmed` is the committed sale — the state the external system books. A confirmed
  document is terminal, which is what makes its figures safe to hand across the boundary.
- `lost` and `cancelled` are terminal, except that a lost deal may be reopened to `won`. Cancelling
  requires a `cancel_reason`.

Only `draft` documents are editable — lines, prices, and terms lock once a document leaves draft.

### Buying

1. A procurement officer raises a purchase order against an active supplier. Supplier code, name,
   and currency are snapshotted onto the document, and the server assigns a `PO-YYYY-NNNN` number.
   The order's expected date defaults two weeks out.
2. Lines snapshot the product and carry the unit cost the buy is struck at — required, entered by
   the purchaser, and never derived from the sales catalogue. Amounts use the order's own tax mode
   and currency.
3. `draft → submitted` requires at least one line; `submitted → confirmed` is the committed buy —
   the state the external system books, and terminal. `cancelled` is available before confirmation
   and requires a `cancel_reason`.

### Pipeline

The pipeline tab is a kanban over the active quote statuses; `cancelled` is hidden. An owner
filter, populated from `client.db.user`, re-runs the `pipeline_dashboard` remote so reps can focus
their own lane.

### Activities

Activities are polymorphic: `regarding_type` (`accounts`, `quotes`) paired with `regarding_id`.
One table serves calls, meetings, emails, tasks, and notes across every entity. Task activities
default `due_date` to today when left blank.

## The external-system bridge

An external system of record (typically an ERP or accounting system) owns the master data — and
**the sync writes straight into our tables**. `accounts`, `products`, and `suppliers` _are_ the
mirrors: each row carries the system's own key in `external_code`, and the workspace reads and
edits the mirror directly. Confirmed quotes and confirmed purchase orders go **out** — the
accounting system books them, and its own references come back.

**Inbound — the ERP syncs over to our table.** Each mirror collection declares a `receive.pull`
binding in its `+integrations.ts`. The platform runs it on its schedule: fetch with the
connection's credential, parse the body against the binding's schema, hand it to the collection's
`import` pipeline, and write the rows the pipeline returns into that collection. The resume point
is the platform's own cursor (`integration_cursor`), so a missed window resumes where it stopped.
The import pipeline skips codes already on file — the unique index on `external_code` is the
backstop against a re-delivered page.

**Outbound — the confirmed document is handed over.** Each document collection declares a `send`
binding in its `+integrations.ts` that matches the `draft → confirmed` transition. A mutation that
matches writes the record to the platform's transactional outbox in the same transaction — a
delivery is never queued for a write that rolled back. The host drains the outbox: the collection's
`export` pipeline builds the payload (field-enumerated, so cost and other internal facts can never
serialize), the binding's `transform` shapes it into the request body, and delivery retries with
capped backoff and dead-letters after ten attempts.

The connection is declared once per collection and compared by value: `baseUrl` is a deployment
fact (placeholder until the tenant's connectivity is provisioned) and the bearer token is a
reference into `src/+env.ts` — never a secret in the workspace.

## Money arithmetic

All money passes through `src/lib/pricing.ts`, which is the only place rounding is decided:

- `roundHalfUp` rounds half away from zero via exponent shifting, so `1.005` at two decimal places
  gives `1.01` rather than the `1.00` that naive float multiplication produces.
- `lineAmounts` computes `net`, `tax`, and `gross` for a line, handling tax-exclusive and
  tax-inclusive modes. Tax-inclusive lines take tax as the _residual_ `gross − net`, so the three
  figures always add up exactly as printed.
- `documentTotals` sums already-rounded line amounts in minor units, so a document total always
  equals the sum of the lines a reader can see on it.

`src/lib/numbering.ts` owns document numbering: `nextDocNo` derives the next sequence for a prefix
and year, giving `QT-YYYY-NNNN` from one implementation. The unique index on `doc_no` is what
actually guarantees uniqueness; the loser's transaction fails and is retried rather than quietly
issuing a duplicate.

## What the platform provides — do not rebuild it

The Pod platform supplies a `user` table, teams, policies, audit trail, temporal history,
notifications, attachments, import/export pipelines, integrations, automations, live query, and the
command palette. This template authors domain models and rules on top of them.

Every quote and activity stores an `owner_id` holding a user's `norbital_id`. The `user.metadata`
jsonb column is the designated extension point for operational attributes:

```json
{
	"telegram": "@rep_handle",
	"employee_id": "SL-042",
	"region": "east",
	"channel_preference": ["email"]
}
```

Do not create a `users`, `reps`, `sales_people`, or `profiles` collection, do not duplicate
`email` / `name` / `phone` onto tenant collections, and do not hand-roll access control. Contacts
are customer-facing entities and are deliberately distinct from platform users who operate the
system.

## Collections

### Sales

| Collection    | Purpose                                                                               |
| ------------- | ------------------------------------------------------------------------------------- |
| `accounts`    | Customer companies, mirrored in from the system of record.                            |
| `contacts`    | People at accounts — decision-makers, buyers, day-to-day contacts.                    |
| `quotes`      | The sales pipeline: draft → sent → won → confirmed, with lost and cancelled terminal. |
| `quote_lines` | Line items. Snapshot product data, compute net/tax/total. Editable only while draft.  |
| `activities`  | Polymorphic interaction log linked via `regarding_type` + `regarding_id`.             |

### Shared

| Collection | Purpose                                                                              |
| ---------- | ------------------------------------------------------------------------------------ |
| `products` | Sellable catalogue, mirrored in from the system of record. Carries sell prices only. |

### Procurement

| Collection             | Purpose                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `suppliers`            | Vendors the business buys from, mirrored in from the system of record.                |
| `purchase_orders`      | The buying pipeline: draft → submitted → confirmed, with cancelled terminal.          |
| `purchase_order_lines` | Line items. Snapshot product data, carry the struck unit cost, compute net/tax/total. |

## Apps

| App            | Purpose                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| `crm`          | Sales — pipeline kanban, quotes, quote lines, accounts, contacts, activities. |
| `crm_purchase` | Procurement — dashboard, purchase orders, PO lines, suppliers.                |

## Policies

Two roles ship with the workspace rather than being seeded, so a fresh database has them and a
change to either shows up in a diff.

| Policy                | App            | What it owns                                                                 |
| --------------------- | -------------- | ---------------------------------------------------------------------------- |
| `sales_rep`           | `crm`          | Its own quotes and quote lines; reads accounts, contacts, and the catalogue. |
| `procurement_officer` | `crm_purchase` | Suppliers, purchase orders and lines, and the catalogue.                     |

The sales/procurement split is drawn by omission, not by masking. Pod policies are
collection-scoped, so buy cost stays off the sales surface because sales has no grant for
`purchase_order_lines` (the only collection that carries a cost column) — and the buy side
gets no quote grant, so it never sees sell prices or margin. The shared catalogue grants read to
both roles and exposes sell prices only. Quote reads and edits are scoped to the requestor via
`${requestor.norbital_id}`; purchase orders are granted to the procurement role as a whole.

## Remotes

| Remote                  | Purpose                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `pipeline_dashboard`    | Pipeline cards enriched with account names. Accepts `owner_id`.   |
| `procurement_dashboard` | PO counts by status, committed spend per currency, top suppliers. |

## Automation

| Automation           | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `quote_expiry_watch` | Daily read-only report of sent quotes past `valid_until`. |

## State machines

Sales document:

```
draft ──→ sent ──→ won ──→ confirmed (terminal — the state the system of record books)
  ▲         │
  └─────────┘        (revision: sent ──→ draft increments revision_number)
won ──→ lost ──→ won (lost may be reopened)
won ──→ cancelled (terminal, requires a cancel_reason)
```

Purchase order:

```
draft ──→ submitted ──→ confirmed (terminal — the state the system of record books)
   │           │
   └── cancelled (before confirmation, requires a cancel_reason)
```

## Extending the workspace

Additions should be explicit collections, remotes, integrations, and policies, never untracked
process workarounds:

- **A second sales document type** (e.g. a sales order or billing document): follow the quote
  pattern — header + lines, gapless numbering, lifecycle hook, snapshot rule, outbound sync rows
  once the document is committed.
- **A cost ledger**: a buy-side collection holding per-product cost (the source the purchase order
  line hook defaults its unit cost from), granted to procurement only — the extension that makes
  unit cost first-class without leaking it to sales.
- **A payment layer**: a settlement/ledger collection fed by the external system, with derived
  paid/partial/unpaid status — never hand-maintained per document.
- **Customer-facing rendering** (quotations as PDFs): the platform's export/print facilities, not
  a new schema.

## Not in scope

Deliberate omissions, each of which should be added as explicit collections, remotes,
integrations, and policies rather than as untracked process workarounds:

- Sales orders and billing documents — the confirmed quote is the handoff; the external system
  books it.
- Stock and warehouse management (quantities on hand, lots, receiving against a confirmed
  purchase order).
- Payment tracking and receivables — the external system holds the ledger.
- Customer-facing document rendering (PDF quotations and proformas).
- Exchange-rate sourcing and multi-currency roll-up — totals stay per currency.
- Partial fulfilment and shipment tracking.

Platform-level constraint worth knowing: `owner_id` columns render as raw UUIDs in
`CollectionTable`, because Pod relationships do not target platform tables. The pipeline filter
works around this by populating a dropdown from `client.db.user`.

## Verification

```bash
pnpm --dir template_workspaces/crm sync
pnpm --dir template_workspaces/crm lint
pnpm --dir template_workspaces/crm build
```

`sync` may create or update `.norbital/migrations/`; commit that migration history with the
authored change. Publish the revised template and deploy a new tenant checkpoint before it affects
an existing tenant. See the template lifecycle in the OSS repository README.
