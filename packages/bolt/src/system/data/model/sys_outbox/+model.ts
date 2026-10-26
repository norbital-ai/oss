// A sync's pending write (spec §3): one row per record change a read+write sync sends, queued in the statement that wrote
// the record. Delivered in order per record (`seq`), coalesced while queued, sent with its `key` as the Idempotency-Key;
// retried 8 times over about 6 hours (`attempts`, `next_attempt_at`), then `dead` until replayed. `result` is the remote's
// acknowledgement (`$id`, `$version`). Engine only: not exposed (the integration page reads it through the engine).
import { model } from '../../../../decl/model.ts';

export default model('sys_outbox', {
	description: 'A record change waiting to be written to another system by a sync.',
	label: 'key',
	fields: {
		seq: { kind: 'int' },
		/** `'<model>.sync.<sync>'`. */
		sync: { kind: 'text' },
		instance: { kind: 'ref', to: 'sys_integration', onDelete: 'cascade' },
		/** The record's model and id. */
		model: { kind: 'text' },
		record: { kind: 'text' },
		op: { kind: 'enum', values: ['create', 'update', 'delete'] },
		/** The record revision it sends. */
		record_revision: { kind: 'int' },
		/** The image retained for delete delivery after the record is gone. */
		image: { kind: 'json', optional: true },
		writer: { kind: 'ref', to: 'sys_user', optional: true, onDelete: 'setNull' },
		/** The fields changed since the last acknowledged write. */
		changed: { kind: 'json', default: [], shape: { kind: 'list', of: { kind: 'text' } } },
		/** The Idempotency-Key the remote dedupes a retried write by. */
		key: { kind: 'text', unique: true },
		status: {
			kind: 'enum',
			values: ['queued', 'sending', 'acked', 'failed', 'dead', 'skipped'],
			default: 'queued'
		},
		attempts: { kind: 'int', default: 0 },
		next_attempt_at: { kind: 'instant' },
		claimed_at: { kind: 'instant', optional: true },
		error: { kind: 'json', optional: true },
		/** The environment epoch that queued it: another epoch's rows are skipped. */
		epoch: { kind: 'text', optional: true },
		acked_at: { kind: 'instant', optional: true },
		result: { kind: 'json', optional: true },
		at: { kind: 'instant' }
	},
	unique: [
		{
			fields: ['sync', 'instance', 'record'],
			where: { status: { eq: 'queued' }, attempts: { eq: 0 } },
			name: 'coalesce'
		}
	],
	table: {
		primary: 'uuid',
		identity: 'seq',
		indexes: [
			{ on: ['next_attempt_at'], where: { status: { eq: 'queued' } } },
			{ on: ['sync', 'record', 'seq'], where: { status: { in: ['queued', 'sending'] } } },
			{ on: ['sync'], where: { status: { eq: 'dead' } } }
		]
	}
});
