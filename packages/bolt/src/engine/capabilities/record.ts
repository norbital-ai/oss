// Record capabilities: current-row advice from the act's own admission. Locks, state moves and owned-parent locks are
// enforced by the native rules at commit; this module evaluates them in memory only to advise what a change may touch.
import { Effect } from 'effect';
import type { RecordCapabilities, RecordParentContext, RecordRestriction } from '../../protocol/record-contracts.ts';
import type { Authority, Bindings, RowData } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { layered, type EngineManifest } from '../manifest.ts';
import { SYSTEM } from '../../system/index.ts';
import { grant_sql, type Catalog, type Pred } from '@norbital-ai/store';
import { admitMove, readPredicates } from '../access/authority.ts';
import { catalog_of, toPred } from '../access/pred.ts';
import { evaluate, type EvalEnv } from '../query/eval.ts';
import { resolverOf } from '../query/reader.ts';
import { holders } from '../approvals/lock.ts';
import type { Write } from '../write/commit.ts';
import { k, opened, readOnlySync, readRows, stateField, type Probe } from '../write/act.ts';

/** Whether a lock holds the row: without fields, for deletion; an update, for the fields it changes. */
const modelLock = Effect.fnUntraced(function* (
	env: EvalEnv,
	m: EngineManifest,
	model: string,
	row: RowData,
	fields?: readonly string[]
): Effect.fn.Return<{ code: 'locked'; message: string; field: string } | null, BoltError> {
	for (const { where, except } of Object.values(m.models[model]?.locks ?? {})) {
		const field =
			fields === undefined || (except?.length ?? 0) === 0
				? 'id'
				: fields.find((name) => !except?.includes(name));
		if (field !== undefined && evaluate(env, model, yield* toPred(m, model, where), row))
			return { code: 'locked', message: 'This record is locked and cannot be changed.', field };
	}
	return null;
});
/** The owned parents a child write would hold in their admitting states, and the predicate each must still meet. */
const ownedLocks = Effect.fnUntraced(function* (
	m: EngineManifest,
	cat: Catalog,
	writes: readonly Write[],
	pre: Map<string, RowData>
): Effect.fn.Return<{ child: string; parent: string; where: Pred; ids: string[] }[], BoltError> {
	const created = new Set(writes.filter((write) => write.op === 'create').map((write) => k(write.model, write.id)));
	const locks = new Map<string, { child: string; parent: string; where: Pred; ids: Set<string> }>();
	for (const write of writes)
		for (const [fk, one] of cat.models.get(write.model)?.one ?? []) {
			const relation = m.relationships[`${write.model}.${fk}`];
			const parent = one.targets[0];
			if (!relation?.owned || relation.inverse === undefined || parent === undefined) continue;
			const id = write.op === 'create' ? write.values[fk] : pre.get(k(write.model, write.id))?.[fk];
			if (typeof id !== 'string' || created.has(k(parent, id))) continue;
			const blocked = Object.values(m.models[parent]?.locks ?? {}).filter((rule) =>
				!rule.except?.includes(relation.inverse ?? '')
			);
			if (blocked.length === 0) continue;
			const key = `${parent}.${relation.inverse}`;
			const lock = locks.get(key) ?? {
				child: write.model, parent,
				where: { t: 'not' as const, of: { t: 'or' as const, of: yield* Effect.forEach(blocked, (rule) => toPred(m, parent, rule.where)) } },
				ids: new Set<string>()
			};
			lock.ids.add(id);
			locks.set(key, lock);
		}
	return [...locks.values()].map((lock) => ({ ...lock, ids: [...lock.ids] }));
});

/**
 * Current-row advice from the act's own admission: the columns the caller's update arms name at the record's write path,
 * its checks' verdict on the unchanged record (allow: writable; approve: a proposal), and the model rules. A child opened
 * under its parent is edited through the parent's access point: the parent's permission on that relation gates it.
 */
export const record_capabilities = Effect.fn('Bolt.recordCapabilities')(function* (
	e: Probe,
	model: string,
	id: string,
	authority: Authority,
	bindings: Bindings,
	readable: (model: string, id: string) => Effect.Effect<RowData | null, EngineError>,
	parent?: RecordParentContext
): Effect.fn.Return<RecordCapabilities | null, EngineError> {
	const m = Object.hasOwn(SYSTEM.exposures, model) ? layered(e.manifest) : e.manifest,
		spec = m.exposures[model],
		stored = m.models[model];
	if (stored === undefined || (spec === undefined && parent === undefined)) return null;
	const visible = yield* readable(model, id);
	if (visible === null) return null;
	const cat = catalog_of(m),
		pre = yield* readRows(e.db, cat, [[model, id]]);
	const row = pre.get(k(model, id));
	// the stored row must be the revision the caller just read: a change between them may move it out of scope
	if (
		row === undefined ||
		typeof row['revision'] !== 'number' ||
		visible['revision'] !== row['revision']
	)
		return null;
	const probe = { ...e, manifest: m };
	// the write path the record's fields sit at, and the root whose arms and checks judge it
	let path = model,
		owner = model,
		gate: 'allow' | 'approve' | 'refuse',
		parentReasons: readonly RecordRestriction[] = [],
		fk: string | undefined,
		freeLink = false,
		unlink = false,
		deleteDeclared = spec?.delete !== undefined;
	if (parent !== undefined) {
		const relation = cat.models.get(parent.model)?.many.get(parent.relation);
		if (relation?.child !== model) return null;
		const parentCaps = yield* record_capabilities(
			e,
			parent.model,
			parent.id,
			authority,
			bindings,
			readable
		);
		if (parentCaps === null || parentCaps.revision !== parent.revision) return null;
		const permission = parentCaps.fields[parent.relation];
		if (permission === undefined) return null;
		path = `${parent.model}.${parent.relation}`;
		// the child is read through the root's layer: that layer's scope in any output the caller holds (absent =
		// unscoped), never the child's own grant
		const predicates = readPredicates(authority, path);
		if (predicates !== undefined && predicates.length > 0) {
			const statement = yield* grant_sql(
				cat,
				model,
				{
					t: 'and',
					of: [
						{ t: 'cmp', field: 'id', op: 'eq', arg: { _tag: 'Lit', value: id } },
						{ t: 'cmp', field: 'revision', op: 'eq', arg: { _tag: 'Lit', value: row['revision'] } },
						{ t: 'or', of: predicates }
					]
				},
				{ resolve: resolverOf(bindings, authority), tz: bindings.tz }
			).pipe(Effect.mapError(from_store));
			const [admitted] = yield* e.db.read([statement]);
			if (!admitted?.rows.length) return null;
		}
		owner = parent.model;
		fk = relation.column;
		const relationship = m.relationships[`${model}.${fk}`];
		freeLink = row[fk] == null && relationship?.owned !== true;
		if (row[fk] !== parent.id && !freeLink) return null;
		unlink = relationship?.owned !== true && relationship?.optional === true;
		gate = permission.writable ? 'allow' : permission.proposal ? 'approve' : 'refuse';
		parentReasons = permission.reasons.filter((reason) => reason !== 'no_grant');
		deleteDeclared = !freeLink;
	} else
		gate =
			spec?.update === undefined
				? 'refuse'
				: yield* opened(probe, authority, bindings, model, 'update', [id]);
	const declared = m.exposures[owner]?.update?.columns ?? {};
	const arms = authority.models[owner]?.update ?? [];
	const covered = (at: string, field?: string) =>
		Object.hasOwn(declared, at) &&
		(authority.admin ||
			arms.some(
				(arm) =>
					Object.hasOwn(arm.columns, at) &&
					(field === undefined || (arm.columns[at]?.includes(field) ?? false))
			));
	const granted = (field: string) =>
		freeLink
			? field === fk && covered(path)
			: field === fk
				? unlink && covered(path)
				: (declared[path]?.includes(field) ?? false) && covered(path, field);
	const restrictions: RecordRestriction[] = [];
	const locks = yield* ownedLocks(
		m,
		cat,
		[{ model, id, op: 'update', set: {}, revision: row['revision'] }],
		pre
	);
	const parents = locks.flatMap((lock) => lock.ids.map((parent) => [lock.parent, parent] as const));
	for (const [key, value] of yield* readRows(e.db, cat, parents)) pre.set(key, value);
	if (
		locks.some((lock) =>
			lock.ids.some(
				(parent) => {
					const row = pre.get(k(lock.parent, parent));
					return row === undefined || !evaluate({ cat, bindings }, lock.parent, lock.where, row);
				}
			)
		)
	)
		restrictions.push('owned_parent_locked');
	// the approval lock (lock.ts): an open request holding this record, or its owned parent, that the caller may not change
	const owned: (readonly [string, string])[] = [[model, id]];
	for (const [fk, one] of cat.models.get(model)?.one ?? []) {
		const value = row[fk];
		if (!m.relationships[`${model}.${fk}`]?.owned || typeof value !== 'string') continue;
		const target = one.targets[0];
		if (target === undefined) return yield* BoltError.make('invalid_spec', 'admission', `The owned reference ${model}.${fk} has no target.`);
		owned.push([target, value]);
	}
	const holding = yield* holders(e.db, owned, authority.actor);
	if (holding.some((h) => !h.eligible || h.readGuarded)) restrictions.push('under_approval');
	const local = spec?.update?.columns[model] ?? [];
	const remote =
		readOnlySync(m, model) === undefined
			? []
			: Object.keys(stored.fields).filter((field) => !local.includes(field));
	const env: EvalEnv = { cat, bindings, authority };
	const state = stateField(m, model);
	const stateKind = state === undefined ? undefined : stored.fields[state];
	const transitions =
		stateKind?.kind === 'state' ? (stateKind.states[String(row[state ?? ''])]?.to ?? []) : [];
	const moves =
		state === undefined
			? []
			: transitions.filter((next) => admitMove(authority, model, state, String(row[state]), next));
	/** A field's or relation's advice: its own reasons, then the checks' verdict on the record. */
	const advise = (reasons: RecordRestriction[]) => ({
		writable: reasons.length === 0 && gate === 'allow',
		proposal: reasons.length === 0 && gate === 'approve',
		reasons: [...new Set(gate === 'allow' ? reasons : [...reasons, 'no_grant' as const])]
	});
	const fields: Record<string, ReturnType<typeof advise>> = {};
	for (const field of Object.keys(visible)) {
		if (
			stored.fields[field] === undefined &&
			stored.computed?.[field] === undefined &&
			m.relationships[`${model}.${field}`] === undefined
		)
			continue;
		const value = visible[field];
		const reasons = [...restrictions, ...parentReasons];
		if (!granted(field)) reasons.push('no_grant');
		if (remote.includes(field)) reasons.push('sync_owned');
		if (field !== fk && m.relationships[`${model}.${field}`]?.owned) reasons.push('owned_parent');
		if (field === state) {
			if ((yield* modelLock(env, m, model, row, [field])) !== null) reasons.push('state_locked');
			if (moves.length === 0) reasons.push(transitions.length === 0 ? 'state_locked' : 'no_grant');
		} else if ((yield* modelLock(env, m, model, row, [field])) !== null)
			reasons.push('state_locked');
		fields[field] = advise(reasons);
	}
	// the child layers declared under this path: each relation a change of the record may act on
	for (const at of Object.keys(declared)) {
		const relation = at.startsWith(`${path}.`) ? at.slice(path.length + 1) : '';
		if (relation === '' || relation.includes('.') || !cat.models.get(model)?.many.has(relation))
			continue;
		const reasons = [...restrictions, ...parentReasons];
		if (!covered(at)) reasons.push('no_grant');
		if ((yield* modelLock(env, m, model, row, [relation])) !== null)
			reasons.push('state_locked');
		fields[relation] = advise(reasons);
	}
	const advice = Object.values(fields);
	const updateReasons = [...restrictions, ...parentReasons];
	if (!advice.some((field) => field.writable)) updateReasons.push('no_grant');
	const deleteGate =
		parent !== undefined
			? gate
			: deleteDeclared
				? yield* opened(probe, authority, bindings, model, 'delete', [id])
				: 'refuse';
	const deleteReasons = [...restrictions, ...parentReasons];
	if ((yield* modelLock(env, m, model, row)) !== null) deleteReasons.push('state_locked');
	if (!deleteDeclared || deleteGate !== 'allow') deleteReasons.push('no_grant');
	return {
		model,
		id,
		revision: row['revision'],
		fields,
		update: {
			allowed: updateReasons.length === 0,
			proposal: restrictions.length === 0 && advice.some((field) => field.proposal),
			reasons: [...new Set(updateReasons)]
		},
		delete: {
			allowed: deleteReasons.length === 0,
			proposal:
				deleteDeclared &&
				deleteGate === 'approve' &&
				deleteReasons.every((reason) => reason === 'no_grant'),
			reasons: [...new Set(deleteReasons)]
		},
		moves: state !== undefined && fields[state]?.writable ? { [state]: moves } : {},
		proposal_moves: state !== undefined && fields[state]?.proposal ? { [state]: transitions } : {}
	};
});
