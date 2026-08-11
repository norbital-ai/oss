import {
	boolean,
	dateRange,
	defineModel,
	enums,
	integer,
	numeric,
	sql,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		jurisdiction_id: uuid().notNull(),
		/**
		 * The window: a break falls due once this many hours have been worked consecutively.
		 *
		 * This is the field `shift_definitions.break_minutes` and `time_entries.break_minutes` cannot
		 * express. Those are flat durations deducted from measured hours — they say how long a break
		 * was, never when it was owed, so "at least 30 minutes after 5 consecutive hours" is not
		 * checkable against them.
		 *
		 * Null where the cited authority grants a break but ties it to no consecutive-hours trigger,
		 * as the Philippine Labor Code art.85 does. Null is "the statute sets no window", not
		 * "nobody looked".
		 */
		after_consecutive_hours: numeric(),
		/** The minimum length of the break the authority requires, in whole minutes. */
		minimum_minutes: integer().notNull(),
		/**
		 * Whether the break counts as working time and is therefore paid.
		 *
		 * Nullable because several statutes fix the break and say nothing about its pay. Null means
		 * exactly that: the cited authority does not settle it, and no default may be inferred. A
		 * `false` written here is a statement the authority makes — Indonesian law says the rest
		 * period "tidak termasuk jam kerja"; Malaysian s.60A(1)(a) says nothing either way.
		 */
		counts_as_worked_time: boolean(),
		/**
		 * When the rule bites. `ALWAYS` is the ordinary entitlement; `CONTINUOUS_ATTENDANCE` is the
		 * variant for work that must be carried on without interruption; `OVERTIME` is a break owed
		 * only once overtime is worked.
		 */
		applies_when: enums(['ALWAYS', 'CONTINUOUS_ATTENDANCE', 'OVERTIME']).notNull(),
		authority: text().notNull(),
		effective_range: dateRange().notNull(),
		/**
		 * The rule's own title, composed in SQL.
		 *
		 * `recordLabel` compiles to a CEL concatenation and CEL has no `+` overload for anything but
		 * strings, so naming `minimum_minutes` resolved to nothing and the record title fell back to
		 * joining every scalar column, uuids included. The break's length is half of what tells one
		 * rule from another, so it stays in the label — spelled out as text here, where
		 * concatenation works.
		 */
		summary: text({ search: true }).generatedAlwaysAs(sql`applies_when || ' · ' || minimum_minutes || ' min'`)
	},
	{
		description:
			'A statutory rest or meal break in a jurisdiction: how many consecutive hours trigger it, the minimum length it must run, and whether it counts as working time.',
		recordLabel: 'summary',
		icon: 'lucide:coffee',
		// A jurisdiction may carry several breaks at once — an ordinary one and a continuous-attendance
		// variant are different entitlements, not competing versions of one. `applies_when` is the
		// equality member so those coexist, while two rules of the same kind cannot overlap in time.
		exclusions: [
			{
				name: 'rest_break_rules_no_overlap',
				elements: [
					{ expr: 'jurisdiction_id', with: '=' },
					{ expr: 'applies_when', with: '=' },
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
