// Durable queues share claim and lease mechanics; each queue keeps its admission, ordering and retry policy.
import { Schema } from 'effect';
import type { Chain } from './write/sql.ts';

export const LEASE_MS = { turn: 180_000, sync: 300_000, outbound: 600_000 } as const;
const QUEUES = {
	sync: { table: 'sys_outbox', state: 'status', running: 'sending', due: 'next_attempt_at', stamp: 'claimed_at' },
	outbound: { table: 'sys_message', state: 'status', running: 'sending', due: 'next_attempt_at', stamp: 'claimed_at' }
} as const;
type Queue = keyof typeof QUEUES;

export const ClaimToken = Schema.Struct({
	id: Schema.String,
	attempts: Schema.Int,
	claimed_at: Schema.String
});
export type ClaimToken = typeof ClaimToken.Type;

export const leaseUntil = (now: string, millis: number): string =>
	new Date(Date.parse(now) + millis).toISOString();
export const leaseInterval = (queue: Queue): string => `interval '${LEASE_MS[queue]} milliseconds'`;
export const leaseExpiry = (queue: Queue, alias: string): string =>
	`${alias ? `${alias}.` : ''}claimed_at + ${leaseInterval(queue)}`;
/** The attempt identity survives an early provider report that already advanced its status. */
export const claim_matches = (c: Pick<Chain, 'p'>, token: ClaimToken, alias = ''): string => {
	const at = alias === '' ? '' : `${alias}.`;
	return `${at}id = ${c.p(token.id)} AND ${at}attempts = ${c.p(token.attempts)} AND ${at}claimed_at = ${c.p(token.claimed_at)}::timestamptz`;
};
/** Queue changes require the same attempt still waiting for its answer. */
export const claimedBy = (c: Pick<Chain, 'p'>, token: ClaimToken, alias = ''): string =>
	`${alias === '' ? '' : `${alias}.`}status = 'sending' AND ${claim_matches(c, token, alias)}`;
/** Renew owned claims before I/O or while a paced batch drains; a replaced claim returns no row. */
export const renewClaims = (queue: Queue, c: Pick<Chain, 'p'>, tokens: readonly ClaimToken[], now: string): string =>
	`WITH claims AS (SELECT * FROM jsonb_to_recordset(${c.p(tokens)}::jsonb)
		AS t(id ${queue === 'sync' ? 'uuid' : 'text'}, attempts int, claimed_at timestamptz))
	UPDATE ${QUEUES[queue].table} q SET claimed_at = ${c.p(now)}::timestamptz FROM claims t
	WHERE q.id = t.id AND q.status = 'sending' AND q.attempts = t.attempts AND q.claimed_at = t.claimed_at
	RETURNING q.id::text AS id, q.attempts, q.claimed_at::text`;

/** A queue head is locked before its owner changes state; concurrent workers skip it rather than sharing it. */
export const lockedHead = (options: {
	readonly from: string;
	readonly where: string;
	readonly order: string;
	readonly limit?: number;
	readonly columns?: string;
}): string => `SELECT ${options.columns ?? 'q.id'} FROM ${options.from}
	WHERE ${options.where} ORDER BY ${options.order}${options.limit === undefined ? '' : ` LIMIT ${options.limit}`}
	FOR UPDATE OF q SKIP LOCKED`;

/** One locked head per statement. The caller appends its RETURNING projection and retains its transaction lock. */
export function claimSql(
	queue: Queue,
	options: {
		readonly at: string;
		readonly where: string;
		readonly order: string;
		readonly limit: number;
		readonly join?: string;
		readonly set?: string;
	}
): string {
	const spec = QUEUES[queue];
	const queued = `q.${spec.state} = 'queued' AND q.${spec.due} <= ${options.at}::timestamptz`;
	const ready = `(${queued}) OR (q.${spec.state} = '${spec.running}' AND q.${spec.stamp} ${queue === 'sync' ? '<' : '<='} ${options.at}::timestamptz - ${leaseInterval(queue)})`;
	return `WITH queue_head AS MATERIALIZED (${lockedHead({
		from: `${spec.table} q ${options.join ?? ''}`,
		where: `(${ready}) AND (${options.where})`,
		order: options.order,
		limit: options.limit
	})})
	UPDATE ${spec.table} q SET ${spec.state} = '${spec.running}', attempts = q.attempts + 1,
		${spec.stamp} = ${options.at}::timestamptz${options.set === undefined ? '' : `, ${options.set}`}
	WHERE q.id IN (SELECT id FROM queue_head)`;
}

/** Persisted retries use an exponential base or a bounded delay table, capped before applying the queue's jitter. */
export const retryDelay = (
	attempt: number,
	base: number | readonly number[],
	cap: number,
	jitter = 1
): number => Math.min(
	typeof base === 'number' ? base * 2 ** (attempt - 1)
		: base[Math.min(Math.max(0, attempt - 1), base.length - 1)] ?? cap,
	cap
) * jitter;
