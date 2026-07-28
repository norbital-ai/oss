import { defineModel, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		job_id: uuid().notNull(),
		site_location_id: uuid().notNull()
	},
	{
		description: 'Join table linking jobs to site locations.'
	}
);
