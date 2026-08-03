import {
	boolean,
	custom,
	date,
	defineModel,
	file,
	numeric,
	sql,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		employment_id: uuid().notNull(),
		leave_type_id: uuid().notNull(),
		event: custom('leave_event').notNull(),
		kind: text().generatedAlwaysAs(sql`event ->> 'kind'`),
		// A stored generated column must be immutable, and a text -> date cast is only STABLE.
		// `norbital_date` is the immutable wrapper the platform installs before any migration runs.
		from_date: date().generatedAlwaysAs(
			sql`CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN norbital_date(event ->> 'from_date') ELSE norbital_date(event ->> 'effective_on') END`
		),
		to_date: date().generatedAlwaysAs(
			sql`CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN norbital_date(event ->> 'to_date') ELSE norbital_date(event ->> 'effective_on') END`
		),
		days: numeric().generatedAlwaysAs(
			sql`CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN (event ->> 'days')::numeric ELSE (event ->> 'movement_days')::numeric END`
		),
		half_day_start: boolean().generatedAlwaysAs(
			sql`CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN (event ->> 'half_day_start')::boolean ELSE false END`
		),
		half_day_end: boolean().generatedAlwaysAs(
			sql`CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN (event ->> 'half_day_end')::boolean ELSE false END`
		),
		reason: text().generatedAlwaysAs(
			sql`CASE WHEN event ->> 'kind' = 'TIME_OFF' THEN event ->> 'reason' ELSE event ->> 'note' END`
		),
		certificate_file: file().generatedAlwaysAs(
			sql`CASE WHEN event ->> 'kind' = 'TIME_OFF' AND NULLIF(event ->> 'certificate_file', '') IS NOT NULL THEN (event ->> 'certificate_file')::uuid END`
		)
	},
	{
		description:
			'The complete leave event stream. Approved TIME_OFF rows are requests and their own TAKEN movement; balance adjustments and encashments use distinct union arms in the same collection.',
		recordLabel: ['from_date', 'to_date'],
		icon: 'lucide:calendar-off',
		indexes: [{ columns: ['employment_id', 'leave_type_id', 'from_date'] }]
	}
);
