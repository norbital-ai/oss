// The approval lock (rule 46a): while a request is Pending or ChangesRequested, the records it holds — root, the inline
// children its provisional change touched, and any owned child created under a held record — change only through the
// request: the current step's approvers (its teams' members and its users) in Pending, the requester in ChangesRequested
// (whose save resubmits, approvals.ts `resubmit`). Every write path ends in one
// commit statement (rule 20), so the lock is pieces of that statement; an approval decision's own rollback is exempt.
import { Effect, Option, Schema } from 'effect';
import type { EngineActor } from '../contracts.ts';
import { relations, teams, type EngineManifest, type GrantData } from '../manifest.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { q, type Catalog } from '@norbital-ai/store';
import type { RowApproval } from '../../decl/names.ts';
import { GATED, type Chain } from '../write/sql.ts';
import { actorRef } from '../write/commit.ts';
import { Snapshot } from './snapshot.ts';
/** `[child, fk, parent]` of every owned relationship. */
export const ownedEdges = (m: EngineManifest, cat: Catalog) =>
	relations(m).all.flatMap((rel) =>
		rel.spec.owned === true
			? rel.targets.flatMap((parent) =>
					cat.models.has(parent) &&
					cat.models.get(rel.from)?.one.get(rel.fk)?.targets.includes(parent) === true
						? [
								[
									rel.from,
									rel.targets.length > 1 ? `${rel.fk}__${parent}` : rel.fk,
									parent
								] as const
							]
						: []
				)
			: []
	);
/** The row images `source` touched (its direct and cascaded rows), plus the held parents of the owned children among them. */
const touched = (m: EngineManifest, cat: Catalog, c: Chain, source: string, decision: boolean) => {
	const own = decision ? 'NOT erased' : `cause IN ('direct', 'cascade') AND NOT erased`;
	return [
		`SELECT c, id FROM ${source} WHERE ${own}`,
		...ownedEdges(m, cat).map(
			([child, fk, parent]) =>
				`SELECT ${c.p(parent)}::text, image.j ->> ${c.p(fk)}::text FROM ${source}
				CROSS JOIN LATERAL (VALUES (o),(n)) image(j) WHERE c = ${c.p(child)} AND ${own}`
		)
	].join(' UNION ');
};
/** A checkpoint entry for each row `x` of `source`: its revision before this statement (null: it did not exist). */
export const checkpoint = (x: string) =>
	`jsonb_build_object('collection', ${x}.c, 'id', ${x}.id, 'op', ${x}.op, 'before', CASE WHEN ${x}.o IS NULL THEN NULL ELSE coalesce((${x}.o->>'revision')::int, ${x}.revision - 1) END)`;
const held = (records: string, c: string, id: string) =>
	`EXISTS (SELECT 1 FROM jsonb_array_elements(${records}) r WHERE r ->> 'collection' = ${c} AND r ->> 'id' = ${id})`;

/** The current step's approvers (`team` among its teams, member `id` among its users) in Pending, the requester in ChangesRequested (alias `a`). */
const eligible = (team: string, id: string, ref: string) =>
	`coalesce((a.state = 'Pending' AND (a.route -> 'steps' -> a.step -> 'teams' ? ${team}::text
			OR a.route -> 'steps' -> a.step -> 'users' ? ${id}::text))
			OR (a.state = 'ChangesRequested' AND a.requestor = ${ref}), false)`;
/** The actor's own team and member id, as `eligible` compares them (static identities have neither). */
const own = (actor: EngineActor) =>
	actor.kind === 'member'
		? { team: actor.teams[0] ?? null, id: actor.id }
		: { team: null, id: null };

/**
 * The lock over `source` (the statement's `allp`): refuse any touched held record the actor may not change, and add the
 * affected cascade rows and owned children to an eligible actor's request checkpoint. Returns the hit requests' CTE.
 */
export function lockPieces(
	m: EngineManifest,
	cat: Catalog,
	c: Chain,
	actor: EngineActor,
	source: string,
	excludeRequest?: string
): string {
	const { team, id } = own(actor);
	c.cte('ap_touch', touched(m, cat, c, source, excludeRequest !== undefined));
	c.cte(
		'ap_hit',
		`SELECT a.id, a.state, a.step, a.route, a.requestor_user, a.records,
		${eligible(c.p(team), c.p(id), c.p(actorRef(actor)))} AS eligible
	FROM bolt_approvals a WHERE a.state IN ('Pending', 'ChangesRequested')
		${excludeRequest === undefined ? '' : `AND a.id <> ${c.p(excludeRequest)}::uuid`}
		AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.records) r JOIN ap_touch t ON t.c = r ->> 'collection' AND t.id = r ->> 'id')
	ORDER BY a.id FOR UPDATE OF a`
	);
	c.assertWith(
		"NOT EXISTS (SELECT 1 FROM ap_hit WHERE route ? '__boltReadGuards')",
		'conflict',
		"(SELECT jsonb_build_object('collection', 'approval_request', 'ids', jsonb_agg(id::text))::text FROM ap_hit WHERE route ? '__boltReadGuards')"
	);
	const names = c.p(
		Object.fromEntries(Object.entries(teams(m)).map(([handle, t]) => [handle, t.name ?? handle]))
	);
	c.assertWith(
		'NOT EXISTS (SELECT 1 FROM ap_hit WHERE NOT eligible)',
		'underApproval',
		`(SELECT h.id::text || ' Under approval: ' || CASE WHEN h.state = 'ChangesRequested'
			THEN coalesce(u.name, u.email, 'the requester')
			ELSE coalesce((SELECT string_agg(x, ' or ') FROM (
				SELECT coalesce(${names}::jsonb ->> s, s) AS x FROM jsonb_array_elements_text(h.route -> 'steps' -> h.step -> 'teams') s
				UNION ALL SELECT coalesce(su.name, su.email, s) FROM jsonb_array_elements_text(h.route -> 'steps' -> h.step -> 'users') s
					LEFT JOIN sys_user su ON su.id::text = s) w), 'its approvers') END
			|| ' may change it.' FROM ap_hit h LEFT JOIN sys_user u ON u.id::text = h.requestor_user WHERE NOT h.eligible LIMIT 1)`
	);
	const edges = relations(m).all.flatMap((rel) => {
		const action = rel.spec.onDelete ?? (rel.spec.owned === true ? 'cascade' : 'restrict');
		return rel.targets.flatMap((parent) =>
			cat.models.has(parent) &&
			cat.models.get(rel.from)?.one.get(rel.fk)?.targets.includes(parent) === true &&
			(rel.spec.owned === true || action === 'cascade' || action === 'setNull')
				? [
						{
							child: rel.from,
							fk: rel.targets.length > 1 ? `${rel.fk}__${parent}` : rel.fk,
							parent,
							owned: rel.spec.owned === true,
							cascades: action === 'cascade' || action === 'setNull'
						}
					]
				: []
		);
	});
	if (edges.length > 0) {
		c.cte(
			'ap_edges',
			`SELECT * FROM jsonb_to_recordset(${c.p(edges)}::jsonb)
			AS edge(child text,fk text,parent text,owned boolean,cascades boolean)`
		);
		c.cte(
			'ap_extend',
			`UPDATE bolt_approvals a SET records = a.records || (
		WITH RECURSIVE reached(c,id) AS (
			SELECT entry.value->>'collection',entry.value->>'id' FROM jsonb_array_elements(a.records) AS entry(value)
			UNION
			SELECT x.c,x.id FROM ${source} x JOIN ap_edges edge ON edge.child=x.c
			JOIN reached parent ON parent.c=edge.parent AND (parent.id=x.o->>edge.fk OR parent.id=x.n->>edge.fk)
			WHERE NOT x.erased AND ((edge.owned AND x.cause IN ('direct','cascade')) OR (edge.cascades AND coalesce(x.cascaded,false)))
		)
		SELECT coalesce(jsonb_agg(${checkpoint('x')} ORDER BY x.c,x.id),'[]'::jsonb)
		FROM (SELECT DISTINCT ON (c,id) * FROM ${source} WHERE cause IN ('direct','cascade') AND NOT erased) x
		JOIN reached using(c,id) WHERE NOT ${held('a.records', 'x.c', 'x.id')})
	WHERE a.id IN (SELECT id FROM ap_hit WHERE eligible) AND ${GATED} RETURNING a.id`
		);
	}
	return 'ap_hit';
}

const Holder = Schema.Struct({
	id: Schema.String,
	eligible: Schema.Boolean,
	readGuarded: Schema.Boolean,
	state: Schema.Literals(['Pending', 'ChangesRequested']),
	/** The actor asked for it: their save on it in ChangesRequested resubmits it (approvals.ts `resubmit`). */
	requester: Schema.Boolean,
	collection: Schema.String,
	record: Schema.String,
	action: Schema.Literals(['create', 'update', 'delete'])
});
/**
 * The open requests holding any of `refs`, and whether `actor` may change them: a routed write on a held record joins
 * its request instead of opening one, a requester's save resubmits theirs, and record capabilities refuse the others'
 * edits up front.
 */
export const holders = Effect.fn('Approvals.holders')(function* (
	db: Pick<TenantDbShape, 'rows'>,
	refs: readonly (readonly [string, string])[],
	actor: EngineActor
) {
	if (refs.length === 0) return [];
	const { team, id } = own(actor);
	return yield* db.rows(Holder, {
		text: `SELECT a.id::text AS id, ${eligible('$2', '$3', '$4')} AS eligible, a.route ? '__boltReadGuards' AS "readGuarded", a.state, a.requestor = $4 AS requester,
		a.collection, a.record, a.action FROM bolt_approvals a
	WHERE a.state IN ('Pending', 'ChangesRequested')
		AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.records) r JOIN jsonb_to_recordset($1::jsonb) AS t(c text, id text)
			ON t.c = r ->> 'collection' AND t.id = r ->> 'id')`,
		params: [JSON.stringify(refs.map(([c, id]) => ({ c, id }))), team, id, actorRef(actor)]
	});
});

/** Relationship actions stay authored changes: a held child's checkpoint retains its root inverse through review. */
export const heldFields = Effect.fn('Approvals.heldFields')(function* (
	db: Pick<TenantDbShape, 'rows'>,
	m: EngineManifest,
	cat: Catalog,
	request: string
) {
	const edges = ownedEdges(m, cat);
	if (edges.length === 0) return [];
	const params: (string | null)[] = [request];
	const param = (value: string | null) => `$${params.push(value)}`;
	const links = edges.flatMap(([child, fk, parent]) => {
		const from = param(child),
			to = param(parent),
			column = param(fk),
			field = param(
				[...(cat.models.get(parent)?.many.values() ?? [])].find(
					(rel) => rel.child === child && rel.column === fk
				)?.name ?? null
			);
		const idType = cat.models.get(child)?.fields.get('id')?.pg ?? 'uuid';
		return [
			`SELECT ${to}::text AS collection, live.${q(fk)}::text AS id, ${field}::text AS field
				FROM ${q(child)} live WHERE reached.collection = ${from}::text
					AND live.id = (CASE WHEN reached.collection = ${from}::text THEN reached.id END)::${idType}`,
			`SELECT ${to}::text, old.parent_id, ${field}::text FROM entries entry
				CROSS JOIN LATERAL (SELECT h.changes ->> ${column}::text AS parent_id FROM bolt_history h
					WHERE h.collection = ${from}::text AND h.record = entry.id::uuid AND h.revision <= entry.before
						AND h.changes ? ${column}::text ORDER BY h.revision DESC LIMIT 1) old
				WHERE reached.collection = ${from}::text AND entry.collection = ${from}::text
					AND entry.id = reached.id AND entry.before IS NOT NULL`
		];
	});
	const rows = yield* db.rows(Schema.Struct({ field: Schema.String }), {
		text: `WITH RECURSIVE saved AS (SELECT collection, record, records FROM bolt_approvals WHERE id = $1::uuid),
		entries AS (SELECT entry.* FROM saved CROSS JOIN LATERAL
			jsonb_to_recordset(saved.records) AS entry(collection text, id text, before int)),
		reached(collection, id, field) AS (
			SELECT entry.collection, entry.id, null::text FROM entries entry, saved
				WHERE (entry.collection, entry.id) <> (saved.collection, saved.record)
			UNION
			SELECT link.collection, link.id, link.field FROM reached, saved
				CROSS JOIN LATERAL (${links.join(' UNION ALL ')}) link
				WHERE link.id IS NOT NULL AND (reached.collection, reached.id) <> (saved.collection, saved.record)
		)
		SELECT DISTINCT reached.field FROM reached, saved WHERE reached.collection = saved.collection
			AND reached.id = saved.record AND reached.field IS NOT NULL`,
		params
	});
	return rows.map((row) => row.field);
});

const approvables = new WeakMap<EngineManifest, ReadonlySet<string>>();
/** A grant with a write arm that admits subject to an approval flow (the manifest's `approval: true` marker). */
export const routesApproval = (g: GrantData) =>
	[g.create, g.update, g.delete].some(
		(arm) => typeof arm === 'object' && 'approval' in arm && arm.approval === true
	);
/** The collections a request can hold: those a grant routes to approval, and every collection nested under them. */
export const approvable = (m: EngineManifest, cat: Catalog): ReadonlySet<string> => {
	let set = approvables.get(m);
	if (set !== undefined) return set;
	const roots = Object.values(m.policies).flatMap((p) =>
		Object.entries(p.grants).flatMap(([c, g]) => (routesApproval(g) ? [c] : []))
	);
	const incoming = Map.groupBy(
		relations(m).all.flatMap((rel) =>
			rel.targets.flatMap((parent) =>
				cat.models.has(parent) &&
				cat.models.get(rel.from)?.one.get(rel.fk)?.targets.includes(parent) === true
					? [{ parent, child: rel.from }]
					: []
			)
		),
		(rel) => rel.parent
	);
	const out = new Set<string>();
	const visit = (c: string) => {
		if (out.has(c)) return;
		out.add(c);
		for (const rel of incoming.get(c) ?? []) visit(rel.child);
	};
	roots.forEach(visit);
	approvables.set(m, (set = out));
	return set;
};
const Held = Schema.Struct({
	requestId: Schema.String,
	state: Schema.Literals(['Pending', 'ChangesRequested']),
	step: Schema.Number,
	steps: Snapshot.fields.steps,
	by: Schema.String
});
const decodeHeld = Schema.decodeUnknownOption(Held);
/** `$approval` of a row from the raw request its read selected (query/sql.ts `root`): its named steps and who asked. */
export const rowApproval = (raw: unknown): RowApproval | undefined =>
	Option.match(decodeHeld(raw), {
		onNone: () => undefined,
		onSome: ({ by, ...r }) => ({ ...r, requestedBy: by })
	});

/**
 * The collections open requests hold, read once when the reads area starts: with today's routed collections they are
 * every collection a request can hold (a new request opens only where a current grant routes).
 */
export const heldCollections = (db: Pick<TenantDbShape, 'rows'>) =>
	db
		.rows(Schema.Struct({ c: Schema.String }), {
			text: `SELECT DISTINCT r ->> 'collection' AS c FROM bolt_approvals a CROSS JOIN LATERAL jsonb_array_elements(a.records) r
	WHERE a.state IN ('Pending', 'ChangesRequested')`,
			params: []
		})
		.pipe(
			Effect.map((rows) => new Set(rows.map((r) => r.c))),
			// a database not yet planned has no requests
			Effect.orElseSucceed(() => new Set<string>())
		);
