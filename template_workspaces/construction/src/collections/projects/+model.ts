import { custom, dateRange, defineModel, enums, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		project_name: text().notNull(),
		project_number: text(),
		client: text(),
		main_contractor: text(),
		status: enums(['planned', 'active', 'on_hold', 'complete', 'cancelled']),
		schedule_range: dateRange(),
		contract_value: custom('money'),
		project_type: text(),
		address: custom('project_address'),
		project_manager: text(),
		description: text()
	},
	{
		description: 'Construction projects and their operating context.',
		recordLabel: ['project_number', 'project_name'],
		icon: 'lucide:building-2',
		indexes: [{ columns: ['project_number'], unique: true }]
	}
);
