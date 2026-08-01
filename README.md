# EPG CRM — How It Works

> Built for the EPG (Engineering Plastics Group) sales team. EPG is a plastics resin trading
> subsidiary of Omni-Plus Systems, operating out of China, with per-project R&D capabilities.

## Orientation and boundaries

This is an executable Pod template, not a production-operations manual. It demonstrates a sales and
operations split, server-enforced quote/payment rules, and the places where a reseller will need explicit
extensions. Start with the workflow below, then use the [collections](#collections),
[apps](#apps), [remotes](#remotes), and [verification](#verification) sections when changing it.

The workspace owns CRM records, tenant users, policies, and sales workflow. The host authenticates the
requestor and supplies external facilities; accounting, inventory, exchange rates, customer documents,
supplier purchasing, and external messaging are intentionally outside this template’s current scope.

For the template’s goal, users, and extension boundaries, see the [CRM documentation hub](./docs/README.md).

## What this system does

A deal-to-cash pipeline for resin trading: qualify accounts, build quotes with line items that
snapshot from the product catalogue, track the full quote → order → fulfilment lifecycle, record
incoming payments, and log every customer interaction. Two apps split sales execution from
operations management.

---

## How it works — the full user flow

### Creating a quote

1. Rep opens the **Sales CRM** app, navigates to the **Pipeline** tab (kanban board).
2. Creates a new quote: selects an account, optional contact, title, currency (CNY/USD/EUR/GBP/JPY/SGD/HKD),
   tax-inclusive flag, validity date. The system auto-generates a sequential doc number
   (`QT-2026-0001`, `QT-2026-0002`, etc.).
3. Adds line items from the **Products** catalogue. Each line snapshots the product code, name,
   unit, and unit price at creation time — later catalogue price changes do not retroactively
   alter historical quotes.
4. Line totals auto-calculate: `net = quantity × unit_price × (1 − discount%)`, then
   `total = net + tax`.
5. The quote starts in `draft` status. Lines can be added, removed, or edited freely.

### Sending to the customer

1. Rep opens the draft quote, changes status to `sent`.
2. The quote is sent to the customer for review.

### Revising after sending

1. To revise a sent quote (new quantity, lower price, alternate grade), reopen to `draft`.
2. The system increments `revision_number` and sets `revision_of` to point to the original
   quote, forming a linked revision chain.
3. Make changes while the quote is back in draft, then re-send.

### Winning the deal

1. Customer accepts. Rep moves the quote to `won`.
2. The state machine validates: `draft → won` and `sent → won` are both valid transitions.
3. `won` is a soft state — the deal is agreed but not yet confirmed in operations.

### Operations confirmation

1. Back-office opens the **CRM Operations** app, navigates to the **Orders** tab (filtered to
   `won`, `confirmed`, `fulfilled` quotes).
2. After entering the order into the Omni-Plus ERP, operations moves the quote to `confirmed`.
   The system records a `confirmed_at` timestamp.
3. After warehouse shipment, operations moves to `fulfilled`. The system records a
   `fulfilled_at` timestamp.

> **Known limitation:** Fulfilment is binary — an order is either fulfilled or it isn't. Resin
> trading frequently involves partial shipments (20 tons across 4 containers over several weeks).
> There is no partial-fulfilment tracking, no shipment entity, no container or BL number.

### Cancelling and losing

- `cancelled` and `lost` are terminal states. Neither can be transitioned out of, with one
  exception: `lost → won` is allowed (reopening a lost deal).
- A quote with recorded payments **cannot be cancelled**. The system queries `payment_records`
  before allowing the transition.

### Recording a payment

1. Finance opens the **CRM Operations** app, navigates to the **Payments** tab, creates a new
   payment record.
2. Selects the order (quote), enters amount with currency, payment date, method, and optional
   reference number.
3. The system validates:
   - The order exists and is in `won`, `confirmed`, or `fulfilled` status (not `draft`/`sent`/`cancelled`/`lost`)
   - The payment currency matches the order currency — a USD payment on a CNY order is rejected
   - The amount is positive

### Logging activities

1. From any account or quote detail view, create an activity record.
2. Activities are polymorphic: `regarding_type` (enum: `accounts`, `quotes`, `projects`) paired with a
   `regarding_id` UUID. This means the same activity table serves calls, meetings, emails, tasks,
   and notes across accounts, deals, and projects.
3. Task activities auto-set `due_date` to today if left blank.

### Viewing the pipeline

1. Rep opens the **Sales CRM → Pipeline** tab. A kanban board shows active quotes grouped into
   5 lanes (terminal states `cancelled` and `lost` are hidden from the board):

   | Lane      | Color   | Meaning                                              |
   | --------- | ------- | ---------------------------------------------------- |
   | Draft     | gray    | Being prepared, editable. Send or reopen here.       |
   | Sent      | blue    | Delivered to customer. Reopen to draft for revision. |
   | Won       | amber   | Customer accepted, awaiting ops confirmation         |
   | Confirmed | green   | Entered into ERP, awaiting fulfilment                |
   | Fulfilled | emerald | Shipped, complete                                    |

2. A user-name dropdown above the kanban filters by owner. Selecting a rep re-executes the
   `pipeline_dashboard` remote with the filtered `owner_id`.
3. Each card shows: doc number, title, account name, currency, and gross amount.
4. The `pipeline_dashboard` remote enriches the kanban with account names (fetched separately so
   the kanban query doesn't need a join).

> **Known limitations:**
>
> - Pipeline value sums raw currency amounts without exchange-rate conversion. A CNY 100,000
>   quote and a USD 100,000 quote both count as 100,000 in the total.
> - The `valid_until` field exists on every quote but nothing highlights quotes approaching or
>   past their expiry date. (The daily `quote_expiry_watch` automation reports expired quotes
>   but does not take automated action.)

### Checking revenue

The **CRM Operations → Revenue** tab shows real-time payment status across all orders:

- **Summary cards:** Total invoiced, total paid, outstanding balance.
- **Order table:** Per-order invoice amount, paid amount, and status badge
  (`paid` / `partial` / `unpaid` / `empty`).
- Powered by the `revenue_summary` remote at `src/remotes/+revenue_summary.ts`.

### Exporting

The **Export** pipeline on quotes produces two artefacts per selected quote:

- `quote_<docno>.json` — structured JSON under the `norbital.crm.interoperability.v1` schema
- `quote_<docno>_lines.csv` — flat CSV of line items

Suitable for ERP import or audit, but **not** what a customer receives. Customer-facing documents
(quotations, proforma invoices, commercial invoices) are not generated.

### Managing products

The **Products** catalogue holds resin grades, compounds, and R&D project materials. Each product
has: code (unique), name, description, unit, unit price, and active flag. Quote lines snapshot
from this catalogue at creation time.

> **Known limitations:**
>
> - `unit_price` is a single number with no effective dating. Changing a price overwrites history.
> - No customer-specific pricing. The same grade quotes the same catalogue price to every account.
>   In resin trading, pricing is relationship-based — large buyers get tiered rates.
> - No technical specifications (MFI, density, tensile strength, grade classification). When a
>   customer asks "do you have a PP with MFI between 10-15?", there is no data to answer this.
> - For R&D project resins that have no permanent catalogue entry, create a one-off product and
>   mark it inactive after the project. There is no `projects` collection, no project budget
>   tracking, and no way to link quotes to R&D initiatives.

### Managing contacts

Each contact belongs to an account (`account_id` foreign key, validated on create). Fields: first
name, last name, email, phone, WeChat ID, title, department, active.

---

## What works well

- **State machine prevents impossible transitions.** You cannot jump from `draft` to `fulfilled`
  or cancel a deal with outstanding payments.
- **Line item snapshotting.** Quote lines freeze product data at creation. Catalogue price changes
  never retroactively alter historical deals.
- **Auto document numbering.** Sequential `QT-YYYY-NNNN` with zero-padding. No duplicates, no gaps,
  no manual numbering errors.
- **Currency validation on payments.** A USD payment on a CNY order is rejected at entry, not
  discovered at month-end reconciliation.
- **Polymorphic activities.** One table for all interaction types, linkable to any entity. No
  separate tables for calls, meetings, emails, tasks, and notes.
- **Multi-currency.** CNY, USD, EUR, GBP, JPY, SGD, HKD covers EPG's trading currencies.
- **Export pipeline.** JSON + CSV with schema versioning, ready for ERP handoff.
- **Server-side data integrity.** Hooks enforce business rules at the database level, not the UI.

---

## What is missing or broken

### Critical — blocks daily work

| Issue                                                  | Impact                                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sent quotes are immutable — cannot reopen for revision | Rep must create a new quote from scratch for every customer change. Revision during negotiation is the single most common action in resin trading. |
| No revision history or version links                   | No way to trace quote V1 → V2 → V3 negotiation chain                                                                                               |

### Fixed (was broken — now functional)

| Issue                                        | What changed                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Sent quotes were immutable                   | `sent → draft` transition added. Reopening increments `revision_number` and links `revision_of`.             |
| `revenue_summary` remote was unused          | Wired into `crm_admin` as a Revenue tab with summary cards and per-order payment-status table.               |
| Pipeline kanban ignored `owner_id` filter    | User-name dropdown queries `client.db.user`. Remote re-fires via `$derived.by` when filter changes.          |
| No customer-specific pricing                 | New `customer_prices` collection. `quote_lines` hooks check for active account price before catalogue price. |
| Payment methods missing China channels       | Added `wechat_pay`, `alipay`, `letter_of_credit` to `payment_records` method enum.                           |
| `regarding_type` on activities was free text | Changed to enum: `['accounts', 'quotes', 'projects']`.                                                       |
| No `projects` collection for R&D work        | New `projects` collection with status lifecycle. Quotes link via `project_id`.                               |
| No quote expiry alerts                       | New `+quote_expiry_watch` automation (daily 6 AM read-only report of expired sent quotes).                   |
| No WeChat ID on contacts                     | Added `wechat_id` + `department` fields to contacts model.                                                   |
| No product technical specs                   | Added `grade`, `mfi`, `density`, `supplier` to products. Price change auto-records `price_updated_at`.       |
| `cancelled` and `lost` as full kanban lanes  | Collapsed to 5 active lanes (Draft, Sent, Won, Confirmed, Fulfilled). Terminal states hidden from kanban.    |
| No owner filter UI                           | Pipeline tab now shows a user-name `<select>` dropdown populated from `client.db.user`.                      |

### Still outstanding

| Issue                              | Impact                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No partial fulfilment              | Binary fulfilled/not-fulfilled. Cannot track multi-shipment orders.                                                                                                  |
| No effective-dated prices          | Changing a product price overwrites the single value. `price_updated_at` tracks when but history is not queryable.                                                   |
| No exchange rate handling          | Pipeline totals add CNY + USD + EUR as raw numbers with no conversion.                                                                                               |
| Two-app split adds friction        | Small firm: same person creates quotes and records payments. App switching is overhead.                                                                              |
| No document generation             | Customers receive JSON/CSV exports, not formatted PDF quotes or invoices.                                                                                            |
| `owner_id` columns render as UUIDs | CollectionTable shows raw UUIDs for owner columns since Pod relationships don't support platform tables. Workaround: pipeline filter uses `client.db.user` dropdown. |

### Missing entirely — not in scope yet

- Purchase/supplier side (no buy price → no margin calculation)
- Inventory/stock awareness
- Sales targets and commissions
- Customer-facing document generation (PDF quotes, proforma invoices, commercial invoices)
- Email/WeChat integration
- Exchange rate sourcing

---

## System model: users, ownership, and access control

The Pod platform provides a built-in `user` table. There is **no separate "sales person" or "rep" collection** — the system user model is the single source of identity and access control.

Every quote, activity, and project stores an `owner_id` that holds a user's `norbital_id`. The pipeline filter queries `client.db.user` directly to populate a user-name dropdown instead of requiring raw UUID input.

### User table (platform-provided, not authored)

| Column       | Purpose                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | Display name                                                                                                                                             |
| `email`      | Login identity (unique, not null)                                                                                                                        |
| `phone`      | Contact number                                                                                                                                           |
| `avatar_url` | Profile image                                                                                                                                            |
| `status`     | `active` / `inactive` / `suspended` — drives access control                                                                                              |
| `role`       | `owner` / `admin` / `member` — drives permission policies                                                                                                |
| `kind`       | `human` / `bot` / `system`                                                                                                                               |
| `metadata`   | **Extension point** — arbitrary JSONB for Telegram handles, employee IDs, department codes, WeChat IDs, regional assignments, and future channel routing |

### What NOT to build

- Do not create a `users`, `reps`, `sales_people`, or `profiles` collection. The platform `user` table already exists and is the canonical identity store.
- Do not replicate fields like `email`, `name`, or `phone` on tenant collections. Contacts are customer-facing entities — distinct from platform users who operate the system.
- Do not hand-roll access control. The platform policy engine handles role-based and record-level permissions.

### Linking additional data to a user

The `user.metadata` jsonb column is the designated extension point. Examples:

```json
{
	"telegram": "@rep_zhang",
	"wechat": "zhang_epg",
	"employee_id": "EPG-042",
	"region": "east_china",
	"channel_preference": ["wechat", "email"]
}
```

This keeps identity in one place while allowing channel-specific routing and operational metadata to be attached without schema changes.

---

## Collections

| Collection        | Purpose                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`        | Customer companies. Multi-currency preference (CNY, USD, EUR, GBP, JPY, SGD, HKD).                                                                                                    |
| `contacts`        | People at accounts — decision-makers, buyers, day-to-day contacts.                                                                                                                    |
| `products`        | Resin grades, compounds, R&D project materials catalogue.                                                                                                                             |
| `customer_prices` | Active account-and-product price overrides. Quote-line creation prefers this price to the catalogue price.                                                                            |
| `projects`        | Customer R&D or commercial projects. Quotes can carry a project reference and activities may be recorded against one.                                                                 |
| `quotes`          | Sales document — the full pipeline. Moves draft → sent → won (quote), then confirmed → fulfilled (order). Cancelled and lost are terminal, with `lost → won` as the only reopen path. |
| `quote_lines`     | Line items on quotes. Snapshots product data at creation so price changes do not retroactively alter historical deals. Can only be modified on draft quotes.                          |
| `payment_records` | Payments received against won/confirmed/fulfilled orders. Validates currency matches the order.                                                                                       |
| `activities`      | Polymorphic interaction log — calls, meetings, emails, tasks, notes — linked to accounts or quotes via `regarding_type` + `regarding_id`.                                             |

## Apps

| App         | Purpose                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `crm_sales` | Sales workspace — five active pipeline lanes, accounts, contacts, catalogue, and quotes. |
| `crm_admin` | Operations workspace — order fulfilment, payment tracking, quote lines, team activities. |

## Remotes

| Remote               | Purpose                                                                                                              | Wired to UI?                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pipeline_dashboard` | Stage-by-stage counts, total pipeline value, enriched kanban cards with account names. Accepts `owner_id` parameter. | Yes — `+crm_sales.svelte` re-runs it when the selected owner changes. |
| `revenue_summary`    | Per-order invoiced/paid/outstanding summary, filterable by currency.                                                 | Yes — `+crm_admin.svelte` powers the Revenue tab.                     |

## State machine

```
draft ──→ sent ──→ won ──→ confirmed ──→ fulfilled
  ▲         │         │         │
  │         │         │         ▼
  │         │         │      cancelled (terminal)
  │         │         │
  │         │         ▼
  ├─────────┘       lost ◄── (reopen: lost → won)
  │
  ├── cancelled (terminal)
  │
  └── lost (terminal)
```

- `draft`: Editable. Lines can be added, removed, modified. **Reachable from `sent`** for revision — reopening increments `revision_number` and sets `revision_of`.
- `sent`: Delivered to customer. Reopen to draft to revise.
- `won`: Customer accepted. `confirmed_at` / `fulfilled_at` not yet set.
- `confirmed`: ERP entry done. `confirmed_at` timestamp set automatically.
- `fulfilled`: Shipped. `fulfilled_at` timestamp set automatically. Terminal — no further transitions.
- `cancelled`: Terminal. Blocked if payments exist.
- `lost`: Terminal, except `lost → won` (reopen).

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
