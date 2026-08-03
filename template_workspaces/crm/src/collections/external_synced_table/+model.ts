import { defineModel, enums, text, timestamp, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		collection_name: text().notNull(),
		record_id: uuid(),
		external_system: text().notNull(),
		external_code: text().notNull(),
		external_id: text(),
		sync_direction: enums(['inbound', 'outbound', 'bidirectional']),
		sync_state: enums(['pending', 'synced', 'conflict', 'failed', 'orphaned']),
		payload_hash: text(),
		last_synced_at: timestamp(),
		last_error: text()
	},
	{
		description:
			'One row per record this workspace keeps in step with an external system of record. Every external key, sync state, and failure reason lives here rather than as extra columns on accounts, products, or suppliers — so the domain collections never carry a particular vendor\u2019s identifiers, and answering "what is out of step, and why" is one query instead of a survey of every table.',
		recordLabel: ['external_system', 'external_code'],
		icon: 'lucide:refresh-cw',
		indexes: [
			{ columns: ['external_system', 'collection_name', 'external_code'], unique: true },
			{ columns: ['record_id'] },
			{ columns: ['collection_name'] },
			{ columns: ['sync_state'] }
		]
	}
);
