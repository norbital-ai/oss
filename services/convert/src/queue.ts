// The durable job queue: one SQLite file (WAL) on a volume every replica mounts, holding what a job is and never its bytes.
// A replica claims with one UPDATE … RETURNING, so replicas pull work and no job runs twice at once: the lane with the
// fewest jobs running first, so a burst from one tenant queues behind itself, then its interactive work, then the oldest. A
// claim holds a lease its replica renews, and a job whose replica died is queued again once the lease passes.
// ponytail: SQLite locks the whole file per write and WAL needs one host's shared memory, so replicas scale on one host
// (or one volume per host, each its own queue); a queue across hosts is a Postgres table with FOR UPDATE SKIP LOCKED.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type State = 'queued' | 'running' | 'succeeded' | 'failed';
export type Job = {
	id: string;
	state: State;
	to: string;
	error: string | null;
	created: string;
	updated: string;
};
type Claimed = { id: string; request: string; reference: Uint8Array | null };

type Row = {
	id: string;
	state: State;
	target: string;
	error: string | null;
	created: number;
	updated: number;
};
const job = (r: Row): Job => ({
	id: r.id,
	state: r.state,
	to: r.target,
	error: r.error,
	created: new Date(r.created).toISOString(),
	updated: new Date(r.updated).toISOString()
});

export function openQueue(file: string, maxAttempts = 3) {
	const db = new DatabaseSync(file);
	db.exec(`
		PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS job (
			id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, target TEXT NOT NULL, request TEXT NOT NULL,
			reference BLOB, result BLOB, mime TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, worker TEXT,
			lease_until INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL);
		CREATE INDEX IF NOT EXISTS job_state ON job (state, created);`);
	if (db.prepare(`SELECT 1 FROM pragma_table_info('job') WHERE name = 'lane'`).get() === undefined)
		db.exec(`ALTER TABLE job ADD COLUMN lane TEXT NOT NULL DEFAULT '';
			ALTER TABLE job ADD COLUMN priority INTEGER NOT NULL DEFAULT 1;`);
	db.exec(`CREATE INDEX IF NOT EXISTS job_lane ON job (state, lane);`);
	const q = {
		insert: db.prepare(
			`INSERT INTO job (id, owner, state, target, request, reference, lane, priority, created, updated) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`
		),
		get: db.prepare(
			`SELECT id, state, target, error, created, updated FROM job WHERE id = ? AND owner = ?`
		),
		result: db.prepare(
			`SELECT mime, target FROM job WHERE id = ? AND owner = ? AND state = 'succeeded'`
		),
		claim:
			db.prepare(`UPDATE job SET state = 'running', attempts = attempts + 1, worker = ?, lease_until = ?, updated = ?
			WHERE id = (SELECT id FROM job q WHERE state = 'queued' ORDER BY
				(SELECT count(*) FROM job r WHERE r.state = 'running' AND r.lane = q.lane), priority, created LIMIT 1)
			RETURNING id, request, reference`),
		finish:
			db.prepare(`UPDATE job SET state = ?, mime = ?, error = ?, reference = NULL, worker = NULL, lease_until = NULL, updated = ?
			WHERE id = ? AND worker = ? AND state = 'running'`),
		renew: db.prepare(`UPDATE job SET lease_until = ? WHERE worker = ? AND state = 'running'`),
		recover: db.prepare(`UPDATE job SET worker = NULL, lease_until = NULL, updated = ?,
			state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
			error = CASE WHEN attempts >= ? THEN 'The conversion stopped ' || attempts || ' times before it finished.' ELSE error END
			WHERE state = 'running' AND lease_until < ?`),
		purge: db.prepare(`DELETE FROM job WHERE state IN ('succeeded', 'failed') AND updated < ? RETURNING id`),
		depth: db.prepare(`SELECT count(*) AS n FROM job WHERE state = 'queued'`)
	};
	return {
		submit(
			owner: string,
			to: string,
			request: string,
			reference: Uint8Array | null,
			lane = '',
			priority = 1
		): Job {
			const id = randomUUID(),
				now = Date.now();
			q.insert.run(id, owner, to, request, reference, lane, priority, now, now);
			return job({ id, state: 'queued', target: to, error: null, created: now, updated: now });
		},
		get: (owner: string, id: string) => {
			const r = q.get.get(id, owner) as Row | undefined;
			return r && job(r);
		},
		result: (owner: string, id: string) =>
			q.result.get(id, owner) as { mime: string; target: string } | undefined,
		claim: (worker: string, leaseMs: number) => {
			const now = Date.now();
			return q.claim.get(worker, now + leaseMs, now) as Claimed | undefined;
		},
		/** Only the replica still holding the lease writes the outcome; a job recovered from under it is not overwritten. */
		finish(
			id: string,
			worker: string,
			outcome: { mime: string } | { error: string }
		) {
			const ok = 'mime' in outcome;
			q.finish.run(
				ok ? 'succeeded' : 'failed',
				ok ? outcome.mime : null,
				ok ? null : outcome.error,
				Date.now(),
				id,
				worker
			);
		},
		/** A live replica's heartbeat: one statement extends every lease it holds. */
		renew: (worker: string, leaseMs: number) => q.renew.run(Date.now() + leaseMs, worker),
		recover: () => {
			const now = Date.now();
			q.recover.run(now, maxAttempts, maxAttempts, now);
		},
		/** Settled jobs past `before` gone: their ids, for their results on the disk. */
		purge: (before: number) => (q.purge.all(before) as { id: string }[]).map((row) => row.id),
		depth: () => (q.depth.get() as { n: number }).n,
		close: () => db.close()
	};
}
export type Queue = ReturnType<typeof openQueue>;
