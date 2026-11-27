// Write admission and policy verdict evaluation: column-level grants, guest verdicts, probes, and submitted-change inputs.
import { Effect, Predicate, Schema } from 'effect';
import { canonical, type Catalog, type SelectIR } from '@norbital-ai/store';
import { MessageValues, message_text } from '../../decl/errors/refusal.ts';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { SYSTEM } from '../../system/index.ts';
import { PERSONAL_CONNECTIONS } from '../access/authority.ts';
import { catalog_of } from '../access/pred.ts';
import { holders, type Holder } from '../approvals/lock.ts';
import { Snapshot } from '../approvals/snapshot.ts';
import {
	LIMITS,
	type Authority,
	type Bindings,
	type Outcome,
	type RowData,
	type WriteArm
} from '../contracts.ts';
import { storedChanges } from '../db/stored.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import type { EngineError } from '../errors.ts';
import { layered } from '../manifest.ts';
import { layerPath, stateStamps, withDefaults, type Item } from './flatten.ts';
import { readRows, storedTrees, transformBridge, wireRows } from './rows.ts';
import {
	actionOf,
	changeDepth,
	descendantOf,
	guessed,
	guest_context,
	guest_port,
	guestFailure,
	holdRefs,
	jsonArray,
	k,
	missing_record,
	named,
	refused,
	treeSelect,
	writeTree,
	type Admitted,
	type CheckArm,
	type Judged,
	type Judgement,
	type Need,
	type PlanInput,
	type PreparedPlan,
	type Probe,
	type StepsSnapshot,
	type StoppedPlan,
	type WriteEngine
} from './shared.ts';
import { fingerprinting, type Fingerprint } from './sql.ts';

function suppliedChanges(cat: Catalog, item: Item, row: RowData | null): readonly string[] {
	const c = item.change;
	if ((c.op !== 'update' && c.op !== 'upsert') || row === null) return item.supplied;
	const values = c.op === 'update' ? c.set : c.values;
	const differences = storedChanges(cat, c.model, row, values);
	return item.supplied.filter(
		(field) => !Object.hasOwn(values, field) || Object.hasOwn(differences, field)
	);
}

const held = (auth: Authority) =>
	auth.policies.length === 0
		? 'you hold no policy'
		: `none of your policies (${auth.policies.join(', ')}) grants it`;
const forbidden = (need: Need | undefined, message: string): Outcome => ({
	kind: 'refused',
	code: 'forbidden',
	message,
	...need
});

/**
 * Before any guest code: every (path, column) the batch writes, and every child path it acts on, must be named
 * by one of the root's arms of that verb (a `with` child is written through its root's access point, never its own);
 * the arms naming all of them admit the batch.
 */
export function admit(
	cat: Catalog,
	auth: Authority,
	root: string,
	items: readonly Item[],
	pre: ReadonlyMap<string, RowData>
): Admitted | Outcome {
	const verbs = new Map<Json, Judged>();
	for (const item of items)
		if (item.parent === undefined)
			verbs.set(item.change.path[0] ?? null, actionOf(item.change, pre));
	const needs = new Map<Judged, Need[]>();
	for (const item of items) {
		const c = item.change,
			at = c.path[0] ?? null;
		const verb = verbs.get(at) ?? actionOf(c, pre);
		const list = needs.get(verb) ?? [];
		needs.set(verb, list);
		const need: Need = {
			path: layerPath(root, c.path),
			...(typeof at === 'number' ? { row: at } : {})
		};
		if (item.parent !== undefined) list.push(need);
		if (c.op === 'delete') continue;
		const many = cat.models.get(c.model)?.many;
		for (const field of suppliedChanges(cat, item, pre.get(k(c.model, named(c))) ?? null))
			if (field !== item.parent?.fk && many?.has(field) !== true) list.push({ ...need, field });
	}
	const out: { [verb in Judged]?: readonly CheckArm[] } = {};
	for (const [verb, list] of needs) {
		if (verb === 'delete') {
			const arms = auth.models[root]?.delete ?? [];
			if (arms.length === 0)
				return forbidden(list[0], `You may not delete ${root}: ${held(auth)}.`);
			out.delete = arms;
			continue;
		}
		const arms = auth.models[root]?.[verb] ?? [];
		const first = arms[0];
		if (first === undefined) return forbidden(list[0], `You may not ${verb} ${root}: ${held(auth)}.`);
		const covers = (arm: WriteArm, need: Need) =>
			need.field === undefined
				? Object.hasOwn(arm.columns, need.path)
				: (arm.columns[need.path]?.includes(need.field) ?? false);
		const outside = list.find((need) => !arms.some((arm) => covers(arm, need)));
		if (outside !== undefined)
			return forbidden(
				outside,
				outside.field === undefined
					? `You may not change ${outside.path}.`
					: `You may not write ${outside.field} of ${outside.path}.`
			);
		const admitting = arms.filter((arm) => list.every((need) => covers(arm, need)));
		if (admitting.length === 0)
			return forbidden(
				list.find((need) => !covers(first, need)),
				'No one policy admits this whole change; split it into smaller acts.'
			);
		if (verb === 'create' && root === 'sys_integration') {
			const actor = auth.actor;
			const personalOk =
				actor.kind === 'member' &&
				!actor.external &&
				items.every((item) => {
					const c = item.change;
					if (item.parent !== undefined || c.model !== 'sys_integration' || actionOf(c, pre) !== 'create')
						return true;
					const values = c.op === 'create' || c.op === 'upsert' ? c.values : {};
					return (
						values['owner'] === actor.id &&
						typeof values['integration'] === 'string' &&
						auth.capabilities.personal_connections.includes(values['integration'])
					);
				});
			if (!personalOk) {
				const remaining = admitting.filter((arm) => arm.policy !== PERSONAL_CONNECTIONS);
				if (remaining.length === 0)
					return forbidden(list[0], 'You may only connect your own allowed personal integrations.');
				out[verb] = remaining;
				continue;
			}
		}
		out[verb] = admitting;
	}
	return out;
}

const VerdictSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('allow') }),
	Schema.Struct({
		kind: Schema.Literal('refuse'),
		message: Schema.String,
		values: Schema.optionalKey(MessageValues),
		at: Schema.optionalKey(
			Schema.Struct({
				row: Schema.optionalKey(Schema.Number),
				field: Schema.optionalKey(Schema.String)
			})
		)
	}),
	Schema.Struct({ kind: Schema.Literal('approve'), flow: Snapshot })
]);

/**
 * The guest half: each admitting arm's `verdict` judges the verb's batch (invocation kind `policy`, workspace reads
 * within a transform's budget). Any `allow` executes, an arm without a verdict among them; else the first `approve` in
 * the team's policy order holds the batch for its flow; else the first `refuse` refuses it (its `row` indexes `input`).
 */
export const judge = Effect.fn('Bolt.judge')(function* (
	e: Pick<WriteEngine, 'manifest' | 'guest' | 'bridge'>,
	db: TenantDb,
	auth: Authority,
	b: Bindings,
	seed: string,
	model: string,
	verb: Judged,
	arms: readonly CheckArm[],
	input: readonly Json[],
	reads?: { readonly tables: Set<string>; readonly fingerprints: Fingerprint[] }
): Effect.fn.Return<{ guest: boolean; verdict: Judgement }, EngineError> {
	if (arms.length === 0)
		return {
			guest: false,
			verdict: { kind: 'refuse', outcome: refused('forbidden', 'You may not make this change.') }
		};
	if (arms.some((arm) => !arm.check)) return { guest: false, verdict: { kind: 'allow' } };
	const port = yield* guest_port(e.guest);
	let approve: Judgement | undefined, refusal: Judgement | undefined;
	const targets = arms.map((arm) => `${arm.policy}.${model}.${verb}`);
	const invocation = {
		id: `${seed}:policy:${model}.${verb}`,
		kind: 'policy' as const,
		ctx: { ...guest_context(auth.actor, b, seed), policies: auth.policies },
		budget: {
			crossings: LIMITS.crossings.write * arms.length,
			readBytes: LIMITS.readBytes * arms.length
		}
	};
	const bridge =
		e.bridge?.({ ...invocation, target: targets.join(' '), input }, db) ??
		transformBridge(e.manifest, db, { ...invocation, target: targets.join(' '), input });
	const outcomes = yield* port.invokeEach(
		invocation,
		targets.map((target) => ({ target, input })),
		bridge
	);
	for (const table of bridge.tables?.() ?? []) reads?.tables.add(table);
	reads?.fingerprints.push(...(bridge.fingerprints?.() ?? []));
	for (const [index, target] of targets.entries()) {
		const g = outcomes[index];
		if (g === undefined)
			return yield* BoltError.make('bad_answer', 'guest', `${target}: the guest answered no verdict.`);
		if (g.kind === 'failed')
			return { guest: true, verdict: { kind: 'refuse', outcome: yield* guestFailure(g.error) } };
		if (g.kind === 'refused')
			return {
				guest: true,
				verdict: {
					kind: 'refuse',
					outcome: {
						kind: 'refused',
						code: 'refused',
						message: g.message,
						...(g.key === undefined ? {} : { key: g.key }),
						...(g.values === undefined ? {} : { values: g.values }),
						rule: target
					}
				}
			};
		const data = yield* Schema.decodeUnknownEffect(VerdictSchema)(g.output).pipe(
			Effect.mapError((error) =>
				BoltError.make('bad_answer', 'guest', `${target}: ${error.message}`, error)
			)
		);
		if (data.kind === 'allow') return { guest: true, verdict: { kind: 'allow' } };
		if (data.kind === 'approve') approve ??= { kind: 'approve', flow: data.flow };
		else
			refusal ??= {
				kind: 'refuse',
				outcome: {
					kind: 'refused',
					code: 'refused',
					message: message_text(e.manifest.messages, data.message, data.values),
					key: data.message,
					...(data.values === undefined ? {} : { values: data.values }),
					rule: target,
					...data.at
				}
			};
	}
	return {
		guest: true,
		verdict:
			approve ??
			refusal ?? { kind: 'refuse', outcome: refused('forbidden', 'You may not make this change.') }
	};
});

/** One `holders` read per plan in the usual act: a ref asked again is answered from the requests already found. */
export const heldBy = (db: TenantDb, actor: Authority['actor']): PlanInput['held'] => {
	const asked = new Set<string>(),
		found = new Map<string, Holder>();
	return Effect.fnUntraced(function* (refs: readonly (readonly [string, string])[]) {
		const fresh = [
			...new Map(
				refs.filter(([c, id]) => !asked.has(k(c, id))).map((ref) => [k(...ref), ref])
			).values()
		];
		for (const [c, id] of fresh) asked.add(k(c, id));
		for (const h of yield* holders(db, fresh, actor)) {
			const known = found.get(h.id);
			found.set(h.id, known === undefined ? h : { ...known, refs: [...known.refs, ...h.refs] });
		}
		const wanted = new Set(refs.map(([c, id]) => k(c, id)));
		return [...found.values()].filter((h) => h.refs.some(([c, id]) => wanted.has(k(c, id))));
	});
};

const payloadFor = (items: readonly Item[], pre: ReadonlyMap<string, RowData>) => {
	const children = new Map<string, Item[]>();
	for (const item of items) {
		const parent = item.parent;
		if (parent === undefined) continue;
		const key = k(parent.model, parent.id),
			list = children.get(key) ?? [];
		list.push(item);
		children.set(key, list);
	}
	const payload = (item: Item, nested = false): RowData => {
		const c = item.change;
		if (c.op === 'delete') return {};
		const values: Record<string, Json> = { ...(c.op === 'update' ? c.set : c.values) };
		if (nested && item.parent !== undefined && c.op !== 'update') delete values[item.parent.fk];
		for (const child of (children.get(k(c.model, c.id)) ?? []).filter(
			(one) => changeDepth(one) === changeDepth(item) + 1 && descendantOf(one, item)
		)) {
			const parent = child.parent;
			if (parent === undefined) continue;
			const rel = parent.rel;
			const action = child.change.path.findLast(
				(part) =>
					typeof part === 'string' &&
					['create', 'update', 'upsert', 'delete', 'link', 'unlink'].includes(part)
			);
			if (typeof action !== 'string') continue;
			const sub = payload(child, true);
			const revision =
				child.change.op === 'update' || child.change.op === 'delete'
					? (child.change.revision ?? pre.get(k(child.change.model, child.change.id))?.['revision'])
					: undefined;
			const target = {
				id: child.change.id,
				...(typeof revision === 'number' ? { revision } : {})
			};
			const entry: Json =
				action === 'update'
					? { target, set: sub }
					: action === 'upsert'
						? { id: child.change.id, ...sub }
						: ['delete', 'link', 'unlink'].includes(action)
							? target
							: sub;
			if (actionOf(c, pre) === 'create') {
				const existing = values[rel];
				values[rel] = [...(jsonArray(existing) ? existing : []), entry];
				continue;
			}
			const group: { [key: string]: Json } = Predicate.isObject(values[rel])
				? { ...values[rel] }
				: {};
			const existing = group[action];
			group[action] = [...(jsonArray(existing) ? existing : []), entry];
			values[rel] = group;
		}
		return values;
	};
	return payload;
};

/** Verdicts and transforms see the same proposed rows, including actual child lists rather than relation commands. */
export const changeInputs = Effect.fn('Bolt.changeInputs')(function* (
	context: PlanInput,
	model: string,
	verb: Judged,
	roots: readonly Item[],
	items: readonly Item[],
	reads: Pick<PreparedPlan, 'readTables' | 'fingerprints'>
): Effect.fn.Return<{ input: Json[]; missing?: Item }, EngineError> {
	const { e, r, own, pre, cat } = context,
		m = e.manifest;
	const recorded = fingerprinting(own);
	const paths = new Set(
		verb === 'delete' ? [] : Object.keys(m.exposures[model]?.[verb]?.columns ?? {})
	);
	const entries = roots.flatMap((root) =>
		[root, ...items.filter((item) => descendantOf(item, root))].map((item) => ({
			item,
			path: layerPath(model, item.change.path.slice(root.change.path.length))
		}))
	);
	for (const entry of entries) paths.add(entry.path);
	const childrenByParent = Map.groupBy(
		entries.filter(({ item }) => item.parent !== undefined),
		({ item, path }) => canonical([item.parent?.model, item.parent?.id, item.parent?.rel, path])
	);
	const stored = new Map<Item, RowData | null>();
	for (const group of Map.groupBy(entries, ({ item, path }) =>
		canonical([item.change.model, path])
	).values()) {
		const first = group[0];
		if (first === undefined) continue;
		const ids = group.map(({ item }) =>
			actionOf(item.change, pre) === 'create' ? null : named(item.change)
		);
		const select = treeSelect(cat, [...paths], first.path, first.item.change.model);
		const remember = (table: string, tree: SelectIR): void => {
			reads.readTables.add(table);
			for (const relation of Object.values(tree.relations)) remember(relation.target, relation.select);
		};
		remember(first.item.change.model, select);
		const rows = yield* wireRows(recorded.db, cat, first.item.change.model, ids, r.bindings, select);
		for (const [index, entry] of group.entries()) {
			const before = rows[index] ?? null;
			if (ids[index] !== null && before === null) return { input: [], missing: entry.item };
			stored.set(entry.item, before);
		}
	}
	reads.fingerprints.push(...recorded.fingerprints());
	const payload = payloadFor(items, pre);
	const setOf = (item: Item): RowData => {
		const values = payload(item);
		if (item.change.op !== 'upsert') return values;
		const { id: _id, ...rest } = values;
		return rest;
	};
	const proposed = (item: Item, path: string): RowData | null => {
		const c = item.change,
			action = actionOf(c, pre),
			before = stored.get(item) ?? null;
		if (c.op === 'delete') return null;
		if (c.op === 'upsert' && c.on_conflict === 'keep' && before !== null) return before;
		const values = c.op === 'update' ? c.set : c.values;
		const after: Record<string, Json> = {
			...before,
			...(action === 'update' ? storedChanges(cat, c.model, before ?? {}, values) : values),
			id: named(c)
		};
		for (const field of cat.models.get(c.model)?.fields.values() ?? [])
			if (field.computed || field.derived || field.kind === 'sum' || field.kind === 'count')
				delete after[field.name];
		if (action === 'create') {
			const missing = withDefaults(m, cat, c.model, after, r.authority.actor, r.bindings);
			if (missing instanceof BoltError) throw missing;
		} else Object.assign(after, stateStamps(m, c.model, values, before ?? undefined, r.bindings.now));
		for (const [rel, edge] of cat.models.get(c.model)?.many ?? []) {
			const childPath = `${path}.${rel}`;
			if (!paths.has(childPath) && ![...paths].some((name) => name.startsWith(`${childPath}.`)))
				continue;
			const previous = before?.[rel];
			const children = new Map<string, Json>();
			if (before !== null && !jsonArray(previous))
				throw BoltError.make('internal', 'decode', `The stored tree is missing ${childPath}.`);
			for (const row of jsonArray(previous) ? previous : []) {
				if (!Predicate.isObject(row) || typeof row['id'] !== 'string')
					throw BoltError.make('internal', 'decode', `The stored tree has an invalid ${childPath} row.`);
				children.set(row['id'], row);
			}
			for (const entry of childrenByParent.get(canonical([c.model, named(c), rel, childPath])) ?? []) {
				const child = entry.item,
					parent = child.parent;
				if (
					entry.path !== childPath ||
					parent?.model !== c.model ||
					parent.id !== named(c) ||
					parent.rel !== rel ||
					!descendantOf(child, item)
				)
					continue;
				const change = child.change;
				const next =
					change.op === 'delete'
						? null
						: change.op === 'update'
							? change.set[edge.column]
							: change.values[edge.column];
				if (change.op === 'delete' || (next !== undefined && next !== named(c)))
					children.delete(named(change));
				else {
					const row = proposed(child, childPath);
					if (row !== null) children.set(named(change), row);
				}
			}
			after[rel] = [...children.values()];
		}
		return after;
	};
	return yield* Effect.try({
		try: () => ({
			input: roots.map((item) => ({
				before:
					actionOf(item.change, pre) === 'create'
						? null
						: writeTree(cat, model, stored.get(item) ?? null),
				set: item.change.op === 'delete' ? {} : setOf(item),
				after: writeTree(cat, model, proposed(item, model))
			}))
		}),
		catch: (error) =>
			error instanceof BoltError ? error : BoltError.make('internal', 'decode', String(error))
	});
});

export const judgeSubmitted = Effect.fn('Bolt.judgeSubmitted')(function* (
	context: PlanInput,
	items: readonly Item[],
	reads: Pick<PreparedPlan, 'readTables' | 'fingerprints'>
): Effect.fn.Return<
	{ guest: boolean; flow: StepsSnapshot | undefined } | StoppedPlan,
	EngineError
> {
	const { e, r, pre, own, admitted, cat } = context;
	const m = e.manifest,
		auth = r.authority,
		b = r.bindings;
	const { readTables, fingerprints } = reads;
	let guest = false,
		flow: StepsSnapshot | undefined;
	if (admitted !== undefined) {
		const checked = Object.values(admitted).some((arms) => arms?.some((arm) => arm.check) === true);
		const saving = new Set(
			(checked ? yield* context.held(holdRefs(m, cat, pre, guessed(items, pre))) : [])
				.filter((request) => request.state === 'ChangesRequested' && request.requester)
				.map((request) => k(request.model, request.record))
		);
		for (const verb of ['create', 'update', 'delete'] as const) {
			const arms = admitted[verb],
				roots = items.filter(
					(item) =>
						item.parent === undefined &&
						actionOf(item.change, pre) === verb &&
						!saving.has(k(item.change.model, named(item.change)))
				);
			if (arms === undefined || roots.length === 0) continue;
			const { input, missing } = yield* changeInputs(context, r.model, verb, roots, items, reads);
			if (missing !== undefined) return { guest, outcome: missing_record(missing.change.path) };
			const judged = yield* judge(
				e,
				own,
				auth,
				b,
				`${r.invocationId}:${r.model}:${verb}`,
				r.model,
				verb,
				arms,
				input,
				{ tables: readTables, fingerprints }
			);
			guest ||= judged.guest;
			const verdict = judged.verdict;
			if (verdict.kind === 'refuse') {
				const o = verdict.outcome;
				if (o.kind !== 'refused' || o.row === undefined) return { guest, outcome: o };
				const { row, ...rest } = o;
				const at = roots[row]?.change.path[0];
				return { guest, outcome: typeof at === 'number' ? { ...rest, row: at } : rest };
			}
			if (verdict.kind === 'approve') {
				if (flow !== undefined && canonical(flow) !== canonical(verdict.flow))
					return {
						guest,
						outcome: refused(
							'approval_split',
							'The rows in one act require different approval flows.'
						)
					};
				flow = verdict.flow;
			}
		}
	}
	return { guest, flow };
});

/**
 * What a write's verdict answers for unchanged stored records: the same before/set/after envelope as an act, every row
 * read at once and judged in one verdict. Without a guest no verdict can run, so a guarded verb reads as denied (the
 * act judges for real); a missing row is denied.
 */
export const opened = Effect.fn('Bolt.opened')(function* (
	e: Probe,
	authority: Authority,
	bindings: Bindings,
	model: string,
	verb: 'update' | 'delete',
	ids: readonly string[]
): Effect.fn.Return<Judgement['kind'], EngineError> {
	if (authority.admin) return 'allow';
	const arms = authority.models[model]?.[verb] ?? [];
	if (arms.length === 0) return 'refuse';
	const cat = catalog_of(e.manifest);
	const writeScope = { authority, verb } as const;
	if (arms.some((arm) => !arm.check)) {
		const allowed = yield* wireRows(
			e.db,
			cat,
			model,
			ids,
			bindings,
			{ fields: ['id'], relations: {} },
			writeScope
		);
		return allowed.every((row) => row !== null) ? 'allow' : 'refuse';
	}
	if (e.guest === undefined) return 'refuse';
	const before =
		verb === 'update'
			? yield* storedTrees(e.db, e.manifest, cat, model, ids, bindings, undefined, writeScope)
			: yield* wireRows(e.db, cat, model, ids, bindings, undefined, writeScope);
	const rows = before.filter((row) => row !== null);
	if (rows.length !== ids.length) return 'refuse';
	const { verdict } = yield* judge(
		e,
		e.db,
		authority,
		bindings,
		`open:${model}:${ids.join(',')}`,
		model,
		verb,
		arms,
		rows.map((row) => ({ before: row, set: {}, after: verb === 'update' ? row : null }))
	);
	return verdict.kind;
});

/**
 * Whether deleting `ids` of `model` would commit (`allow`), be held for approval (`approve`) or be refused (`refuse`): the
 * delete's admission over every row in one read and one verdict, as the act judges them together.
 */
export const delete_verdict = Effect.fn('Bolt.deleteVerdict')(function* (
	e: Probe,
	model: string,
	ids: readonly string[],
	authority: Authority,
	bindings: Bindings
) {
	const m = Object.hasOwn(SYSTEM.exposures, model) ? layered(e.manifest) : e.manifest;
	if (m.exposures[model]?.delete === undefined || ids.length === 0) return 'refuse' as const;
	return yield* opened({ ...e, manifest: m }, authority, bindings, model, 'delete', [
		...new Set(ids)
	]);
});

/**
 * Whether `authority` may update the row at all (its update checks allow it unchanged, or the admin bypass), and `null`
 * when there is no such row. A host verb on a row (an integration instance's pair, unpair, test) authorizes so.
 */
export const mayUpdate = Effect.fn('Bolt.mayUpdate')(function* (
	e: Probe,
	model: string,
	id: string,
	authority: Authority,
	bindings: Bindings
) {
	const m = Object.hasOwn(SYSTEM.exposures, model) ? layered(e.manifest) : e.manifest;
	const pre = yield* readRows(e.db, catalog_of(m), [[model, id]]);
	if (!pre.has(k(model, id))) return null;
	return (
		(yield* opened({ ...e, manifest: m }, authority, bindings, model, 'update', [id])) === 'allow'
	);
});
