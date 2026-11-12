import { capturePiece } from '../db/captured.ts';
import { enqueueDrain } from '../runs/queue.ts';
import type { Chain } from '../write/sql.ts';

export const SYNC_DELIVER = 'sync.deliver';
export const SYNC_EPOCH = "coalesce((SELECT value FROM sys_config WHERE key = 'integrations.epoch'), '')";
const pieces = new WeakMap<Chain, readonly string[]>();

/** Freeze replica changes and coalesce only a newer revision into work no attempt has started. */
export function enqueueReplicas(c: Chain, now: string, select: string): string {
	const prior = pieces.get(c) ?? [];
	const frozenKey = "s.sync || ':' || s.instance || ':' || s.record || ':' || s.record_revision";
	const unseen = ['sys_outbox', ...prior].map((source) =>
		`NOT EXISTS (SELECT 1 FROM ${source} prior WHERE prior.key = ${frozenKey})`).join(' AND ');
	const queued = capturePiece(c, `sync_queued${prior.length}`, 'sys_outbox', `INSERT INTO sys_outbox
		(id, sync, instance, model, record, op, record_revision, preserve_local, changed, image, writer, key, status, attempts, next_attempt_at, epoch, at)
		SELECT gen_random_uuid(), s.sync, s.instance, s.model, s.record, s.op, s.record_revision, s.preserve_local, s.changed, s.image,
		s.writer, ${frozenKey},
		'queued', 0, ${c.p(now)}::timestamptz, ${SYNC_EPOCH}, ${c.p(now)}::timestamptz FROM (${select}) s
		WHERE ${unseen}
		ON CONFLICT (sync, instance, record) WHERE status = 'queued' AND attempts = 0 DO UPDATE SET
			op = CASE WHEN sys_outbox.op = 'create' AND excluded.op <> 'delete' THEN 'create' ELSE excluded.op END,
			record_revision = excluded.record_revision, preserve_local = excluded.preserve_local,
			image = excluded.image, writer = excluded.writer, key = excluded.key,
			changed = (SELECT jsonb_agg(DISTINCT f) FROM jsonb_array_elements(sys_outbox.changed || excluded.changed) f)
		WHERE sys_outbox.record_revision < excluded.record_revision`, { returning: 'id, key' });
	pieces.set(c, [...prior, queued]);
	enqueueDrain(c, SYNC_DELIVER, c.p(now), `EXISTS (SELECT 1 FROM ${queued})`);
	return queued;
}
