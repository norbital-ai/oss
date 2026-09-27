// Two-way sync (§3.3.5, P14): the per-field merge against the base shadow, what a row owes its source, and the shadow
// table. The merge is today's (`runtime/integrations/engine.ts:85-138`): the shadow is what the remote holds.
import type { Json } from '../../decl/values.ts';
import type { RowData, TenantDb } from '../contracts.ts';
import { q } from '../../protocol/catalog.ts';
import { changed } from '../write/flatten.ts';
import { GATED, type Chain } from '../write/sql.ts';

export type ConflictRule = 'remote_wins' | 'local_wins' | 'latest';
type Path = { path: string };
export type HttpSource = { connection: string; list: { path: string; records?: string; cursor?: string };
	create?: Path; update?: Path; delete?: Path; pull?: { cron: string } };
/** The engine form of an `integration()` literal. A body (`resolve`, an `in`, an `out`) is whatever the manifest keeps. */
export type IntegrationData = {
	direction: 'one_way' | 'two_way';
	source: { channel: string; inbound?: true } | HttpSource;
	identity: string;
	resolve?: unknown;
	fields: { readonly [field: string]: string | object };
	push?: { readonly [field: string]: string | object };
	owns?: { remote?: readonly string[]; local?: readonly string[] };
	conflicts?: { default: ConflictRule; fields?: { readonly [field: string]: ConflictRule } };
	policies: readonly string[];
};
export type Conflict = { field: string; base: Json; local: Json; remote: Json; rule: ConflictRule; winner: 'local' | 'remote' };

const same = (a: Json | undefined, b: Json | undefined): boolean => Object.keys(changed({ v: a ?? null }, { v: b ?? null })).length === 0;
const owns = (s: IntegrationData, side: 'remote' | 'local', f: string) => s.owns?.[side]?.includes(f) === true;

/** The fields a two_way integration pushes (local field → remote key or `out` body); default: its plain `fields` keys. */
export const pushFields = (s: IntegrationData): { readonly [field: string]: string | object } => s.push
	?? Object.fromEntries(Object.entries(s.fields).filter(([f, how]) => typeof how === 'string' && f !== s.identity));

/**
 * One remote record (in local form) against its linked row. One_way: the remote always wins. Two_way, per field:
 * whoever changed it since the base wins; both to the same value converged; both apart is a conflict the rule settles.
 * `owns.remote` always takes the remote; `owns.local` is never overwritten. No base (an adoption): every difference
 * is a conflict.
 */
export function merge(s: IntegrationData, base: RowData | undefined, local: RowData, remote: RowData,
	times: { local?: Json; remote?: Json } = {}): { write: RowData; push: boolean; conflicts: Conflict[] } {
	const write: Record<string, Json> = {}, conflicts: Conflict[] = [];
	let push = false;
	for (const field of Object.keys(s.fields)) {
		if (!(field in remote) || field === s.identity) continue;
		const theirs = remote[field]!, ours = local[field] ?? null;
		if (same(ours, theirs)) continue;
		if (s.direction === 'one_way' || owns(s, 'remote', field)) { write[field] = theirs; continue; }
		if (owns(s, 'local', field)) { push = true; continue; }
		const was = base?.[field];
		if (base !== undefined && same(ours, was)) { write[field] = theirs; continue; }
		if (base !== undefined && same(theirs, was)) { push = true; continue; }
		const rule = s.conflicts?.fields?.[field] ?? s.conflicts?.default ?? 'remote_wins';
		const remoteWins = rule === 'remote_wins' || (rule === 'latest' && !(Date.parse(String(times.local)) > Date.parse(String(times.remote))));
		conflicts.push({ field, base: was ?? null, local: ours, remote: theirs, rule, winner: remoteWins ? 'remote' : 'local' });
		if (remoteWins) write[field] = theirs;
		else push = true;
	}
	return { write, push, conflicts };
}

/** The pushed fields where the row differs from the shadow: what a local edit owes the source. */
export const localChanges = (s: IntegrationData, base: RowData, row: RowData): string[] =>
	Object.keys(pushFields(s)).filter((f) => !owns(s, 'remote', f) && !same(row[f], base[f]));

/**
 * The shadow rows an act writes in its own statement, found by identity among the act's pieces (`allp`) or the stored
 * rows. `expect` is the revision the row has once the act commits (`null`: a push is still owed); a different one
 * means a local write came between, so the shadow is left behind and the row stays owed.
 */
export const shadowPiece = (collection: string, identity: string, run: string,
	rows: readonly { remote: string; base: RowData; expect: number | null }[]) => (c: Chain): void => {
	const id = q(identity), cp = c.p(collection);
	c.cte('sync', `INSERT INTO bolt_sync (collection, record, remote, base, revision, status, error, run)
	SELECT ${cp}, r.id, v.remote, v.base, CASE WHEN v.expect = r.revision THEN r.revision END, 'ok', NULL, ${c.p(run)}
	FROM jsonb_to_recordset(${c.p(rows as unknown as Json)}::jsonb) AS v(remote text, base jsonb, expect int)
	CROSS JOIN LATERAL (SELECT x.id, x.revision FROM allp x WHERE x.c = ${cp} AND x.n ->> ${c.p(identity)} = v.remote
		UNION ALL SELECT t.id::text, t.revision FROM ${q(collection)} t WHERE t.${id}::text = v.remote
			AND t.id::text NOT IN (SELECT x.id FROM allp x WHERE x.c = ${cp}) LIMIT 1) r
	WHERE ${GATED}
	ON CONFLICT (collection, record) DO UPDATE SET remote = excluded.remote, base = excluded.base, revision = excluded.revision,
		status = 'ok', error = NULL, run = excluded.run`);
};

/**
 * An administrator's pause (L-BOLT-365), a `sys_config` flag per integration: a paused integration's pulls, pushes and
 * reconciles talk to no connection and end at once; what local writes owe stays owed in `bolt_sync` for the first push
 * after resume. A channel delivery still mirrors (the transport does not hold it for later).
 */
const PAUSED = 'integration:paused:';
export async function pausedIntegrations(db: Pick<TenantDb, 'read'>): Promise<Set<string>> {
	const [r] = await db.read([{ text: 'SELECT key FROM sys_config WHERE starts_with(key, $1)', params: [PAUSED] }]);
	return new Set(r!.rows.map((x) => String(x['key']).slice(PAUSED.length)));
}
export async function setPaused(db: Pick<TenantDb, 'write'>, collection: string, paused: boolean): Promise<void> {
	await db.write(paused ? { text: `INSERT INTO sys_config (key, value) VALUES ($1, 'true') ON CONFLICT (key) DO NOTHING`, params: [PAUSED + collection] }
		: { text: 'DELETE FROM sys_config WHERE key = $1', params: [PAUSED + collection] });
}
