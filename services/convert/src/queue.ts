// The durable job queue: one SQLite file (WAL) on a volume every replica mounts. A replica claims the oldest queued job
// with one UPDATE … RETURNING, so replicas pull work and no job runs twice at once; a claim holds a lease its replica
// renews, and a job whose replica died is queued again once the lease passes.
// ponytail: SQLite locks the whole file per write and WAL needs one host's shared memory, so replicas scale on one host
// (or one volume per host, each its own queue); a queue across hosts is a Postgres table with FOR UPDATE SKIP LOCKED.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type State = 'queued' | 'running' | 'succeeded' | 'failed';
export type Job = { id: string; state: State; to: string; error: string | null; created: string; updated: string };
export type Claimed = { id: string; request: string; reference: Uint8Array | null };

type Row = { id: string; state: State; target: string; error: string | null; created: number; updated: number };
const job = (r: Row): Job => ({ id: r.id, state: r.state, to: r.target, error: r.error, created: new Date(r.created).toISOString(), updated: new Date(r.updated).toISOString() });

export function openQueue(file: string, maxAttempts = 3) {
	const db = new DatabaseSync(file);
	db.exec(`
		PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
		CREATE TABLE IF NOT EXISTS job (
			id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, target TEXT NOT NULL, request TEXT NOT NULL,
			reference BLOB, result BLOB, mime TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, worker TEXT,
			lease_until INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL);
		CREATE INDEX IF NOT EXISTS job_state ON job (state, created);`);
	const q = {
		insert: db.prepare(`INSERT INTO job (id, owner, state, target, request, reference, created, updated) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`),
		get: db.prepare(`SELECT id, state, target, error, created, updated FROM job WHERE id = ? AND owner = ?`),
		result: db.prepare(`SELECT result, mime, target FROM job WHERE id = ? AND owner = ? AND state = 'succeeded'`),
		claim: db.prepare(`UPDATE job SET state = 'running', attempts = attempts + 1, worker = ?, lease_until = ?, updated = ?
			WHERE id = (SELECT id FROM job WHERE state = 'queued' ORDER BY created LIMIT 1) RETURNING id, request, reference`),
		finish: db.prepare(`UPDATE job SET state = ?, result = ?, mime = ?, error = ?, reference = NULL, worker = NULL, lease_until = NULL, updated = ?
			WHERE id = ? AND worker = ? AND state = 'running'`),
		renew: db.prepare(`UPDATE job SET lease_until = ? WHERE worker = ? AND state = 'running'`),
		recover: db.prepare(`UPDATE job SET worker = NULL, lease_until = NULL, updated = ?,
			state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
			error = CASE WHEN attempts >= ? THEN 'The conversion stopped ' || attempts || ' times before it finished.' ELSE error END
			WHERE state = 'running' AND lease_until < ?`),
		purge: db.prepare(`DELETE FROM job WHERE state IN ('succeeded', 'failed') AND updated < ?`),
		depth: db.prepare(`SELECT count(*) AS n FROM job WHERE state = 'queued'`)
	};
	return {
		submit(owner: string, to: string, request: string, reference: Uint8Array | null): Job {
			const id = randomUUID(), now = Date.now();
			q.insert.run(id, owner, to, request, reference, now, now);
			return job({ id, state: 'queued', target: to, error: null, created: now, updated: now });
		},
		get: (owner: string, id: string) => { const r = q.get.get(id, owner) as Row | undefined; return r && job(r); },
		result: (owner: string, id: string) => q.result.get(id, owner) as { result: Uint8Array; mime: string; target: string } | undefined,
		claim: (worker: string, leaseMs: number) => { const now = Date.now(); return q.claim.get(worker, now + leaseMs, now) as Claimed | undefined; },
		/** Only the replica still holding the lease writes the outcome; a job recovered from under it is not overwritten. */
		finish(id: string, worker: string, outcome: { result: Uint8Array; mime: string } | { error: string }) {
			const ok = 'result' in outcome;
			q.finish.run(ok ? 'succeeded' : 'failed', ok ? outcome.result : null, ok ? outcome.mime : null, ok ? null : outcome.error, Date.now(), id, worker);
		},
		/** A live replica's heartbeat: one statement extends every lease it holds. */
		renew: (worker: string, leaseMs: number) => q.renew.run(Date.now() + leaseMs, worker),
		recover: () => { const now = Date.now(); q.recover.run(now, maxAttempts, maxAttempts, now); },
		purge: (before: number) => q.purge.run(before),
		depth: () => (q.depth.get() as { n: number }).n,
		close: () => db.close()
	};
}
export type Queue = ReturnType<typeof openQueue>;
