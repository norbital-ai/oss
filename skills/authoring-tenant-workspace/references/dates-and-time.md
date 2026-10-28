# Dates and Time

Classify the domain value before choosing a kind. Precision does not make every value an instant: a
birthday and "opens at 09:00" must not move when a viewer changes timezone.

| Meaning                                            | Kind                                | Value (`@norbital-ai/std/date`)                    | Behaviour                                               |
| -------------------------------------------------- | ----------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| Calendar day (work date, birthday, effective date) | `{ kind: 'date' }`                  | `PlainDate`, `YYYY-MM-DD`                          | the same day for every viewer; never converted          |
| Absolute moment (clock-in, message, deadline)      | `{ kind: 'instant' }`               | `Instant`, UTC ISO ending in `Z`                   | shown in the configured display zone, compared globally |
| Local wall time (opening hour, shift start)        | `{ kind: 'time' }`                  | `PlainTime`, `HH:mm`                               | never attached to a date or offset                      |
| Length of time                                     | `{ kind: 'duration' }`              | seconds                                            |                                                         |
| Span of days (contract, validity)                  | `{ kind: 'period', of: 'date' }`    | `{ from, to \| null }`, both ends inclusive        | `to: null` is open-ended                                |
| Span of moments (shift, booking)                   | `{ kind: 'period', of: 'instant' }` | `{ start, end \| null }`, half-open `[start, end)` | `end: null` is open-ended                               |
| IANA zone of a place                               | `{ kind: 'text', format: 'zone' }`  | `'Asia/Singapore'`                                 | never a fixed UTC offset                                |

Open ends are `null`. Never invent a sentinel date such as `9999-12-31`.

## The workspace zone

`src/+workspace.ts` declares `tz`. It decides what "today" is (`ctx.today` and page clocks), the
`{yyyy}` of a `seq`, and cron triggers without their own `tz`. A
multi-zone engine asks `ctx.todayIn(zone)` for another place's day. Declare the workspace zone once
in `src/+workspace.ts`; backend workflows use `ctx.tz`, and the shell supplies it to UI through
`useKinds().zone`. Another place's zone belongs to its record or runtime configuration. Never derive
today with `new Date().toISOString().slice(0, 10)` (that is the UTC day).

## Filters and clocks

Read predicates take date/instant values. They have no relative clock operators, including in
policy grant scopes. Compute a boundary in ordinary typed code and pass it as input.

```ts
// page: the query changes when the workspace day changes
const day = bolt.clock('day');
const active = $derived(bolt.query({
  contracts: { where: { effective: { contains: day.today } } }
}));
// server body: ctx.today is fixed for this invocation
const { tasks: due } = yield* ctx.query({
  tasks: { where: { due_on: { lte: ctx.today } } }
});
```

`bolt.clock('day').today` updates at midnight in the workspace zone.
`bolt.clock('minute' | 'hour').now` updates at the declared grain, only while visible.
`bolt.clock()` without a unit is a fixed page-opening snapshot. Pass time into query inputs and
`src/lib` helper arguments; helpers have no clock. Transforms and automations expose now/today and zone helpers as
invocation bindings. Use the date library for month/week boundaries before
constructing the where value. Date/instant field defaults may still be clock variables
(`{ var: 'today' }`, `{ var: 'now + hours(1)' }`); those are evaluated at write time, not read operands. Create a successor through a standard
guarded write, commonly from an automation; never mutate history.

## Values and formatting

Use `@norbital-ai/std/date` (`PlainDate Instant Zone datePeriod contains overlaps intersect days
eachDay monthOf yearOf addDays addMonths formatDate formatInstant formatPeriod parseInstant`) and
`@norbital-ai/std/calendar` for business days and cycles. No local regexes, no permissive parsing:
reject unzoned instants (`2026-07-26T09:30:00`) and daylight-saving-gap wall times at the boundary.

Views (`Field`, `Show`, `TimeInput`, `TimeRangeInput`) render and edit each kind; a
`date` never shifts, and an `instant` is edited in the shell's configured zone and sent as UTC.
Prefer those native controls. Custom timestamp or slot displays capture `useKinds()` during
component initialization and pass its `zone` to UI `format` (or `timeZone` to Intl). Locale alone
does not choose a timezone. Use the same zone for day-part grouping and date defaults; booking
labels, stored instants and confirmation messages must agree when the browser is in another zone.
An explicitly selected event/source zone must be labelled and applied consistently.

## Review checklist

1. Name each value: calendar day, wall time, instant, duration, or a period of one of them.
2. Confirm the kind matches the table; no text column standing in for a date.
3. Trace create, edit, display, filter, live read, transform, automation, seed and export paths.
4. Check zone changes and daylight-saving boundaries for instants; confirm days and wall times do
   not move.
