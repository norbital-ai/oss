import { custom, defineModel, sql, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		payslip_line_id: uuid().notNull(),
		source: custom('payslip_line_source').notNull(),
		/**
		 * Read-only projections of the source arms. The union remains the audit record; these generated
		 * keys let consumers follow every provenance link with indexed relations.
		 */
		component_entry_id: uuid().generatedAlwaysAs(
			sql`CASE WHEN source ->> 'kind' = 'COMPONENT_ENTRY' THEN (source ->> 'entry_id')::uuid END`
		),
		time_entry_id: uuid().generatedAlwaysAs(
			sql`CASE WHEN source ->> 'kind' = 'TIME_ENTRY' THEN (source ->> 'time_entry_id')::uuid END`
		),
		leave_request_id: uuid().generatedAlwaysAs(
			sql`CASE WHEN source ->> 'kind' = 'LEAVE_REQUEST' THEN (source ->> 'leave_request_id')::uuid END`
		)
	},
	{
		description:
			'What one payslip line consumed. A line is many-to-one with its sources — an overtime line reads every time entry in the window, a leave deduction reads the requests that caused it — so provenance is rows here rather than a column on the line.',
		recordLabel: ['payslip_line_id'],
		icon: 'lucide:link',
		indexes: [
			{ columns: ['payslip_line_id'] },
			{ columns: ['component_entry_id'], where: '"component_entry_id" IS NOT NULL' },
			{ columns: ['time_entry_id'], where: '"time_entry_id" IS NOT NULL' },
			{ columns: ['leave_request_id'], where: '"leave_request_id" IS NOT NULL' }
		]
	}
);
