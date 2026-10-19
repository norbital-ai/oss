# Time inputs

The public temporal controls are `TimeInput` and `TimeRangeInput`. Calendar, month, week, year, date segments and clock controls are internal implementations. Both public controls select their implementation through `of` and `precision` and accept a scalar or an array of values.

```svelte
<TimeInput of="date" precision="month" value={month} onChange={(next) => (month = next)} />
<TimeInput of="date" precision="day" value={dates} onChange={(next) => (dates = next)} />
<TimeRangeInput of="date" precision="day" value={range} onChange={(next) => (range = next)} />
<TimeRangeInput
	of="instant"
	precision="hour"
	value={windows}
	onChange={(next) => (windows = next)}
/>
<TimeRangeInput
	of="time"
	precision="minute"
	value={clockIntervals}
	onChange={(next) => (clockIntervals = next)}
/>
```

A date remains `YYYY-MM-DD` even at month or year precision. An instant remains an ISO UTC value; selection uses the viewer's zone. A clock value is `HH:MM`. Date ranges use `{ from, to }`, instant ranges use `{ start, end }`, and clock ranges use `{ start, end }`. Arrays contain those same scalar values or range objects. New array entries are empty until filled; removal preserves the remaining entries. Readonly controls do not offer add/remove actions.

Date ranges have one formatted summary trigger, with two calendar months on wide screens and one on narrow screens. The calendar highlights the selected interval. Picking the first date does not publish a partial range and refresh the enclosing view. Week/month/year precision selects whole units; date ends are inclusive and instant ends are exclusive. Existing open-ended values still display an open end. `variant="input"` retains direct date/time segment entry where required.
