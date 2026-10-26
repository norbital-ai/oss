// A remote sync's id map (spec §3): which record a remote row (`remote_id`, the read's `$id`) is, the remote version last
// seen (the `$version` guard), the snapshot cycle it was last seen in, and the record revision the remote acknowledged
// (what a refused write restores). A record maps to one remote row per sync and instance. Engine only: not exposed.
import { model } from '../../../../decl/model.ts';

export default model('sys_sync_row', {
	description: "A remote sync's mapping of one remote row to its record.",
	label: 'remote_id',
	fields: {
		/** `'<model>.sync.<sync>'`. */
		sync: { kind: 'text' },
		instance: { kind: 'ref', to: 'sys_integration', onDelete: 'cascade' },
		partition: { kind: 'text', default: '' },
		remote_id: { kind: 'text' },
		/** The record's id in the sync's model. */
		record: { kind: 'text' },
		remote_version: { kind: 'text', optional: true },
		cycle: { kind: 'int' },
		acked_revision: { kind: 'int', optional: true }
	},
	unique: [
		{ fields: ['sync', 'instance', 'remote_id'] },
		{ fields: ['sync', 'instance', 'record'] }
	],
	index: [['sync', 'instance', 'partition', 'cycle']],
	table: { primary: 'uuid' }
});
