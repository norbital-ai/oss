// The act planner, in rule order: decode → the records named and the columns admitted per write path → observed-revision
// checks → the policies' checks on the submitted trees → batched per-verb callbacks → defaults and model rules → the
// approval route → the planned commit, which `Callables.acts` commits in one statement.
import { Effect, Predicate, Schema } from 'effect';
import { type Catalog } from '@norbital-ai/store';
import { UUID_PATTERN } from '@norbital-ai/store/kind';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { SYSTEM } from '../../system/index.ts';
import { admitMove } from '../access/authority.ts';
import { catalog_of } from '../access/pred.ts';
import { LIMITS, utf8Bytes, type Outcome, type RowData } from '../contracts.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { writableFile } from '../decision.ts';
import { cyclic, teamGraph } from '../identity/graph.ts';
import { membershipModels, membershipWriter } from '../identity/teams.ts';
import type { EngineError } from '../errors.ts';
import { embedQueued, embedWrites } from '../integrations/embed.ts';
import { layered } from '../manifest.ts';
import { coalescing, memo_reads } from '../query/engine.ts';
import { writerOf } from '../runs/queue.ts';
import type { ActRequest, PlannedCommit } from '../services.ts';
import { admit, heldBy } from './admit.ts';
import { erase } from './erase.ts';
import { Flattener, layerSel, modelKey, type Item, type Sel } from './flatten.ts';
import { importPlan, importRefs, type ImportPlan } from './import.ts';
import { prepareChanges } from './prepare.ts';
import { routeChanges } from './route.ts';
import { readableBy, readRows, resolveUpserts, writableBy } from './rows.ts';
import {
	actionOf,
	carried,
	jsonArray,
	k,
	missing_record,
	named,
	refused,
	stateField,
	syncOwnership,
	type Admitted,
	type PlanInput,
	type Planned,
	type ReadVisibility,
	type StoppedPlan,
	type Taker,
	type WriteEngine
} from './shared.ts';
import { minter, type Fingerprint } from './sql.ts';
import { indexChanges, materializeChanges } from './validate.ts';

export type { ActRequest } from '../services.ts';
export {
	answerOf,
	guestFailure,
	hasCallback,
	k,
	refused,
	stateField,
	treeSelect,
	writeTree,
	type Admitted,
	type ApprovalHook,
	type CarriedWrite,
	type HeldRecord,
	type Need,
	type Probe,
	type StepsSnapshot,
	type Taker,
	type Verb,
	type WriteEngine
} from './shared.ts';
export { dry_run, readRows, storedTrees, transformBridge, wireRows } from './rows.ts';
export { delete_verdict, judge, mayUpdate, opened } from './admit.ts';
export { pureVectors } from './validate.ts';

const Rows = Schema.Array(Schema.Json);

/**
 * Plans one act (a generated verb) into its mode's sink, or answers the outcome that stops it. `Callables.acts` commits
 * what it plans, so a verb answers alike whoever calls it.
 */
export const act = Effect.fn('Bolt.act')(function* (e: WriteEngine, r: ActRequest) {
	let took = false;
	const take: Taker = (severity, event, attributes) =>
		Effect.gen(function* () {
			took = true;
			if (e.log === undefined) return;
			yield* e.log.emit(severity, event, { callable: `${r.model}.${r.verb}`, ...attributes });
		});
	const o = yield* r.verb === 'erase' ? erase(e, r, take) : pipeline(e, r, take);
	if (!took && e.log !== undefined && (o.kind === 'refused' || o.kind === 'conflict')) {
		yield* e.log.emit('warn', 'act.refused', {
			callable: `${r.model}.${r.verb}`,
			code: o.kind === 'refused' ? o.code : 'conflict'
		});
	}
	return o;
});

const pipeline = Effect.fn('Bolt.pipeline')(function* (
	engine: WriteEngine,
	r: ActRequest,
	_take: Taker
) {
	const e = {
		...engine,
		...(Object.hasOwn(SYSTEM.exposures, r.model) ? { manifest: layered(engine.manifest) } : {})
	};
	const m = e.manifest,
		cat = catalog_of(m),
		b = r.bindings;
	const { sync, sink, pending } = r.mode;
	const auth = r.authority;
	const none = (outcome: Outcome): Outcome => outcome;
	const spec = m.exposures[r.model];
	if (spec === undefined)
		return yield* Effect.fail(
			BoltError.make('unknown_model', 'decode', `unknown model '${r.model}'`)
		);
	const sel: Sel | undefined = sync
		? { columns: sync.fields }
		: r.verb === 'update'
			? spec.update && layerSel(m, cat, spec.update.columns, 'update', r.model)
			: r.verb === 'delete'
				? spec.delete && { columns: [] }
				: spec.create && layerSel(m, cat, spec.create.columns, 'create', r.model);
	const key0 = modelKey(m, r.model);
	const byId = r.verb === 'upsert';
	if (
		sel === undefined ||
		(r.verb === 'upsert' &&
			(r.on_conflict === undefined ||
				(byId ? sync === undefined && spec.update === undefined : key0.length === 0))) ||
		(r.verb === 'import' && key0.length === 0)
	)
		return none(refused('forbidden', `${r.model} does not accept ${r.verb}.`));
	let imp: ImportPlan | undefined;
	if (r.verb === 'import') {
		if (
			!auth.admin &&
			(auth.models[r.model]?.create.length ?? 0) === 0 &&
			(auth.models[r.model]?.update.length ?? 0) === 0
		)
			return none(refused('forbidden', 'You may not make this change.'));
		const planned = yield* importPlan(m, r.model, r.input, key0);
		if ('kind' in planned) return none(planned);
		const refs = yield* importRefs(e.db, m, cat, r.model, planned.rows, auth, b);
		if ('kind' in refs) return none(refs);
		imp = { ...planned, rows: refs };
	}
	const mint = minter(r.invocationId, b.now);
	const f = new Flattener(m, cat, mint);
	const inputs = imp?.rows ?? (Schema.is(Rows)(r.input) ? r.input : undefined);
	if (inputs === undefined)
		return none(refused('invalid_input', `${r.model}.${r.verb} takes an array of rows.`));
	let inputBytes = 2;
	for (const [index, input] of inputs.entries()) {
		inputBytes += utf8Bytes(JSON.stringify(input)) + (index === 0 ? 0 : 1);
		if (inputBytes > LIMITS.act.inputBytes)
			return none(
				refused(
					'overflow',
					`An act writes at most ${LIMITS.act.inputBytes / 1_048_576} MiB of input; split the work into smaller acts.`
				)
			);
	}
	if (inputs.length > LIMITS.act.rows)
		return none(
			refused(
				'overflow',
				`An act writes at most ${LIMITS.act.rows} rows; split the work into smaller acts.`
			)
		);
	if (byId) {
		const invalid = inputs.findIndex((x) => !Predicate.isObject(x));
		if (invalid >= 0) return none(refused('invalid_input', 'Expected an object.', [invalid]));
		const badId = inputs.findIndex(
			(x) => Predicate.isObject(x) && x['id'] !== undefined && typeof x['id'] !== 'string'
		);
		if (badId >= 0) return none(refused('invalid_input', 'Expected an id.', [badId, 'id']));
	}
	const upserted: (string | null)[] = [];
	const onFile = byId
		? yield* readRows(
				e.db,
				cat,
				inputs.flatMap((x) =>
					Predicate.isObject(x) && typeof x['id'] === 'string'
						? [[r.model, x['id']] as const]
						: []
				)
			)
		: new Map<string, RowData>();
	const missing = byId
		? inputs.findIndex(
				(x) =>
					Predicate.isObject(x) && x['id'] !== undefined && !onFile.has(k(r.model, String(x['id'])))
			)
		: -1;
	if (missing >= 0 && sync === undefined)
		return none(refused('not_found', `No ${r.model} has this id.`, [missing, 'id']));
	inputs.forEach((x, i) => {
		const path = [i];
		if (
			r.verb === 'create' &&
			Predicate.isReadonlyObject(x) &&
			!Array.isArray(x) &&
			x['id'] !== undefined
		) {
			const { id, ...row } = x;
			if (typeof id === 'string' && UUID_PATTERN.test(id))
				f.create(r.model, sel, row, path, undefined, undefined, id);
			else
				f.problems.push({
					path: [...path, 'id'],
					message: 'a created row names a uuid it minted (new_id)'
				});
		} else if (r.verb === 'create' || (imp !== undefined && imp.on_conflict === undefined))
			f.create(r.model, sel, x, path);
		else if (imp !== undefined)
			f.create(r.model, sel, x, path, undefined, {
				on: key0,
				on_conflict: imp.on_conflict === 'update' ? 'update' : 'keep'
			});
		else if (byId && r.on_conflict !== undefined && Predicate.isReadonlyObject(x) && !Array.isArray(x)) {
			const { id, ...row } = x;
			if (typeof id !== 'string') {
				const at = f.items.length;
				f.create(
					r.model,
					sel,
					row,
					path,
					undefined,
					key0.length === 0 ? undefined : { on: key0, on_conflict: r.on_conflict }
				);
				upserted.push(f.items[at]?.change.id ?? null);
			} else {
				upserted.push(id);
				if (sync !== undefined && !onFile.has(k(r.model, id)))
					f.create(r.model, sel, row, path, undefined, undefined, id);
				else if (r.on_conflict === 'update')
					f.update(
						r.model,
						sync === undefined && spec.update !== undefined
							? layerSel(m, cat, spec.update.columns, 'update', r.model)
							: sel,
						id,
						row,
						r.observed?.[id] ?? null,
						path
					);
			}
		} else {
			if (!Predicate.isObject(x)) {
				f.problems.push({ path, message: 'expected an object' });
				return;
			}
			const target = x['target'];
			const observed = r.observed?.[String(target)] ?? null;
			if (r.verb === 'update') f.update(r.model, sel, target, x['set'], observed, path);
			else f.delete(r.model, target, observed, path);
		}
	});
	sync?.deletes.forEach((id, i) => f.delete(r.model, id, null, ['deletes', i]));
	const [first] = f.problems;
	if (first !== undefined) {
		return none(
			refused(
				'invalid_input',
				f.problems.map((p) => `${p.path.join('.') || 'input'}: ${p.message}`).join('; '),
				first.path
			)
		);
	}
	if (m.workspace.memberships && !membershipWriter(auth.actor, auth.admin)) {
		const protectedModels = membershipModels(m.workspace);
		const touched = f.items.find((item) => protectedModels.includes(item.change.model));
		if (touched)
			return none(
				refused(
					'forbidden',
					'Only an administrator or a membership automation can change grants.',
					touched.change.path
				)
			);
	}
	const teams = f.items.filter((item) => item.change.model === 'sys_team');
	const [team] = teams;
	if (team !== undefined) {
		if (!auth.admin)
			return none(refused('forbidden', 'Only an administrator can change teams.', team.change.path));
		// ponytail: the remembered graph; a cycle closed from two activations at once passes, and every walk of the graph ends on one
		const parents = new Map(Object.entries((yield* teamGraph(e.db)).teams).map(([id, t]) => [id, t.parent]));
		for (const { change: c } of teams) {
			const parent = c.op === 'delete' ? undefined : (c.op === 'update' ? c.set : c.values)['parent'];
			if (typeof parent === 'string' || parent === null) parents.set(named(c), parent);
		}
		const looped = teams.find(({ change: c }) => c.op !== 'delete' && cyclic((id) => parents.get(id), named(c)));
		if (looped !== undefined)
			return none(refused('invalid_input', 'A team cannot sit under itself.', [...looped.change.path, 'parent']));
	}
	const owned = syncOwnership(m, r, f.items);
	if (owned !== null) return none(owned);
	if (f.items.length > LIMITS.changesPerAct)
		return none(refused('overflow', `An act writes at most ${LIMITS.changesPerAct} rows.`));
	const own = yield* memo_reads(yield* coalescing(e.db));
	const matching = f.items.some((item) => item.change.op === 'upsert')
		? resolveUpserts(
				own,
				m,
				f.items.filter((i) => i.change.op === 'upsert')
			)
		: Effect.succeed(new Map<Item, RowData>());
	const [matched, pruneIds] = yield* Effect.all(
		[matching, imp?.prune === undefined ? Effect.succeed([]) : imp.prune(own, auth, b, f.items)],
		{ concurrency: 'unbounded' }
	);
	if (imp?.prune !== undefined) {
		const ids = pruneIds;
		if (!Array.isArray(ids)) return none(ids);
		for (const id of ids) f.delete(r.model, id, null, ['prune']);
	}
	const visibility = new Map<string, boolean>();
	const writable = new Map<string, boolean>();
	const scope: ReadVisibility = {
		authority: auth,
		bindings: b,
		visibility,
		writable,
		fingerprints: []
	};
	const pre = yield* readRows(
		own,
		cat,
		[
			...f.items
				.filter((i) => i.change.op === 'update' || i.change.op === 'delete')
				.map((i) => [i.change.model, i.change.id] as const),
			...f.items.flatMap((i) =>
				i.change.op === 'upsert' &&
				i.change.on.length === 1 &&
				i.change.on[0] === 'id' &&
				typeof i.change.values['id'] === 'string'
					? [[i.change.model, i.change.values['id']] as const]
					: []
			),
			...[...matched].map(([item, row]) => [item.change.model, String(row['id'])] as const),
			...(r.on_conflict === 'keep'
				? [...onFile.values()].map((row) => [r.model, String(row['id'])] as const)
				: []),
			...f.items.flatMap((i) => i.refs.map((x) => [x.to, x.id] as const))
		],
		scope
	);
	for (const [item, row] of matched) {
		const id = String(row['id']);
		pre.set(k(item.change.model, id), row);
		if (byId && item.change.model === r.model && item.parent === undefined) {
			const index = typeof item.change.path[0] === 'number' ? item.change.path[0] : 0;
			upserted[index] = id;
			onFile.set(k(r.model, id), row);
		}
		if (item.change.op === 'upsert') {
			const previous = item.change.id;
			item.change.id = id;
			for (const child of f.items)
				if (child.parent?.model === item.change.model && child.parent.id === previous) {
					child.parent = { ...child.parent, id };
					if (child.change.op !== 'delete')
						child.change =
							child.change.op === 'update'
								? { ...child.change, set: { ...child.change.set, [child.parent.fk]: id } }
								: { ...child.change, values: { ...child.change.values, [child.parent.fk]: id } };
				}
		}
	}
	for (const [key, row] of pending ?? [])
		if (!pre.has(key)) {
			pre.set(key, row);
			visibility.set(key, true);
			for (const verb of ['update', 'delete'] as const) writable.set(k(verb, key), true);
		}
	const readable = (c: string, row: RowData) => readableBy(auth, c, row, visibility);
	if (byId && r.on_conflict === 'keep')
		for (const id of upserted) {
			if (id === null) continue;
			const row = onFile.get(k(r.model, id));
			if (row === undefined) continue;
			if (!readable(r.model, row)) return none(missing_record());
			if (!auth.admin && (auth.models[r.model]?.update.length ?? 0) === 0)
				return none(refused('forbidden', 'You may not make this change.'));
		}
	for (const it of f.items) {
		const c = it.change;
		const row = pre.get(k(c.model, named(c)));
		const nested = it.parent !== undefined;
		const verb =
			c.op === 'delete' ? 'delete' : actionOf(c, pre) === 'update' ? 'update' : undefined;
		if (verb !== undefined) {
			if (row === undefined || (!nested && !readable(c.model, row)))
				return none(missing_record(c.path));
			if (
				!nested &&
				(auth.models[c.model]?.[verb].length ?? 0) > 0 &&
				!writableBy(auth, verb, c.model, row, writable)
			)
				return none(refused('forbidden', 'You may not change this record.', c.path));
			if (it.belongs === 'parent' && (it.parent === undefined || row[it.parent.fk] !== it.parent.id))
				return none(refused('not_found', 'The record does not belong here.', c.path));
		}
		for (const ref of it.refs) {
			const target = pre.get(k(ref.to, ref.id));
			if (target === undefined || !readable(ref.to, target))
				return none(
					refused(
						'not_found',
						`No readable ${ref.to} has this id: whoever writes this link must be able to read it.`,
						[...c.path, ref.field]
					)
				);
		}
		const state = stateField(m, c.model);
		const next = c.op === 'update' ? c.set[state ?? ''] : undefined;
		if (
			!auth.admin &&
			!nested &&
			state !== undefined &&
			typeof next === 'string' &&
			row !== undefined &&
			!admitMove(auth, c.model, state, String(row[state]), next)
		)
			return none(
				refused('forbidden', `You may not move ${state} to '${next}'.`, [...c.path, state])
			);
	}
	const admitted = auth.admin ? undefined : admit(cat, auth, r.model, f.items, pre);
	if (admitted !== undefined && 'kind' in admitted) return none(admitted);
	if (
		!auth.admin &&
		sync === undefined &&
		(auth.actor.kind === 'member' ||
			auth.actor.kind === 'visitor' ||
			auth.actor.kind === 'api_key')
	) {
		const fileIds = (v: Json | undefined) =>
			(jsonArray(v) ? v : [v]).flatMap((x) =>
				Predicate.isObject(x) && typeof x['id'] === 'string' ? [x['id']] : []
			);
		for (const it of f.items) {
			const c = it.change;
			if (c.op === 'delete') continue;
			const values = c.op === 'update' ? c.set : c.values;
			const row = pre.get(k(c.model, named(c)));
			for (const [name, fieldSpec] of Object.entries(m.models[c.model]?.fields ?? {})) {
				if (fieldSpec.kind !== 'file' || values[name] === undefined) continue;
				const kept = new Set(fileIds(row?.[name]));
				for (const id of fileIds(values[name])) {
					if (kept.has(id)) continue;
					if (e.read === undefined)
						return yield* Effect.fail(
							BoltError.make('internal', 'admission', 'A file write needs the caller reader.')
						);
					if (
						!(yield* writableFile(
							{ manifest: m, db: own, read: e.read, authority: auth, bindings: b },
							id,
							`${c.model}.${name}`
						))
					)
						return none(
							refused('not_found', 'No file of yours, or that you can read, has this id.', [
								...c.path,
								name
							])
						);
				}
			}
		}
	}
	const moved: { item: Item; c: string; id: string; seen: number; now: number; update: boolean }[] =
		[];
	for (const it of f.items) {
		const c = it.change;
		const row = pre.get(k(c.model, named(c)));
		if (row === undefined) continue;
		const seen =
			c.op === 'update' || c.op === 'delete' ? (c.revision ?? r.observed?.[c.id] ?? null) : null;
		if (seen === null || seen === row['revision']) continue;
		if (typeof row['revision'] !== 'number' || seen > row['revision'] || !UUID_PATTERN.test(c.id))
			return none({ kind: 'conflict', records: [{ model: c.model, id: c.id }] });
		moved.push({
			item: it,
			c: c.model,
			id: c.id,
			seen,
			now: row['revision'],
			update: c.op === 'update'
		});
	}
	const movedFields: NonNullable<PlannedCommit['moved']>[number][] = [];
	if (moved.length > 0) {
		const [derived] = yield* own.read([
			{
				text: `SELECT x.c, x.id, (SELECT coalesce(jsonb_agg(DISTINCT f), '[]'::jsonb) FROM bolt_history h
				CROSS JOIN jsonb_object_keys(h.changes) f WHERE h.collection = x.c AND h.record = x.id::uuid
				AND h.revision > x.seen AND h.revision <= x.cur AND h.cause <> 'derived' AND h.op = 'update') AS fields
			FROM jsonb_to_recordset($1::jsonb) AS x(c text, id text, seen int, cur int, update boolean)
			WHERE (SELECT count(*) FROM bolt_history h WHERE h.collection = x.c AND h.record = x.id::uuid
				AND h.revision > x.seen AND h.revision <= x.cur
				AND (h.cause = 'derived' OR (x.update AND h.op = 'update'))) = x.cur - x.seen`,
				params: [
					JSON.stringify(
						moved.map(({ c, id, seen, now, update }) => ({ c, id, seen, cur: now, update }))
					)
				]
			}
		]);
		const accepted = new Map(
			(derived?.rows ?? []).map((row) => [
				k(String(row['c']), String(row['id'])),
				Array.isArray(row['fields']) ? row['fields'].map(String) : []
			])
		);
		const stale = moved.find(({ c, id }) => !accepted.has(k(c, id)));
		if (stale !== undefined)
			return none({ kind: 'conflict', records: [{ model: stale.c, id: stale.id }] });
		for (const { item, now, c, id } of moved) {
			if (item.change.op === 'update' || item.change.op === 'delete')
				item.change = { ...item.change, revision: now };
			const fields = accepted.get(k(c, id)) ?? [];
			if (fields.length > 0) movedFields.push({ model: c, id, fields });
		}
	}
	const planned = yield* plan(
		e,
		r,
		cat,
		f.items,
		pre,
		imp,
		byId ? upserted : undefined,
		own,
		visibility,
		admitted,
		scope.fingerprints
	);
	if ('outcome' in planned) return planned.outcome;
	sink(movedFields.length === 0 ? planned : { ...planned, moved: movedFields });
	const records = planned.commit.writes.map((w) => ({
		model: w.model,
		id: w.id,
		revision: w.op === 'create' ? 1 : w.revision + 1
	}));
	const request =
		planned.commit.approval?.request_id ??
		(planned.commit.resubmit?.pending === true ? planned.commit.resubmit.request : undefined);
	return request === undefined
		? {
				kind: 'committed' as const,
				output: planned.commit.output,
				records,
				...(planned.commit.unchanged === undefined ? {} : { unchanged: planned.commit.unchanged })
			}
		: { kind: 'pending_approval' as const, request_id: request, records };
});

const plan = Effect.fn('Bolt.plan')(function* (
	e: WriteEngine,
	r: ActRequest,
	cat: Catalog,
	submitted: readonly Item[],
	pre: Map<string, RowData>,
	imp?: ImportPlan,
	upserted?: (string | null)[],
	own: TenantDb = e.db,
	visibility: Map<string, boolean> = new Map<string, boolean>(),
	admitted?: Admitted,
	seen: readonly Fingerprint[] = []
): Effect.fn.Return<Planned, EngineError> {
	const context: PlanInput = {
		e,
		r,
		cat,
		submitted,
		pre,
		imp,
		own,
		visibility,
		admitted,
		held: heldBy(own, r.authority.actor)
	};
	const prepared = yield* prepareChanges(context);
	if ('outcome' in prepared) return prepared;
	const draft = yield* materializeChanges(context, prepared);
	if ('outcome' in draft) return draft;
	const routed = yield* routeChanges(context, prepared, draft);
	if ('outcome' in routed) return routed;
	const indexed = yield* indexChanges(context, draft.writes, routed.guest);
	if (typeof indexed !== 'boolean') return indexed;
	const guest = indexed,
		m = e.manifest,
		auth = r.authority,
		b = r.bindings;
	const { unchanged, report } = draft,
		{ approval, resubmit } = routed;
	const writes = approval !== undefined && r.verb === 'delete' ? [] : draft.writes;
	const { importRows, upsertOutput, readTables, guestTables, fingerprints } = prepared,
		{ sync } = r.mode;
	const resolvedImportIndices = new Set(importRows.map((row) => row.index));
	const stop = (outcome: Outcome): StoppedPlan => ({ guest, outcome });
	const embed = embedWrites(
		m,
		writes.map(({ write, item }) => (carried(r, item) ? { ...write, carried: true as const } : write))
	);
	const plain = embed.writes;
	const queued = embed.stale ? [embedQueued(minter(`${r.invocationId}:embed`, b.now)(), b.now)] : [];
	if (utf8Bytes(JSON.stringify(plain)) > LIMITS.changeSetBytes)
		return stop(refused('overflow', 'The change is too large for one act.'));
	const tables = [...new Set([...plain.map((w) => w.model), ...readTables])].sort();
	return {
		guest,
		commit: {
			now: b.now,
			today: b.today,
			actor: auth.actor,
			writer: writerOf(r.authority),
			writes: plain,
			runs: queued,
			output:
				upserted ??
				(r.verb === 'upsert'
					? upsertOutput
					: imp !== undefined
						? {
								rows: [
									...importRows,
									...report.filter(
										(row) => row.index === null || !resolvedImportIndices.has(row.index)
									)
								].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))
							}
						: null),
			...(plain.length === 0 && unchanged.length > 0 ? { unchanged } : {}),
			...(approval === undefined ? {} : { approval }),
			...(resubmit === undefined ? {} : { resubmit }),
			...((r.on_conflict === 'keep' || imp?.on_conflict === 'keep') &&
			plain.some((w) => w.op === 'create')
				? { kept: true as const }
				: {}),
			...(r.restored === undefined ? {} : { restored: [{ model: r.model, ...r.restored }] }),
			...(guest || seen.length > 0
				? { fingerprints: [...(guest ? fingerprints : []), ...seen] }
				: {}),
			...(sync === undefined ? {} : { pieces: sync.pieces })
		},
		...(guest && readTables.size > 0
			? { lock: { tables, mode: 'SHARE ROW EXCLUSIVE' as const } }
			: {}),
		...(guestTables.size === 0 ? {} : { reads: [...guestTables] })
	};
});
