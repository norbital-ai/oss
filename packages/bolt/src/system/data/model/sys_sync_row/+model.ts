// A remote sync's id map (spec §3): which record a remote row (`remote_id`, the read's `$id`) is, the remote version last
// seen (the `$version` guard), the snapshot cycle it was last seen in, and the record revision the remote acknowledged
// (what a refused write restores). A record maps to one remote row per sync and instance. Engine only: not exposed.
import { bind_model } from '../../../../declarations.ts';

export default bind_model('sys_sync_row')({
	description: "A remote sync's mapping of one remote row to its record.",
	record_label: 'record.remote_id',
	fields: {
		/** `'<model>.sync.<sync>'`. */
		sync: { kind: 'text' },
		instance: { kind: 'ref', to: 'sys_integration', on_delete: 'cascade' },
		partition: { kind: 'text', default: '' },
		remote_id: { kind: 'text' },
		/** The record's id in the sync's model. */
		record: { kind: 'text' },
		remote_version: { kind: 'text', optional: true },
		cycle: { kind: 'int' },
		acked_revision: { kind: 'int', optional: true }
	},
	constraints: {
		one_remote_id: { unique: ['sync', 'instance', 'remote_id'] },
		one_record: { unique: ['sync', 'instance', 'record'] }
	},

	table: { primary: 'uuid' },
	indexes: { by_sync_instance_partition_cycle: { on: ['sync', 'instance', 'partition', 'cycle'] } }
});
