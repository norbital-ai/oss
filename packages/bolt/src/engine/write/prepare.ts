// Level-by-level upsert resolution, guest write callbacks, and built-in system transforms.
import { Effect } from 'effect';
import { canonical } from '@norbital-ai/store';
import { BoltError } from '../../protocol/errors.ts';
import { LIMITS, type Invocation, type Outcome, type RowData } from '../contracts.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import type { EngineError } from '../errors.ts';
import { envoyChannelTransform, instanceTransform } from '../integrations/instances.ts';
import type { EngineManifest } from '../manifest.ts';
import { changeInputs, judgeSubmitted } from './admit.ts';
import { Flattener, type Item } from './flatten.ts';
import { prospectiveBridge } from './prospective.ts';
import { readableBy, readRows, resolveUpserts, transformBridge } from './rows.ts';
import {
	answerOf,
	APPROVED,
	CARRIED,
	carried,
	changeDepth,
	changeToken,
	descendantOf,
	guest_context,
	guest_port,
	guestFailure,
	hasCallback,
	k,
	missing_record,
	refused,
	syncOwnership,
	withoutId,
	type ImportRow,
	type PlanInput,
	type PreparedPlan,
	type StoppedPlan
} from './shared.ts';
import { minter, type Fingerprint } from './sql.ts';

type ResolutionState = {
	identities: Map<string, string>;
	importRows: ImportRow[];
	upsertOutput: string[];
};

const displayNameTransform =
	(model: string) =>
	(
		_db: TenantDb,
		_m: EngineManifest,
		items: readonly Item[]
	): Effect.Effect<readonly Item[] | Outcome> => {
		const changed: Item[] = [];
		for (const item of items) {
			const c = item.change;
			if (c.model !== model || c.op !== 'update' || typeof c.set['name'] !== 'string') {
				changed.push(item);
				continue;
			}
			const name = c.set['name'].trim();
			if (name.length === 0 || name.length > 120)
				return Effect.succeed(
					refused('check', 'A display name must have 1–120 characters.', [...c.path, 'set', 'name'])
				);
			changed.push({ ...item, change: { ...c, set: { ...c.set, name } } });
		}
		return Effect.succeed(changed);
	};

const ENGINE_TRANSFORMS: {
	readonly [model: string]: (
		db: TenantDb,
		m: EngineManifest,
		items: readonly Item[],
		pre: ReadonlyMap<string, RowData>
	) => Effect.Effect<readonly Item[] | Outcome, EngineError>;
} = {
	sys_user: displayNameTransform('sys_user'),
	sys_workspace: displayNameTransform('sys_workspace'),
	sys_integration: (_db, m, items, pre) =>
		Effect.succeed(instanceTransform(m, items, (id) => pre.get(k('sys_integration', id)))),
	sys_envoy_channel: Effect.fnUntraced(function* (
		db: TenantDb,
		m: EngineManifest,
		items: readonly Item[]
	) {
		const needsLookup = items.some(
			({ change: c }) => c.model === 'sys_envoy_channel' && c.op !== 'delete' && c.op !== 'update'
		);
		const [envoysRes, instancesRes] = needsLookup
			? yield* db.read([
					{ text: 'SELECT id::text AS id FROM sys_envoy WHERE active', params: [] },
					{ text: 'SELECT id, integration, owner FROM sys_integration', params: [] }
				])
			: [undefined, undefined];
		const activeEnvoys = new Set(
			(envoysRes?.rows ?? []).flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : []))
		);
		const knownInstances = new Map(
			(instancesRes?.rows ?? []).flatMap((row) =>
				typeof row['id'] === 'string' && typeof row['integration'] === 'string'
					? [
							[
								row['id'],
								{
									integration: row['integration'],
									owner: typeof row['owner'] === 'string' ? row['owner'] : null
								}
							] as const
						]
					: []
			)
		);
		return envoyChannelTransform(m, items, activeEnvoys, knownInstances);
	})
};

const resolveLevel = Effect.fn('Bolt.resolveLevel')(function* (
	context: PlanInput,
	items: Item[],
	level: number,
	state: ResolutionState
): Effect.fn.Return<Item[] | Outcome, EngineError> {
	const { r, pre, imp, own, visibility } = context,
		m = context.e.manifest,
		auth = r.authority;
	const { identities, importRows, upsertOutput } = state,
		{ sync } = r.mode;
	const current = items.filter((item) => changeDepth(item) === level);
	const matches = yield* resolveUpserts(
		own,
		m,
		current.filter((item) => item.change.op === 'upsert')
	);
	for (const item of current) {
		const c = item.change;
		if (c.op !== 'upsert') continue;
		const found = matches.get(item),
			root = imp !== undefined && item.parent === undefined;
		if (
			found !== undefined &&
			((item.parent === undefined && !readableBy(auth, c.model, found, visibility)) ||
				(root && imp.on_conflict === 'refuse'))
		)
			return refused('unique', 'A record with these values already exists.', c.path);
		if (found === undefined && c.on.length === 1 && c.on[0] === 'id' && sync === undefined)
			return refused('not_found', `No ${c.model} has this id.`, [...c.path, 'id']);
		const id = found === undefined ? c.id : String(found['id']);
		const skip = found === undefined && root && imp.on_missing === 'skip';
		if (r.verb === 'upsert' && item.parent === undefined) upsertOutput.push(id);
		if (root)
			importRows.push({
				index: Number(c.path[0]),
				id: skip ? null : id,
				action: skip
					? 'skipped'
					: found === undefined
						? 'created'
						: c.on_conflict === 'keep'
							? 'kept'
							: 'updated'
			});
		if (skip || (found !== undefined && c.on_conflict === 'keep')) {
			items = items.filter((one) => one !== item && !descendantOf(one, item));
			continue;
		}
		if (found !== undefined) pre.set(k(c.model, id), found);
		const values = Object.fromEntries(
			Object.entries(c.values).filter(
				([field]) => field !== 'id' && (found === undefined || !c.on.includes(field))
			)
		);
		item.change =
			found === undefined
				? { model: c.model, id, path: c.path, op: 'create', values }
				: {
						model: c.model,
						id,
						path: c.path,
						op: 'update',
						set: values,
						revision: Number(found['revision'])
					};
		identities.set(changeToken(item), id);
		if (id !== c.id)
			for (const child of items) {
				if (
					child.parent?.model !== c.model ||
					child.parent.id !== c.id ||
					!descendantOf(child, item)
				)
					continue;
				child.parent = { ...child.parent, id };
				if (child.change.op !== 'delete')
					child.change =
						child.change.op === 'update'
							? { ...child.change, set: { ...child.change.set, [child.parent.fk]: id } }
							: { ...child.change, values: { ...child.change.values, [child.parent.fk]: id } };
			}
	}
	return items;
});

export const prepareChanges = Effect.fn('Bolt.prepareChanges')(function* (
	context: PlanInput
): Effect.fn.Return<PreparedPlan | StoppedPlan, EngineError> {
	const { e, r, cat, pre, own } = context;
	const m = e.manifest,
		auth = r.authority,
		b = r.bindings;
	const { submitted } = context;
	let items: Item[] = submitted.map((item) => ({
		...item,
		change:
			item.change.op === 'update'
				? { ...item.change, set: { ...item.change.set } }
				: item.change.op === 'delete'
					? { ...item.change }
					: { ...item.change, values: { ...item.change.values } },
		...(item.parent === undefined ? {} : { parent: { ...item.parent } })
	}));
	const identities = new Map(submitted.map((item) => [changeToken(item), item.change.id]));
	const supplied = new Map(submitted.map((item) => [changeToken(item), item.supplied]));
	const importRows: ImportRow[] = [];
	const upsertOutput: string[] = [];
	const readTables = new Set<string>(),
		guestTables = new Set<string>(),
		fingerprints: Fingerprint[] = [];
	const judged = yield* judgeSubmitted(context, items, { readTables, fingerprints });
	if ('outcome' in judged) return judged;
	let runs = judged.guest;
	const flow = judged.flow;
	for (let level = 0; level <= LIMITS.writeDepth; level++) {
		const resolved = yield* resolveLevel(context, items, level, {
			identities,
			importRows,
			upsertOutput
		});
		if ('kind' in resolved) return { guest: runs, outcome: resolved };
		items = resolved;
		const groups = Map.groupBy(
			items.filter((item) => changeDepth(item) === level && !carried(r, item)),
			(item) => canonical([item.change.model, item.change.op])
		);
		for (const roots of groups.values()) {
			const first = roots[0];
			if (first === undefined || first.change.op === 'upsert') continue;
			const model = first.change.model,
				verb = first.change.op;
			if (!hasCallback(m, model, verb)) continue;
			const port = yield* guest_port(e.guest);
			for (let offset = 0; offset < roots.length; offset += LIMITS.writeChunk) {
				const chunk = roots.slice(offset, offset + LIMITS.writeChunk),
					seed = `${r.invocationId}:${model}:${verb}:${level}:${offset / LIMITS.writeChunk}`;
				const { input, missing } = yield* changeInputs(context, model, verb, chunk, items, {
					readTables,
					fingerprints
				});
				if (missing !== undefined) return { guest: runs, outcome: missing_record(missing.change.path) };
				const from = chunk[0]?.change.path ?? [];
				const invocation: Invocation = {
					id: seed,
					kind: verb,
					target: model,
					input,
					ctx: {
						...guest_context(auth.actor, b, seed),
						policies: auth.policies,
						admin: auth.admin
					},
					budget: { crossings: LIMITS.crossings.write, readBytes: LIMITS.readBytes }
				};
				const original = e.bridge?.(invocation, own) ?? transformBridge(m, own, invocation);
				const bridge = prospectiveBridge(e, cat, b, auth.actor, items, pre, original);
				const g = yield* port.invoke(invocation, bridge);
				runs = true;
				for (const table of original.tables?.() ?? []) {
					readTables.add(table);
					guestTables.add(table);
				}
				fingerprints.push(...(original.fingerprints?.() ?? []));
				if (g.kind === 'refused') {
					const at = g.row === undefined ? undefined : chunk[g.row];
					const row = at?.change.path.find((part) => typeof part === 'number');
					return {
						guest: true,
						outcome: {
							kind: 'refused',
							code: 'refused',
							message: g.message,
							...(g.key === undefined ? {} : { key: g.key }),
							...(g.values === undefined ? {} : { values: g.values }),
							rule: `${model}.${verb}`,
							...(g.field === undefined ? {} : { field: g.field }),
							...(typeof row === 'number' ? { row } : {})
						}
					};
				}
				if (g.kind === 'failed') return { guest: true, outcome: yield* guestFailure(g.error) };
				const answer = answerOf(verb, g.output, chunk.length, m, model);
				if (typeof answer === 'string')
					return yield* BoltError.make('transform_shape', 'guest', answer);
				const carries = [
					...answer.with.map((write) => [CARRIED, write] as const),
					...(flow === undefined
						? answer.on_approved.map((write) => [APPROVED, write] as const)
						: [])
				];
				if (carries.length > 0 && level === LIMITS.writeDepth)
					return yield* BoltError.make(
						'transform_shape',
						'guest',
						`a write nested ${LIMITS.writeDepth} deep carries no further writes`
					);
				const again = new Flattener(m, cat, minter(seed, b.now), identities);
				for (const [index, item] of chunk.entries()) {
					const c = item.change;
					if (c.op === 'create')
						again.create(model, 'any', withoutId(answer.sets[index]), c.path, item.parent);
					else if (c.op === 'update')
						again.update(model, 'any', c.id, answer.sets[index], c.revision, c.path, item.parent);
				}
				for (const [segment, write] of carries) {
					if (m.models[write.model] === undefined)
						return yield* BoltError.make(
							'transform_payload',
							'guest',
							`${write.model}: no such model`
						);
					const at = [...from, segment, write.model, write.op, write.index];
					if (write.op === 'create') again.create(write.model, 'any', write.row, at);
					else again.update(write.model, 'any', write.target, write.set, null, at);
				}
				if (again.problems.length)
					return yield* BoltError.make(
						'transform_payload',
						'guest',
						again.problems
							.map((problem) => `${problem.path.join('.')}: ${problem.message}`)
							.join('; ')
					);
				const owners = new Map(chunk.toReversed().map((root) => [changeToken(root), root]));
				const replacements: Item[] = again.items.map((item) => {
					const owner = owners.get(changeToken(item));
					return {
						...item,
						supplied: supplied.get(changeToken(item)) ?? [],
						...(owner?.belongs === undefined ? {} : { belongs: owner.belongs })
					};
				});
				const replacedPaths = new Set(
					verb === 'delete' ? [] : chunk.map((item) => canonical(item.change.path))
				);
				items = [
					...items.filter(
						(item) =>
							!replacedPaths.has(canonical(item.change.path)) &&
							!item.change.path.some((_, index) =>
								replacedPaths.has(canonical(item.change.path.slice(0, index)))
							)
					),
					...replacements
				];
				for (const item of replacements) identities.set(changeToken(item), item.change.id);
				if (items.length > LIMITS.changesPerAct)
					return {
						guest: true,
						outcome: refused('overflow', `An act writes at most ${LIMITS.changesPerAct} rows.`)
					};
				const more = yield* readRows(
					own,
					cat,
					replacements.flatMap((item) =>
						item.change.op === 'update' || item.change.op === 'delete'
							? pre.has(k(item.change.model, item.change.id))
								? []
								: [[item.change.model, item.change.id] as const]
							: []
					)
				);
				for (const [key, row] of more) pre.set(key, row);
			}
		}
	}
	for (const [model, transform] of Object.entries(ENGINE_TRANSFORMS)) {
		if (!items.some((item) => item.change.model === model)) continue;
		const t = yield* transform(e.db, m, items, pre);
		if ('kind' in t) return { guest: runs, outcome: t };
		items = [...t];
	}
	const owned = syncOwnership(m, r, items);
	if (owned !== null) return { guest: runs, outcome: owned };
	return {
		guest: runs,
		items,
		flow,
		importRows,
		upsertOutput,
		readTables,
		guestTables,
		fingerprints
	};
});
