# Elicitation questions

The seven ambiguity groups from SOP 1, with the questions to close each. Ask in order; do not move
on while a group still has a trap word (see the SKILL.md table) unanswered. Questions are
business-language; ask them verbatim rather than paraphrasing into technical terms.

## 1. Who

- Who are the people who will use this, by job title?
- What is each person's job in the workflow — what do they start, and what do they finish?
- What should one person be able to see that another cannot?
- Is anyone outside the company involved — customers, contractors, suppliers? Do they have
  accounts, or should they reach in from chat?
- Who is allowed to override a decision, and is there a record of that?

## 2. What

- What are the things this system manages? Name them as the business names them (a "job", a
  "case", a "lot", an "order").
- For each thing: what facts must be known about it that are _not_ derivable from other facts?
- What distinguishes two things that look the same (numbering, uniqueness, versions)?
- Which facts change over time, and does history matter (what was true in March must be provable
  in September)?
- Which things belong to other things (lines on a document, items in a shipment)?

## 3. Transitions

- What states does each thing live through, in the business's own words?
- What moves it from one state to another — who, with what trigger?
- What is explicitly forbidden (cancel without a reason, edit after issue, delete after
  approval)?
- Where does a human have to review before something happens (approvals, second pairs of eyes)?
- What happens to the record when something is rejected — does it go back, split, or end?

## 4. Numbers

- Every amount in the business: what is it, in what unit, and who decides it (a price, a rate, a
  tax, a discount, a quantity)?
- Which numbers are decided once and must stay frozen (a quoted price must not change when the
  catalogue does)?
- Which numbers are derived from others, and what should the derived number be called?
- What rounding, currencies, tax modes, and decimal places apply, per jurisdiction if there is
  more than one?
- Which numbers are guesses or targets rather than facts (forecasts, budgets, quotes)?

## 5. Triggers

- What work happens on a schedule (daily, weekly, monthly, on a date)? Who knows it is due?
- What work happens because something else happened (an order confirms, a document expires, a
  threshold is crossed)?
- What should happen automatically, and what should stop and wait for a person?
- When automated work fails, who notices, and what does "failed" mean for the records?

## 6. The outside world

- Which systems already hold this data? Which system is the _owner_ of each fact — who changes
  it first?
- Which third parties take part (bank, payment provider, regulator, courier, government
  portal)?
- What must be produced for them, in what format, and by when?
- Which obligations are legal or regulatory (filing, retention, audit, disclosure), and what
  would evidence of compliance look like?
- What happens when an external system is down — what is allowed to wait?

## 7. Outputs

- What documents, files, and exports does this produce (invoice, payslip, certificate, report,
  submission)?
- For each: who receives it, what is on it, what format it must be in, and does it need a
  signature or authorisation?
- What reports do people want, what numbers are on each, and for whom?
- What messages go out (email, WhatsApp, notices), and who should and should not see them?
- What has to be provable later (audit): who did what, when, to which record, and why?

## Closing questions

- "If I built only one of these, which one would save the most pain?" — reveals priority, not
  scope.
- "What would you do on the first Monday with it?" — reveals the first milestone.
- "What is the worst thing it could get wrong?" — reveals the invariants that become hook
  rules and tests.
