import { custom, defineModel, enums, file, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		job_assignment_id: uuid(),
		variation_request_id: uuid(),
		document_asset_id: file({ mimeTypes: ['image/jpeg', 'image/png'] }).notNull(),
		source_key: text().notNull(),
		source: custom('photo_source').notNull(),
		sha256: text().notNull(),
		perceptual_hash: text().notNull(),
		flags: enums([
			'exact_duplicate',
			'visual_duplicate',
			'metadata_anomaly',
			'edited_metadata',
			'low_quality'
		])
			.array()
			.notNull(),
		matched_evidence_ids: uuid().array().notNull()
	},
	{
		description:
			'One explicitly selected photo and its deterministic integrity result, linked to exactly one job assignment or variation request. Conversation history and unselected media are not retained.',
		recordLabel: 'source_key',
		icon: 'lucide:scan-search',
		indexes: [
			{ columns: ['source_key'], unique: true },
			{ columns: ['sha256'] },
			{ columns: ['perceptual_hash'] }
		]
	}
);
