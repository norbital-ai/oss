import { custom, defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		reference_name: text({ search: true }).notNull(),
		reference_code: text(),
		project_id: uuid(),
		category: text(),
		subcategory: text(),
		unit_of_measure: text(),
		rate: custom('money'),
		embodied_carbon_per_unit: numeric(),
		carbon_unit: text(),
		specification: text(),
		bim_guid: text(),
		data_source: text()
	},
	{
		description:
			'Reference matrix entries used as the BIM item master sheet for cost and embodied carbon estimation.',
		recordLabel: 'reference_name',
		icon: 'lucide:table-properties',
		indexes: [{ columns: ['reference_code'], unique: true }]
	}
);
