// A remote sync's read state per instance and partition (spec §3): its cursor, compared and set in the statement that
// writes a page; the snapshot cycle and phase; its health; and when it last read, found a change, or got a webhook hint.
// `digest` is the sync declaration's: a changed declaration starts the cursor over. Engine only: not exposed.
import { bind_model } from '../../../../declarations.ts';

export default bind_model('sys_sync')({
	description: "A remote sync's read cursor and health for one integration instance and partition.",
	record_label: 'record.sync',
	fields: {
		/** `'<model>.sync.<sync>'`. */
		sync: { kind: 'text' },
		instance: { kind: 'ref', to: 'sys_integration', on_delete: 'cascade' },
		/** The partition (a calendar of the account), `''` when the sync declares none. */
		partition: { kind: 'text', default: '' },
		cursor: { kind: 'json', optional: true },
		/** The snapshot cycle: rows of the id map not seen in a closed snapshot's cycle are deleted. */
		cycle: { kind: 'int', default: 0 },
		phase: { kind: 'enum', values: ['read', 'reconcile'], default: 'read' },
		health: { kind: 'json', optional: true },
		digest: { kind: 'text' },
		/** The compare-and-set version of the cursor. */
		version: { kind: 'int', default: 0 },
		/** First observed state: a fixed baseline for quiet-webhook health. */
		started_at: { kind: 'instant', default: { var: 'now' } },
		last_read_at: { kind: 'instant', optional: true },
		last_change_at: { kind: 'instant', optional: true },
		last_hint_at: { kind: 'instant', optional: true }
	},
	constraints: { one_partition: { unique: ['sync', 'instance', 'partition'] } },
	table: { primary: 'uuid' }
});
