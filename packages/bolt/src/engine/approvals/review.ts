// A requester's resubmission: the request's own checkpoint against the final proposal, including held child changes,
// as the before/set/after envelope its verdict judges and the (path, field) needs the admitting arms must cover.
import { Effect, Predicate, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Bindings, RowData } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { LIMITS } from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';
import { HistorySnapshotSchema } from '../../protocol/record-contracts.ts';
import { storedChanges } from '../db/stored.ts';
import type { Catalog } from '@norbital-ai/store';
import { read_history } from '../query/history.ts';
import { fingerprinting, type Fingerprint } from '../write/sql.ts';
import type { Write } from '../write/commit.ts';
import { k, treeSelect, wireRows, writeTree, type Need } from '../write/act.ts';

const jsonArray = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
/** A resubmission compares the request's own checkpoint with the final proposal, including held child changes. */
export const reviewChange = Effect.fn('Approvals.reviewChange')(function* (
	m: EngineManifest,
	cat: Catalog,
	db: TenantDb,
	bindings: Bindings,
	request: { readonly id: string; readonly model: string; readonly record: string; readonly action: 'create' | 'update' | 'delete' },
	writes: readonly { readonly write: Write }[],
	reads: { readonly readTables: Set<string>; readonly fingerprints: Fingerprint[] }
): Effect.fn.Return<{ change: { before: RowData | null; set: RowData; after: RowData | null }; needs: Need[] }, EngineError> {
	const recorded = fingerprinting(db), own = recorded.db;
	const columns: Readonly<Record<string, readonly string[]>> = request.action === 'delete' ? {} : m.exposures[request.model]?.[request.action]?.columns ?? {};
	const targets = new Map([[request.model, request.model]]);
	for (const path of Object.keys(columns).sort()) {
		let parentPath = request.model, model = request.model;
		for (const rel of path.slice(request.model.length + 1).split('.').filter(Boolean)) {
			const edge = cat.models.get(model)?.many.get(rel);
			if (edge === undefined) return yield* BoltError.make('invalid_spec', 'admission', `The review tree has no ${parentPath}.${rel} relationship.`);
			model = edge.child;
			parentPath += `.${rel}`;
			targets.set(parentPath, model);
		}
	}
	const records = yield* own.rows(Schema.Struct({ model: Schema.String, id: Schema.String, before: Schema.NullOr(Schema.Int) }), {
		text: `SELECT entry.collection AS model, entry.id, entry.before FROM bolt_approvals a,
		jsonb_to_recordset(a.records) AS entry(collection text,id text,before int) WHERE a.id=$1::uuid`,
		params: [request.id]
	});
	if (!records.some((record) => record.model === request.model && record.id === request.record))
		return yield* BoltError.make('conflict', 'admission', 'The approval checkpoint is missing; its records remain held.');
	const saved = new Map<string, RowData | null>();
	const checkpoints = records.filter((record) => [...targets.values()].includes(record.model));
	// one wave: the checkpoints' history reads cross together over the act's coalescing reader
	const values = yield* Effect.forEach(checkpoints, (record) => record.before === null
		? Effect.succeed(null)
		: read_history(own, m, {
			kind: 'history', model: record.model, id: record.id,
			at: { _tag: 'Before', before: request.id }, view: true
		}, { as: 'workspace' }, bindings), { concurrency: 'unbounded' });
	for (const [index, record] of checkpoints.entries()) {
		if (record.before === null) { saved.set(k(record.model, record.id), null); continue; }
		const value = values[index] ?? null;
		if (value === null) return yield* BoltError.make('conflict', 'admission', 'An approval checkpoint is missing; its records remain held.');
		const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(value).pipe(
			Effect.mapError((error) => BoltError.make('schema', 'decode', error.message))
		);
		const row = snapshot.compatible;
		for (const field of cat.models.get(record.model)?.fields.values() ?? [])
			if (!field.computed && !field.derived && !['seq', 'sum', 'count'].includes(field.kind) && !field.name.startsWith('bolt_') && !Object.hasOwn(row, field.name))
				return yield* BoltError.make('conflict', 'admission', `The approval checkpoint cannot supply ${record.model}.${field.name}; its records remain held.`);
		saved.set(k(record.model, record.id), row);
	}
	const live = new Map<string, RowData | null>();
	const paths = [...targets.keys()];
	const trees = yield* Effect.forEach([...targets], ([path, model]) => {
		const ids = [...new Set([
			...(path === request.model ? [request.record] : []),
			...records.filter((record) => record.model === model).map((record) => record.id),
			...writes.filter(({ write }) => write.model === model).map(({ write }) => write.id)
		])];
		return Effect.map(wireRows(own, cat, model, ids, bindings, treeSelect(cat, paths, path, model)), (rows) => ({ path, ids, rows }));
	}, { concurrency: 'unbounded' });
	for (const { path, ids, rows } of trees)
		for (const [index, id] of ids.entries()) live.set(k(path, id), rows[index] ?? null);
	for (const table of [...targets.values(), 'bolt_approvals', 'bolt_history', 'bolt_history_schema', 'bolt_history_current', 'bolt_audit_erase']) reads.readTables.add(table);
	reads.fingerprints.push(...recorded.fingerprints());
	const drafted = Map.groupBy(writes, ({ write }) => k(write.model, write.id));
	const rowList = (value: Json | undefined, path: string): readonly RowData[] => {
		if (!jsonArray(value)) throw BoltError.make('internal', 'decode', `The stored review tree is missing ${path}.`);
		if (value.length > LIMITS.page.max) throw BoltError.make('too_large', 'admission', `The stored ${path} exceeds the review tree limit.`);
		return value.map((row) => {
			if (!Predicate.isObject(row) || typeof row['id'] !== 'string') throw BoltError.make('internal', 'decode', `The stored review tree has an invalid ${path} row.`);
			return row;
		});
	};
	const tree = (side: 'before' | 'after', path: string, model: string, id: string, fallback: RowData | null): RowData | null => {
		const current = live.has(k(path, id)) ? live.get(k(path, id)) ?? null : fallback, key = k(model, id);
		let row = side === 'before' && saved.has(key) ? saved.get(key) ?? null : current;
		if (side === 'after')
			for (const { write } of drafted.get(key) ?? [])
				row = write.op === 'delete' ? null : write.op === 'create' ? { ...write.values, id } : row === null ? null : { ...row, ...write.set };
		if (row === null) return null;
		const answer: Record<string, Json> = { ...row };
		if (side === 'after')
			for (const field of cat.models.get(model)?.fields.values() ?? [])
				if (field.computed || field.derived || field.kind === 'sum' || field.kind === 'count') delete answer[field.name];
		for (const [rel, edge] of cat.models.get(model)?.many ?? []) {
			const childPath = `${path}.${rel}`;
			if (!targets.has(childPath)) continue;
			const candidates = new Map<string, RowData>();
			for (const child of current === null ? [] : rowList(current[rel], childPath)) candidates.set(String(child['id']), child);
			for (const record of records) {
				if (record.model !== edge.child) continue;
				const old = saved.get(k(edge.child, record.id));
				const present = live.get(k(childPath, record.id));
				if (old?.[edge.column] === id || present?.[edge.column] === id) candidates.set(record.id, present ?? old ?? { id: record.id });
			}
			for (const { write } of writes)
				if (write.model === edge.child && write.op !== 'delete' && (write.op === 'create' ? write.values : write.set)[edge.column] === id)
					candidates.set(write.id, live.get(k(childPath, write.id)) ?? { id: write.id });
			const children: RowData[] = [];
			for (const [childId, child] of candidates) {
				const next = tree(side, childPath, edge.child, childId, child);
				if (next?.[edge.column] === id) children.push(next);
			}
			if (children.length > LIMITS.page.max) throw BoltError.make('too_large', 'admission', `The approval's ${childPath} exceeds the review tree limit.`);
			answer[rel] = children;
		}
		return answer;
	};
	const targetOf = (row: RowData): RowData => {
		if (typeof row['id'] !== 'string' || typeof row['revision'] !== 'number') throw BoltError.make('conflict', 'admission', 'An approval child has no stored revision; its records remain held.');
		return { id: row['id'], revision: row['revision'] };
	};
	const needs: Need[] = [];
	const inputTree = (path: string, model: string, before: RowData | null, after: RowData, create: boolean): RowData => {
		const values: Record<string, Json> = {};
		const at = path.lastIndexOf('.');
		const parent = at < 0 ? undefined : targets.get(path.slice(0, at));
		const fixed = parent === undefined ? undefined : cat.models.get(parent)?.many.get(path.slice(at + 1))?.column;
		for (const field of columns[path] ?? []) {
			if (field === fixed) continue;
			const value = after[field];
			if (value !== undefined && (create || Object.hasOwn(storedChanges(cat, model, before ?? {}, { [field]: value }), field))) {
				values[field] = value;
				// a create's stored row carries every column; one still empty was never the requester's to be granted
				if (!create || value !== null) needs.push({ path, field });
			}
		}
		for (const [rel, edge] of cat.models.get(model)?.many ?? []) {
			const childPath = `${path}.${rel}`;
			if (!targets.has(childPath)) continue;
			const previous = new Map((before === null ? [] : rowList(before[rel], childPath)).map((row) => [String(row['id']), row]));
			const next = new Map(rowList(after[rel], childPath).map((row) => [String(row['id']), row]));
			const owned = m.relationships[`${edge.child}.${edge.column}`]?.owned === true;
			const groups: Record<string, Json[]> = {};
			const add = (action: string, value: Json) => { (groups[action] ??= []).push(value); };
			for (const [id, row] of next) {
				const old = previous.get(id);
				if (old === undefined) {
					const key = k(edge.child, id);
					const checkpoint = saved.has(key) ? saved.get(key) : live.get(k(childPath, id));
					if (!owned && checkpoint != null) {
						add('link', targetOf(checkpoint));
						if (!create) {
							const baseline = tree('before', childPath, edge.child, id, checkpoint) ?? checkpoint;
							const set = inputTree(childPath, edge.child, baseline, row, false);
							if (Object.keys(set).length > 0) add('update', { target: targetOf(checkpoint), set });
						}
					}
					else add('create', inputTree(childPath, edge.child, null, row, true));
				} else if (!create) {
					const set = inputTree(childPath, edge.child, old, row, false);
					if (Object.keys(set).length > 0) add('update', { target: targetOf(old), set });
				}
			}
			for (const [id, row] of previous)
				if (!next.has(id)) add(owned || live.get(k(childPath, id)) === null ? 'delete' : 'unlink', targetOf(row));
			if (Object.keys(groups).length > 0) {
				values[rel] = create ? Object.values(groups).flat() : groups;
				needs.push({ path: childPath });
			}
		}
		return values;
	};
	return yield* Effect.try({
		try: () => {
			const before = request.action === 'create' ? null : tree('before', request.model, request.model, request.record, null);
			const after = request.action === 'delete' ? null : tree('after', request.model, request.model, request.record, null);
			return { change: { before: writeTree(cat, request.model, before), after: writeTree(cat, request.model, after), set: after === null ? {} : inputTree(request.model, request.model, before, after, request.action === 'create') }, needs };
		},
		catch: (error) => error instanceof BoltError ? error : BoltError.make('internal', 'decode', String(error))
	});
});
