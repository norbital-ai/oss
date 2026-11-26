// The team graph: every `sys_team` row, as an administrator keeps it. A team confers its own policies; its parent
// scopes data (`actor.team_tree`) and lends none.
import { Clock, Effect } from 'effect';
import { sql } from '../db/sql.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { row } from '../system/rows.ts';
import { SESSION_MEMO_MS, sha256 } from './session.ts';

const TeamRow = row('sys_team', ['id', 'name', 'parent', 'policies', 'revision']);
export type Team = {
	readonly name: string;
	readonly parent: string | null;
	readonly policies: readonly string[];
};
export type TeamGraph = {
	readonly teams: { readonly [id: string]: Team };
	/** A digest of every team's id and row revision: an authority compiled from the graph carries it in its key. */
	readonly revision: string;
};
const remembered = new WeakMap<
	TenantDb,
	{ readonly graph: TeamGraph; readonly stamp: number; readonly at: number }
>();

/** The graph, from memory while no statement writing `sys_team` has finished since it was read. */
export const teamGraph = Effect.fn('Bolt.teamGraph')(function* (db: TenantDb) {
	const now = yield* Clock.currentTimeMillis,
		stamp = db.teamWrites(),
		held = remembered.get(db);
	// ponytail: another activation's write is seen once the memo passes; a shared write stamp would close the window
	if (held !== undefined && held.stamp === stamp && now - held.at < SESSION_MEMO_MS) return held.graph;
	const rows = yield* db.rows(
		TeamRow,
		sql('SELECT id, name, parent, policies, revision FROM sys_team ORDER BY id')
	);
	const graph: TeamGraph = {
		teams: Object.fromEntries(
			rows.map(({ id, name, parent, policies }) => [id, { name, parent, policies }])
		),
		revision: sha256(rows.map(({ id, revision }) => `${id}:${revision}`).join(','))
	};
	remembered.set(db, { graph, stamp, at: now });
	return graph;
});

/** Whether following `parent` from `id` comes back to a team already passed. */
export function cyclic(parent: (id: string) => string | null | undefined, id: string): boolean {
	const seen = new Set([id]);
	for (let at = parent(id); at != null; at = parent(at)) {
		if (seen.has(at)) return true;
		seen.add(at);
	}
	return false;
}

/** Each team's policies by id: what a notice's team and policy recipients resolve against. */
export type TeamPolicies = { readonly [id: string]: readonly string[] };
export const teamPolicies = (graph: TeamGraph): TeamPolicies =>
	Object.fromEntries(Object.entries(graph.teams).map(([id, team]) => [id, team.policies]));

/** A team and every descendant (`actor.team_tree`). */
export function closure(graph: TeamGraph, root: string): string[] {
	const out = [root];
	for (let i = 0; i < out.length; i++)
		for (const [id, team] of Object.entries(graph.teams))
			if (team.parent === out[i] && !out.includes(id)) out.push(id);
	return out;
}
/** A team's name and each ancestor's, nearest first. */
export function path(graph: TeamGraph, root: string): string[] {
	const out: string[] = [],
		seen = new Set<string>();
	for (let id: string | null = root; id !== null && !seen.has(id); ) {
		seen.add(id);
		const team: Team | undefined = graph.teams[id];
		if (team === undefined) break;
		out.push(team.name);
		id = team.parent;
	}
	return out;
}
