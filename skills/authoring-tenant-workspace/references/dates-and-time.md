# Dates and time

| Meaning | Kind | Value / behaviour |
| --- | --- | --- |
| Calendar day | `date` | `PlainDate`; never shifted across zones |
| Absolute moment | `instant` | UTC ISO `Z`; shown in configured zone, compared globally |
| Local wall time | `time` | `PlainTime` `HH:mm`; unattached to date/offset |
| Span of time / days / moments | `duration` / `period` of `date` or `instant` | seconds / inclusive `{ from, to \| null }` / half-open `{ start, end \| null }` (open end is `null`, never a sentinel) |
| IANA zone | `text` format `zone` | zone name, never fixed offset |

- **Workspace zone:** `+workspace.ts` `tz` governs `ctx.today`, `seq` `{yyyy}` and default cron `tz`. Server uses `ctx.tz`, `ctx.today`, `ctx.now`, `ctx.today_in(zone)`; pages use `ctx.tz`. Never derive today from `toISOString()`.
- **Clocks & filters:** read predicates/scopes take materialized values (`ctx.clock('day').today`, `ctx.clock('minute'|'hour').now`, `ctx.clock()` snapshot), never relative clock variables (only field defaults accept `{ var }` clocks). Helpers take time as an argument.
- **Formatting & controls:** use Effect `DateTime`/`Duration` with authored calendar rules (reject unzoned instants/DST gaps at boundary; no permissive regexes). Use shared `TimeInput` (`of="month"` for months) and `TimeRangeInput` (never raw HTML date/month inputs or extra calendar libraries). Pass `ctx.tz` explicitly when formatting timestamps.
