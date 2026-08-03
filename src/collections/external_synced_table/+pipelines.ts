import { z } from 'zod';
import type { Pipelines } from './$types.js';

/**
 * The wire shape one external record arrives in.
 *
 * Deliberately minimal: a business key, an opaque internal id, and which local collection the record
 * belongs to. Mapping those onto a mirrored master is the importing system's job, not this schema's —
 * this collection only records that the correspondence exists and whether it is current.
 */
const externalRecordSchema = z.object({
	collection_name: z.string().trim().min(1),
	external_code: z.string().trim().min(1),
	external_id: z.string().trim().min(1).optional(),
	payload_hash: z.string().trim().min(1).optional()
});

const importSchema = z.object({
	external_system: z.string().trim().min(1),
	records: z.array(externalRecordSchema).min(1)
});

export default {
	import: {
		input: importSchema,
		handler: async (ctx, api) => {
			const input = importSchema.parse(ctx.input);
			const existing = await api.db.query.external_synced_table.findMany({
				where: { external_system: { eq: input.external_system } },
				columns: { collection_name: true, external_code: true },
				limit: 20000
			});
			const known = new Set(
				existing.map((row) => `${row.collection_name}\u0000${row.external_code}`)
			);

			// The unique index would reject a repeat, and a rejected batch imports nothing. Skipping
			// records already on file keeps a re-delivered page idempotent instead of fatal.
			return input.records
				.filter((record) => !known.has(`${record.collection_name}\u0000${record.external_code}`))
				.map((record) => ({
					collection_name: record.collection_name,
					external_system: input.external_system,
					external_code: record.external_code,
					external_id: record.external_id ?? null,
					payload_hash: record.payload_hash ?? null,
					sync_direction: 'inbound' as const,
					sync_state: 'pending' as const
				}));
		}
	},
	export: {
		handler: async ({ records }) => {
			const rows = records.map((row) => ({
				collection_name: row.collection_name,
				external_system: row.external_system,
				external_code: row.external_code,
				external_id: row.external_id ?? '',
				sync_direction: row.sync_direction ?? '',
				sync_state: row.sync_state ?? '',
				last_synced_at: row.last_synced_at ? row.last_synced_at.toISOString() : '',
				last_error: row.last_error ?? ''
			}));

			return [
				{
					label: `External sync state · ${rows.length} record(s)`,
					attachments: [
						{
							name: 'external-sync-state.csv',
							contentType: 'CSV',
							content: rows
						}
					],
					metadata: { schema: 'norbital.crm.external_sync.v1', record_count: rows.length }
				}
			];
		}
	}
} satisfies Pipelines;
