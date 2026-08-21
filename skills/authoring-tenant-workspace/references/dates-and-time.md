# Dates and Time

Classify the domain value before choosing storage. Precision does not make every value an instant:
a birthday and “opens at 09:00” must not move when a viewer changes timezone.

| Meaning               | Authoring primitive | Wire value                           | Client behavior                                               |
| --------------------- | ------------------- | ------------------------------------ | ------------------------------------------------------------- |
| Calendar day          | `date()`            | `YYYY-MM-DD`                         | Display and edit the same day; never timezone-shift           |
| Local wall-clock time | `clockTime()`       | `HH:mm`                              | Display and edit the same time; never attach a date or offset |
| Absolute instant      | `timestamp()`       | canonical UTC ISO ending in `Z`      | Edit/display in the client timezone; send UTC                 |
| Instant interval      | `dateRange()`       | `{ start?, end? }` canonical UTC ISO | Pick/display in the client timezone; store UTC bounds         |

Use `date()` for birthdays, work dates, payroll days, and legal effective dates. Use
`clockTime()` for recurring opening times, shift starts, and cut-off times whose meaning is local.
Use `timestamp()` for clock-ins, message times, audit events, deadlines with a time, and scheduled
executions.

For a future or recurring event tied to a place, store the local `date()`/`clockTime()` values plus
an IANA timezone such as `Asia/Singapore`. Resolve them to a `timestamp()` only when scheduling an
occurrence. Never use a fixed UTC offset as timezone identity; daylight-saving rules change offsets.

## Storage and wire rules

- Let Bolt authoring own storage: `timestamp()` is PostgreSQL `timestamptz`; do not import Drizzle's
  raw timestamp builder.
- `clockTime()` is Bolt's native wall-clock semantic type. It intentionally uses canonical `HH:mm`
  text storage so PostgreSQL, the local replica, JSON, and `<input type="time">` share one value
  without driver-added seconds or timezone behavior.
- Send instants as canonical UTC ISO (`2026-07-26T01:30:00.000Z`). Reject unzoned strings such as
  `2026-07-26T09:30:00`.
- Keep calendar dates as strict `YYYY-MM-DD` strings and clock times as strict 24-hour `HH:mm`
  strings. Do not turn either into a JavaScript `Date`.
- Use shared validators and converters from `@norbital-ai/std/date`; do not add local regexes or
  permissive normalization.
- Treat `dateRange()` as an instant interval. Its date-only picker resolves the selected start and
  end to local start-of-day/end-of-day UTC instants. Use two `date()` columns when the domain means
  two calendar days rather than elapsed time.
- Either `dateRange()` bound may be omitted for a genuinely open interval. Omit the absent key; do
  not invent a sentinel date or send `null` inside the range object. Use `.array()` only when the
  field stores multiple distinct ranges; mutation validation applies the element schema to each
  array member.

## Client and renderer rules

- Use the schema-derived Bolt renderers. They display instants in the viewer's timezone and emit UTC
  after local date/time editing.
- Do not append `Z` to a local input; that falsely labels local wall time as UTC. Resolve it with the
  client timezone, then serialize the resulting instant.
- Do not timezone-convert `date()` or `clockTime()` values. A viewer in another timezone must see
  the same stored day or wall-clock time.
- Do not use `new Date().toISOString().slice(0, 10)` when the requirement is “today” for the
  viewer or a business timezone; that expression returns the UTC day. Derive the calendar day in
  the named timezone.
- Reject invalid and daylight-saving-gap local date/time combinations instead of silently rolling
  them forward.

## Query and filter rules

Use the same semantic wire value for mutations, queries, and filters:

```ts
// Calendar date and local time are already canonical.
where: {
	work_date: { eq: '2026-07-26' },
	shift_start: { gte: '09:00' }
}

// Instants are globally comparable UTC values.
where: {
	clock_in: { gte: '2026-07-26T01:00:00.000Z' }
}
```

Client controls accept the user's local perspective and convert timestamp operands to UTC before
the query crosses the server boundary. Server roles, seeds, functions, and direct API callers must
already provide canonical wire values. Never make the server guess a timezone.

For `dateRange()` filters, `contains_date` starts from the viewer's calendar date and resolves it
through the viewer timezone. `overlaps` uses UTC range bounds. Local replica and server evaluation
must receive identical operands so optimistic results cannot disagree with confirmed results.

## Review checklist

1. State whether each value is a calendar date, wall-clock time, instant, or instant interval.
2. Confirm storage and wire shapes match the table above.
3. Trace create/edit, display, filter, sync replica, server query, seed, and export/import paths.
4. Check timezone changes and daylight-saving boundaries for instants; confirm dates and clock
   times do not move.
5. Reject ambiguous/unzoned timestamp strings at the boundary instead of normalizing them.
