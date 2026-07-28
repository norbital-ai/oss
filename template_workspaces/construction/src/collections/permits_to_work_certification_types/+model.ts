import { defineModel, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		permits_to_work_id: uuid().notNull(),
		certification_type_id: uuid().notNull()
	},
	{
		description: 'Join table linking permits to work to certification types.'
	}
);
