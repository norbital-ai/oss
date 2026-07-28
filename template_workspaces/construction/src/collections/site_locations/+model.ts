import { custom, defineModel, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		location_name: text().notNull(),
		location_code: text(),
		project_id: uuid(),
		location_type: text(),
		parent_location_id: uuid(),
		grid_reference: text(),
		description: text(),
		coordinates: custom('site_coordinates'),
		bim_model_element_id: text()
	},
	{
		description: 'Work fronts and delivery zones within a project.',
		recordLabel: ['location_code', 'location_name'],
		icon: 'lucide:map-pin',
		indexes: [{ columns: ['location_code'], unique: true }]
	}
);
