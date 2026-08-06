import { custom, defineModel, enums, file, sql, text, uuid } from '@norbital-ai/pod/authoring';

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
		matched_evidence_ids: uuid().array().notNull(),
		/**
		 * The photo's own title, composed in SQL.
		 *
		 * `recordLabel` compiles to a CEL concatenation and CEL has no `+` overload for anything but
		 * strings, so naming `source` — a variant, an object — resolved to nothing and the record
		 * title fell back to joining every scalar column, which printed `job_assignment_id` and the
		 * hashes. No coercion turns an object into a title; where the photo came from is the answer.
		 */
		summary: text().generatedAlwaysAs(
			sql`CASE source ->> 'kind'
				WHEN 'workspace_upload' THEN 'Workspace upload'
				WHEN 'channel' THEN 'From ' || COALESCE(NULLIF(source ->> 'provider', ''), 'a channel') || COALESCE(' · ' || LEFT(source ->> 'sent_at', 10), '')
				ELSE 'Photo'
			END`
		)
	},
	{
		description:
			'One explicitly selected photo and its deterministic integrity result, linked to exactly one job assignment or variation request. Conversation history and unselected media are not retained.',
		recordLabel: 'summary',
		icon: 'lucide:scan-search',
		indexes: [
			{ columns: ['source_key'], unique: true },
			{ columns: ['sha256'] },
			{ columns: ['perceptual_hash'] }
		]
	}
);
