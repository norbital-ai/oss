# Worked example

One full walkthrough: a vague concept to a confirmed plan. The conversation is compressed; the
point is the shape of the output, the order of the questions, and where the boundary lands.

## The request

> "We want to manage our spare parts inventory and bill customers. Right now it's Excel and
> email."

## What elicitation finds

- **Who**: a storekeeper (receives and issues), a purchasing officer (orders), an office
  manager (bills, sees everything).
- **What**: parts (with units and prices), stock movements (receipts, issues, adjustments),
  customers, invoices, payments.
- **Transitions**: an invoice is draft → issued → paid/partial; a part is active or inactive; a
  movement is immutable once recorded.
- **Numbers**: unit prices set on receipt and snapshotted onto invoice lines; a 6% tax applies
  to invoice lines; quantities in the part's own unit.
- **Triggers**: a monthly report of slow-moving parts; invoice reminders at 30 days.
- **Outside world**: the accounting system owns customers and the general ledger; a bank is
  where payments arrive; no payment provider today.
- **Outputs**: invoices (PDF by email), a monthly movement report, a bank reconciliation view.

## Classification (bolt-feasibility)

| Sub-function                     | Verdict                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Parts, stock position, movements | native (stock position derived from movement events)                                                               |
| Invoicing, PDF, email            | native (pipelines export, email facility)                                                                          |
| Payment reconciliation           | mediated — payments are recorded, reconciled against bank statements pulled from the bank (or entered manually v1) |
| Customer master                  | mediated — mirrored from the accounting system via pull                                                            |
| Slow-mover report, reminders     | native (automations + aggregates)                                                                                  |

## The plan (condensed)

### 1. Goal

The store receives and issues parts and the office bills customers for them, without Excel.
Stock is always current, invoices go out the same day a job finishes, and the accounting system
stays the system of record for customers.

### 2. Who uses it

| Role               | What they do                      | May see               | May change         |
| ------------------ | --------------------------------- | --------------------- | ------------------ |
| Storekeeper        | records receipts and issues       | stock and movements   | movements          |
| Purchasing officer | orders parts, sets part status    | parts, stock, orders  | parts, orders      |
| Office manager     | invoices, reports, reconciliation | everything, all money | invoices, payments |

### 3. What it manages

| Thing          | Facts                                           | States                          |
| -------------- | ----------------------------------------------- | ------------------------------- |
| Part           | name, unit, category                            | active / inactive               |
| Stock movement | part, quantity, direction, date, reference      | recorded once, immutable        |
| Customer       | mirrored from accounting                        | —                               |
| Invoice        | lines with snapshotted price and 6% tax, totals | draft → issued → paid / partial |

### 4. How work flows

1. Storekeeper records a receipt; stock position updates immediately.
2. Issues are recorded against a job or customer.
3. Office manager creates an invoice from issued quantities; lines freeze.
4. Invoice is issued; PDF emails to the customer; reminder at 30 days.
5. Payments arrive in the bank; office manager matches them to invoices.

### 5. What people see

| Role           | Screen  | Contents                                  |
| -------------- | ------- | ----------------------------------------- |
| Storekeeper    | Stock   | parts, current position, recent movements |
| Office manager | Billing | open invoices, overdue, payment matches   |
| Office manager | Report  | monthly movements, slow movers            |

### 6. Numbers and rules

- Prices are set at receipt and snapshotted onto invoice lines; later receipts never rewrite
  history.
- 6% tax per line, rounded per line; invoice total is the sum of rounded lines.
- Stock position is always derived: receipts minus issues minus adjustments.
- An issued invoice cannot be edited; corrections are credit lines.

### 7. What connects to it

| Other side        | Owns              | In                            | Out                                 | Meeting           |
| ----------------- | ----------------- | ----------------------------- | ----------------------------------- | ----------------- |
| Accounting system | customers, ledger | customer mirror (hourly pull) | invoice totals + movement summaries | pull in, send out |
| Bank              | money             | —                             | reconciliation file                 | send              |
| Customer          | —                 | —                             | invoice PDF by email                | email             |

### 8. What it does not do

- No reorder automation in version 1 — the slow-mover report tells the purchasing officer what
  to order.
- No payment processing — the bank moves money; the workspace matches records to it.
- The accounting system remains the owner of customers and the ledger; nothing is dual-keyed.

### 9. Build order

1. Foundation: parts, movements, derived stock. 2. Invoicing with snapshots and PDF. 3.
   Automations: reminders, report. 4. Customer mirror pull + email delivery. 5. Rollout.

### 10. Open questions

- Who approves write-off adjustments? — store manager to confirm.
- 30-day reminders: auto-send or draft for review? — office manager to confirm.
