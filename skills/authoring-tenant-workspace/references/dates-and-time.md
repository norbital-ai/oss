# Dates and Time

Classify the domain value before choosing storage. Precision does not make every value an instant:
a birthday and “opens at 09:00” must not move when a viewer changes timezone.

| Meaning               | Authoring primitive                           | Wire value                           | Client behavior                                                                                             |
| --------------------- | --------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Calendar day          | `instant({ precision: 'day' })`               | canonical UTC ISO ending in `Z`      | A `day` picker narrows the input; the stored value is still an instant of the workspace's business timezone |
| Absolute instant      | `instant()`                                   | canonical UTC ISO ending in `Z`      | Edit/display in the client timezone; send UTC                                                               |
| Instant interval      | `custom('instant_range', { precision?, multiple? })` | `{ start?, end? }` canonical UTC ISO | Pick/display in the client timezone; store UTC bounds                                                       |
| Fixed local wall time | plain `text()` column                         | `HH:mm`                              | Validated with `std/date`; never attaches a date or offset                                                  |
| Fixed calendar day    | plain `text()` column                         | `YYYY-MM-DD`                         | Validated with `std/date`; a viewer never sees a shifted day                                                |

There is no `date()`, `clockTime()`, `timestamp()` or `dateRange()` builder anymore: `instant()` is
the one temporal column, `custom('instant_range')` is the one span, and anything that must stay fixed in
place is text with a shared validator.

Use `instant()` for clock-ins, message times, audit events, deadlines with a time, and scheduled
executions. Use `instant({ precision: 'day' })` for work dates, payroll days, and legal effective
dates — the business timezone that owns the day (the workspace's payroll timezone) is the
interpretation, stored once. For recurring opening times, shift starts and cut-off times whose
meaning is local, store text `HH:mm` plus, where the place matters, an IANA timezone such as
`Asia/Singapore`. Never use a fixed UTC offset as timezone identity; daylight-saving rules change
offsets.

## Storage and wire rules

- Let Bolt authoring own storage: `instant()` is PostgreSQL `timestamptz`; do not import Drizzle's
  raw timestamp builder.
- `instant()`'s `precision: 'day'` is application metadata only: it narrows the picker and
  formatter without changing what is stored or creating a second temporal column type. A stored row
  is always a full-precision instant in the business timezone, and a consumer that needs the
  user-facing day must resolve it through that timezone, never through `toISOString().slice(0, 10)`.
- `custom('instant_range')` deliberately carries instants, not clock times: a shift that starts 22:00 local
  is a different instant in every timezone, and ordering/overlap math needs the real moment. There
  is no `timezone` field. Either bound may be omitted or null for an open span; do not invent a
  sentinel date.
- Send instants as canonical UTC ISO (`2026-07-26T01:30:00.000Z`). Reject unzoned strings such as
  `2026-07-26T09:30:00`.
- Keep calendar dates as strict `YYYY-MM-DD` strings and clock times as strict 24-hour `HH:mm`
  strings in **text columns**. Do not turn either into a JavaScript `Date` and do not store them in
  a temporal column type.
- Use shared validators and converters from `@norbital-ai/std/date`
  (`isUtcIsoInstant`, `isCalendarDate`, `isClockTime`, `parseUtcInstant`,
  `formatUtcInstantLocal`, `formatDateISO`, `DateRangeWireSchema`); do not add local regexes or
  permissive normalization.
- `custom('instant_range', { multiple: true })` is the one way to store multiple ranges: a dimensioned builder
  loses its scalar type, so `.array()` on one is refused at declaration.

## Client and renderer rules

- Use the schema-derived Bolt renderers. They display instants in the viewer's timezone and emit UTC
  after local date/time editing.
- Do not append `Z` to a local input; that falsely labels local wall time as UTC. Resolve it with the
  client timezone, then serialize the resulting instant.
- Do not timezone-convert fixed text `YYYY-MM-DD`/`HH:mm` values. A viewer in another timezone must
  see the same stored day or wall-clock time.
- Do not use `new Date().toISOString().slice(0, 10)` when the requirement is “today” for the
  viewer or a business timezone; that expression returns the UTC day. Derive the calendar day in
  the named timezone.
- Reject invalid and daylight-saving-gap local date/time combinations instead of silently rolling
  them forward.

## Query and filter rules

Use the same semantic wire value for mutations, queries, and filters:

```ts
// Instants are globally comparable UTC values.
where: {
	clock_in: { gte: '2026-07-26T01:00:00.000Z' }
}

// Fixed local values are already canonical, whatever they are stored in.
where: {
	work_date: { eq: '2026-07-26' },
	shift_start: { gte: '09:00' }
}
```

Client controls accept the user's local perspective and convert instant operands to UTC before
the query crosses the server boundary. Server roles, fixtures, functions, and direct API callers
must already provide canonical wire values. Never make the server guess a timezone.

In particular, a day picker label such as `2026-07-03` is presentation state, not an equality value
for `instant({ precision: 'day' })`. Resolve it in the named business timezone to the full canonical
UTC instant used by stored rows before issuing `{ eq: ... }`; comparing the label directly can make a
healthy relation-backed view look empty. Every query projection must also include every value its
renderer, join map, and sort reads — an omitted field is not a valid empty fallback.

For `custom('instant_range')` filters, `contains_date` starts from the viewer's calendar date and resolves it
through the viewer timezone. `overlaps` uses UTC range bounds. Client and server evaluation
must receive identical operands so optimistic results cannot disagree with confirmed results.

## Review checklist

1. State whether each value is a calendar day, wall-clock time, instant, or instant interval.
2. Confirm storage and wire shapes match the table above.
3. Trace create/edit, display, filter, live query, server query, fixture, and export/import paths.
4. Check timezone changes and daylight-saving boundaries for instants; confirm calendar days and
   wall-clock times do not move.
5. Reject ambiguous/unzoned instant strings at the boundary instead of normalizing them.
