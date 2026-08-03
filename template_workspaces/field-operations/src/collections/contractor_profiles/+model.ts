import { defineModel, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		user_id: uuid().notNull(),
		company_name: text().notNull()
	},

	{
		description:
			'Contractor organisation linked to the tenant user who can open the contractor workspace. Certification holdings are governed through contractor_certifications.',
		recordLabel: 'company_name',
		icon: 'lucide:hard-hat',
		indexes: [{ columns: ['user_id'], unique: true }]
	}
);
