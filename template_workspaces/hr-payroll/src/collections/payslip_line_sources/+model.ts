import { custom, defineModel, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		payslip_line_id: uuid().notNull(),
		source: custom('payslip_line_source').notNull()
	},
	{
		description:
			'What one payslip line consumed. A line is many-to-one with its sources — an overtime line reads every time entry in the window, a leave deduction reads the requests that caused it — so provenance is rows here rather than a column on the line.',
		recordLabel: ['payslip_line_id'],
		icon: 'lucide:link',
		indexes: [{ columns: ['payslip_line_id'] }]
	}
);
