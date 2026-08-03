import {
	defineModel,
	enums,
	geolocation,
	custom,
	text,
	timestamp,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		job_id: uuid().notNull(),
		contractor_profile_id: uuid().notNull(),
		dispatched_at: timestamp(),
		status: enums(['dispatched', 'in_progress', 'completed', 'flagged']),
		completed_at: timestamp(),
		amount_charged: custom('money'),
		location: geolocation(),
		summary: text(),
		source_message_id: text()
	},
	{
		description:
			'Contractor assigned to a site job. Tracks dispatch, on-site progression, and photo evidence.',
		recordLabel: ['job_id', 'status'],
		icon: 'lucide:clipboard-check',
		indexes: [
			{ columns: ['source_message_id'], unique: true },
			{ columns: ['job_id'], unique: true },
			{ columns: ['contractor_profile_id'] }
		]
	}
);
