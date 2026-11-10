# Dates and time

Classify the value before choosing a kind. Value types come from the std date module.

| Meaning | Kind | Value | Behaviour |
| --- | --- | --- | --- |
| Calendar day | `date` | `PlainDate` | same day for every viewer; never converted |
| Absolute moment | `instant` | `Instant`, UTC ISO ending `Z` | shown in the configured zone, compared globally |
| Local wall time | `time` | `PlainTime`, `HH:mm` | never attached to a date or offset |
| Length of time | `duration` | seconds | |
| Span of days | `period` of `date` | `{ from, to \| null }` inclusive | `to: null` is open |
| Span of moments | `period` of `instant` | `{ start, end \| null }` half-open | `end: null` is open |
| IANA zone of a place | `text` format `zone` | zone name | never a fixed offset |

- Open ends are null, never a sentinel date.

## Workspace zone

- `+workspace.ts` `tz` decides today, a `seq`'s `{yyyy}`, and cron triggers without their own `tz`. Declare it once.
- Backend code uses `ctx.tz`, `ctx.today`, `ctx.now`, and `ctx.today_in(zone)` for another place. Pages get the zone from `ctx.tz`.
- Another place's zone belongs to its record or runtime configuration.
- Never derive today from `toISOString()`: that is the UTC day.

## Filters and clocks

- Read predicates and policy scopes take values, never relative clocks. Compute a boundary in typed code and pass it in.
- `bolt.clock('day').today` updates at workspace midnight; `bolt.clock('minute' | 'hour').now` at that grain while visible; `bolt.clock()` is a fixed page-opening snapshot.
- Helpers have no clock: pass time as an argument.
- Date and instant field defaults may be `{ var }` clock expressions, evaluated at write time.
- A successor is a guarded write, commonly from an automation; never mutate history.

## Formatting

- Use the std date and calendar modules. No local regexes or permissive parsing: reject unzoned instants and daylight-saving-gap wall times at the boundary.
- Prefer native field controls. A `date` never shifts; an `instant` is edited in the configured zone and sent as UTC.
- A custom timestamp display receives the zone through `ctx.tz` or a narrower prop and passes it to the formatter. Locale alone does not choose a zone.
- Use one zone for grouping, defaults, labels and messages. Label an explicitly selected event zone.

## Review

1. Name each value: day, wall time, instant, duration, or a period of one.
2. Confirm no text column stands in for a date.
3. Trace create, edit, display, filter, live read, transform, automation, seed and export.
4. Check zone changes and daylight-saving boundaries for instants.
