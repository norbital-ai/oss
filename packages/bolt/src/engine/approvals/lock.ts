// The approval lock (rule 46a): while a request is Pending or ChangesRequested, the records it holds — root, the inline
// children its provisional change touched, and any owned child created under a held record — change only through the
// request: the current step's approvers in Pending, the requester in ChangesRequested. Every write path ends in one
// commit statement (rule 20), so the lock is pieces of that statement; an approval decision's own rollback is exempt.
import { Effect, Option, Schema } from 'effect';
import type { EngineActor } from '../contracts.ts';
import { teams, type EngineManifest } from '../manifest.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { Catalog } from '../../protocol/catalog.ts';
import type { RowApproval } from '../../decl/names.ts';
import { GATED, type Chain } from '../write/sql.ts';
import { actorRef } from '../write/commit.ts';
/** `[child, fk, parent]` of every owned relationship. */
export const ownedEdges = (m: EngineManifest, cat: Catalog) =>
	[...cat.models.values()].flatMap((parent) =>
		[...parent.many.values()].flatMap((rel) =>
			m.relationships[`${rel.child}.${rel.column}`]?.owned
				? [[rel.child, rel.column, parent.name] as const]
				: []
		)
	);
/** The row images `source` touched (its direct and cascaded rows), plus the held parents of the owned children among them. */
const touched = (m: EngineManifest, cat: Catalog, c: Chain, source: string) => {
	const own = `cause IN ('direct', 'cascade') AND NOT erased`;
	return [
		`SELECT c, id FROM ${source} WHERE ${own}`,
		...ownedEdges(m, cat).map(
			([child, fk, parent]) =>
				`SELECT ${c.p(parent)}::text, coalesce(n, o) ->> ${c.p(fk)}::text FROM ${source} WHERE c = ${c.p(child)} AND ${own}`
		)
	].join(' UNION ');
};
/** A checkpoint entry for each row `x` of `source`: its revision before this statement (null: it did not exist). */
export const checkpoint = (x: string) =>
	`jsonb_build_object('collection', ${x}.c, 'id', ${x}.id, 'op', ${x}.op, 'before', CASE WHEN ${x}.op = 'create' THEN NULL ELSE ${x}.revision - 1 END)`;
const held = (records: string, c: string, id: string) =>
	`EXISTS (SELECT 1 FROM jsonb_array_elements(${records}) r WHERE r ->> 'collection' = ${c} AND r ->> 'id' = ${id})`;

/** The current step's approvers in Pending, the requester in ChangesRequested (alias `a`). */
const eligible = (team: string, ref: string) =>
	`coalesce((a.state = 'Pending' AND a.route -> 'steps' -> a.step ? ${team}::text)
			OR (a.state = 'ChangesRequested' AND a.requestor = ${ref}), false)`;

/**
 * The lock over `source` (the statement's `allp`): refuse any touched held record the actor may not change, and add the
 * owned children an eligible actor created or first touched to the request's checkpoint. Returns the hit requests' CTE.
 */
export function lockPieces(
	m: EngineManifest,
	cat: Catalog,
	c: Chain,
	actor: EngineActor,
	source: string
): string {
	const team = actor.kind === 'member' ? (actor.teams[0] ?? null) : null;
	c.cte('ap_touch', touched(m, cat, c, source));
	c.cte(
		'ap_hit',
		`SELECT a.id, a.state, a.step, a.route, a.requestor_user, a.records,
		${eligible(c.p(team), c.p(actorRef(actor)))} AS eligible
	FROM bolt_approvals a WHERE a.state IN ('Pending', 'ChangesRequested')
		AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.records) r JOIN ap_touch t ON t.c = r ->> 'collection' AND t.id = r ->> 'id')`
	);
	const names = c.p(
		Object.fromEntries(Object.entries(teams(m)).map(([handle, t]) => [handle, t.name ?? handle]))
	);
	c.assertWith(
		'NOT EXISTS (SELECT 1 FROM ap_hit WHERE NOT eligible)',
		'underApproval',
		`(SELECT h.id::text || ' Under approval: ' || CASE WHEN h.state = 'ChangesRequested'
			THEN coalesce(u.name, u.email, 'the requester')
			ELSE coalesce((SELECT string_agg(coalesce(${names}::jsonb ->> s, s), ' or ') FROM jsonb_array_elements_text(h.route -> 'steps' -> h.step) s), 'its approvers') END
			|| ' may change it.' FROM ap_hit h LEFT JOIN sys_user u ON u.id::text = h.requestor_user WHERE NOT h.eligible LIMIT 1)`
	);
	const edges = ownedEdges(m, cat);
	if (edges.length > 0)
		c.cte(
			'ap_extend',
			`UPDATE bolt_approvals a SET records = a.records || (SELECT coalesce(jsonb_agg(${checkpoint('x')}), '[]'::jsonb)
		FROM (SELECT DISTINCT ON (c, id) * FROM ${source} WHERE cause IN ('direct', 'cascade') AND NOT erased) x
		WHERE NOT ${held('a.records', 'x.c', 'x.id')} AND (${edges
			.map(
				([child, fk, parent]) =>
					`(x.c = ${c.p(child)} AND ${held('a.records', c.p(parent), `coalesce(x.n, x.o) ->> ${c.p(fk)}::text`)})`
			)
			.join(' OR ')}))
	WHERE a.id IN (SELECT id FROM ap_hit WHERE eligible) AND ${GATED} RETURNING a.id`
		);
	return 'ap_hit';
}

/**
 * The open requests holding any of `refs`, and whether `actor` may change them: a routed write on a held record joins
 * its request instead of opening one, and record capabilities refuse the others' edits up front.
 */
export const holders = Effect.fn('Approvals.holders')(function* (
	db: Pick<TenantDbShape, 'rows'>,
	refs: readonly (readonly [string, string])[],
	actor: EngineActor
) {
	if (refs.length === 0) return [];
	return yield* db.rows(Schema.Struct({ id: Schema.String, eligible: Schema.Boolean }), {
		text: `SELECT a.id::text AS id, ${eligible('$2', '$3')} AS eligible FROM bolt_approvals a
	WHERE a.state IN ('Pending', 'ChangesRequested')
		AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.records) r JOIN jsonb_to_recordset($1::jsonb) AS t(c text, id text)
			ON t.c = r ->> 'collection' AND t.id = r ->> 'id')`,
		params: [
			JSON.stringify(refs.map(([c, id]) => ({ c, id }))),
			actor.kind === 'member' ? (actor.teams[0] ?? null) : null,
			actorRef(actor)
		]
	});
});

const approvables = new WeakMap<EngineManifest, ReadonlySet<string>>();
/** The collections a request can hold: those a grant routes to approval, and every collection nested under them. */
export const approvable = (m: EngineManifest, cat: Catalog): ReadonlySet<string> => {
	let set = approvables.get(m);
	if (set !== undefined) return set;
	const roots = Object.values(m.policies).flatMap((p) =>
		Object.entries(p.grants).flatMap(([c, g]) => (g['approval'] === undefined ? [] : [c]))
	);
	const out = new Set<string>();
	const visit = (c: string) => {
		if (out.has(c)) return;
		out.add(c);
		for (const rel of cat.models.get(c)?.many.values() ?? []) visit(rel.child);
	};
	roots.forEach(visit);
	approvables.set(m, (set = out));
	return set;
};
const Held = Schema.Struct({
	requestId: Schema.String,
	state: Schema.Literals(['Pending', 'ChangesRequested']),
	step: Schema.Number,
	steps: Schema.Number,
	teams: Schema.Array(Schema.String),
	by: Schema.String
});
const decodeHeld = Schema.decodeUnknownOption(Held);
/** `$approval` of a row from the raw request its read selected (query/sql.ts `root`): the waiting teams by name. */
export const rowApproval = (m: EngineManifest) => {
	const names = teams(m);
	return (raw: unknown): RowApproval | undefined =>
		Option.match(decodeHeld(raw), {
			onNone: () => undefined,
			onSome: ({ teams: waiting, by, ...r }) => ({
				...r,
				requestedBy: by,
				waitingOn: r.state === 'ChangesRequested' ? [by] : waiting.map((t) => names[t]?.name ?? t)
			})
		});
};

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
