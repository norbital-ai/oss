// A sync's pending write (spec §3): one row per record change a read+write sync sends, queued in the statement that wrote
// the record. Delivered in order per record (`seq`), coalesced while queued, sent with its `key` as the Idempotency-Key;
// retried 8 times over about 6 hours (`attempts`, `next_attempt_at`), then `dead`. A later acknowledged change retires older dead rows. `result` is the remote's
// acknowledgement (`$id`, `$version`). Engine only: not exposed (the integration page reads it through the engine).
import { bind_system_model } from '../../../../decl/model.ts';

export default bind_system_model('sys_outbox')({
	description: 'A record change waiting to be written to another system by a sync.',
	record_label: 'record.key',
	fields: {
		seq: { kind: 'int' },
		/** `'<model>.sync.<sync>'`. */
		sync: { kind: 'text' },
		instance: { kind: 'ref', to: 'sys_integration', on_delete: 'cascade' },
		/** The record's model and id. */
		model: { kind: 'text' },
		record: { kind: 'text' },
		op: { kind: 'enum', values: ['create', 'update', 'delete'] },
		/** The replica operation, frozen on its first claim and retained across retries. */
		delivery_op: { kind: 'enum', values: ['create', 'update', 'delete'], optional: true },
		/** The record revision it sends. */
		record_revision: { kind: 'int' },
		/** Initialization and recovery failures must not undo already committed local history. */
		preserve_local: { kind: 'bool', default: false },
		/** The image retained for delete delivery after the record is gone. */
		image: { kind: 'json', optional: true },
		writer: { kind: 'ref', to: 'sys_user', optional: true, on_delete: 'set_null' },
		/** The fields changed since the last acknowledged write. */
		changed: { kind: 'json', default: [], shape: { kind: 'text', many: true } },
		/** The Idempotency-Key the remote dedupes a retried write by. */
		key: { kind: 'text' },
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
	constraints: {
		key: { unique: ['key'] },
		coalesce: {
			unique: ['sync', 'instance', 'record'],
			where: { status: { eq: 'queued' }, attempts: { eq: 0 } }
		}
	},
	table: {
		primary: 'uuid',
		identity: 'seq'
	},
	indexes: {
		by_next_attempt_at: { on: ['next_attempt_at'], where: { status: { eq: 'queued' } } },
		by_sync_record_seq: {
			on: ['sync', 'record', 'seq'],
			where: { status: { in: ['queued', 'sending'] } }
		},
		by_sync: { on: ['sync'], where: { status: { eq: 'dead' } } },
		by_replica_revision: { on: ['sync', 'instance', 'record', 'record_revision'] }
	}
});
