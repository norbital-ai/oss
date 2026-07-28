import { defineModel, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		contractor_profile_id: uuid().notNull(),
		certification_type_id: uuid().notNull()
	},
	{
		description: 'Certification held by a contractor profile.',
		icon: 'lucide:badge-check',
		indexes: [{ columns: ['contractor_profile_id', 'certification_type_id'], unique: true }]
	}
);
