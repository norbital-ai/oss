import { dateRange, defineModel, enums, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		title: text().notNull(),
		document_number: text(),
		project_id: uuid(),
		site_location_id: uuid(),
		document_type: enums([
			'ifc_model',
			'handover_pack',
			'o_and_m',
			'drawing',
			'specification',
			'certificate'
		]),
		asset_tag: text(),
		asset_category: enums(['bim_model', 'handover', 'operations']),
		status: enums(['draft', 'in_review', 'issued', 'superseded', 'archived']),
		validity_range: dateRange(),
		document_url: text(),
		version: text(),
		tags: text().array()
	},
	{
		description: 'Handover and asset-linked document records.',
		recordLabel: 'title',
		icon: 'lucide:file-text',
		indexes: [{ columns: ['document_number'], unique: true }]
	}
);
