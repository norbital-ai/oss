import { Array as EffectArray, Effect } from 'effect';
// `<c>.erase`: the engine write of an administrator's generated `delete` (remove) or `update`
// (anonymise) with no transform, never routed. Durable audit delays history purge until its full
// external acknowledgement. Admission (admin-only, `locked`, erasable fields) is identity's `judgeErase`; this file
// decodes, reads, and compiles the act.
import { Predicate } from 'effect';
import type { Outcome, RowData } from '../contracts.ts';

import { BoltError } from '../../protocol/errors.ts';
import { catalog_of } from '../access/pred.ts';
import { exprFields, judgeErase } from '../identity/erase.ts';
import {
	type ActRequest,
	k,
	readRows,
	refused,
	type Taker,
	type WriteEngine
} from './act.ts';
import type { Commit, Write } from './commit.ts';
import { writerOf } from '../runs/queue.ts';
import { Flattener } from './flatten.ts';
export const erase = Effect.fn('Bolt.erase')(function* (
	e: WriteEngine,
	r: ActRequest,
	take: Taker
) {
	const m = e.manifest,
		cat = catalog_of(m),
		auth = r.authority,
		b = r.bindings,
		c = r.model,
		model = m.models[c];
	const none = (outcome: Outcome): Outcome => outcome;
	if (model === undefined || m.exposures[c] === undefined)
		return yield* Effect.fail(BoltError.make('unknown_model', 'decode', `unknown model '${c}'`));
	if (!auth.admin) return none(refused('forbidden', 'Only an administrator can erase.'));
	// decode: `{ target }` removes, `{ target, set }` anonymises stored authored fields (X-24 shapes)
	const input = r.input;
	if (!Predicate.isObject(input) || Object.keys(input).some((x) => x !== 'target' && x !== 'set'))
		return none(refused('invalid_input', 'erase takes { target } or { target, set }.'));
	const target = input['target'];
	const ids = EffectArray.isArray<typeof target>(target) ? target : [target];
	if (ids.length === 0 || !ids.every((x): x is string => typeof x === 'string'))
		return none(refused('invalid_input', 'target is an id or a list of ids.', ['target']));
	const set = input['set'];
	let values: RowData = {};
	if (set !== undefined) {
		if (!Predicate.isObject(set) || Object.keys(set).length === 0)
			return none(refused('invalid_input', 'set names the fields to anonymise.', ['set']));
		const f = new Flattener(m, cat, () => '');
		f.update(c, 'any', ids[0], set, null, []);
		const other = Object.keys(set).find((x) => model.fields[x] === undefined);
		if (other !== undefined)
			return none(
				refused('invalid_input', `'${other}' is not a stored authored field.`, ['set', other])
			);
		const problem = f.problems[0];
		if (problem !== undefined)
			return none(
				refused(
					'invalid_input',
					f.problems.map((p) => `${p.path.join('.')}: ${p.message}`).join('; '),
					problem.path
				)
			);
		const change = f.items[0]?.change;
		if (change?.op !== 'update')
			return yield* Effect.fail(
				BoltError.make('invalid', 'decode', 'The anonymisation did not produce an update.')
			);
		values = change.set;
	}
	const req =
		set === undefined ? { mode: 'remove' as const } : { mode: 'anonymise' as const, set: values };
	const rows = yield* readRows(
		e.db,
		cat,
		ids.map((id) => [c, id] as const)
	);
	const stored_: RowData[] = [];
	for (const id of ids) {
		const row = rows.get(k(c, id));
		if (row === undefined) return none(refused('not_found', `No ${c} has this id.`, ['target']));
		const observed = r.observed?.[id];
		if (observed !== undefined && row['revision'] !== observed)
			return none({ kind: 'conflict', records: [{ model: c, id }] });
		stored_.push(row);
	}
	const verdict = yield* judgeErase(m, auth, c, stored_, req, b);
	if (!verdict.ok) return none({ kind: 'refused', code: verdict.code, message: verdict.message }); // hook:identity
	let writes: Write[], spec: NonNullable<Commit['erase']>;
	if (req.mode === 'remove') {
		writes = stored_.map((row) => ({
			model: c,
			id: String(row['id']),
			op: 'delete',
			revision: Number(row['revision'])
		}));
		spec = { mode: 'remove' };
	} else {
		// 38e(b): an authored vector the set names is nulled; a platform embedding whose sources it names goes
		const nulled = Object.fromEntries(
			Object.keys(values)
				.filter((x) => model.fields[x]?.kind === 'vector')
				.map((x) => [x, null])
		);
		const embedded = model.search?.semantic?.fields.some((x) => x in values)
			? { bolt_embedding: null }
			: {};
		const write = { ...values, ...nulled, ...embedded };
		writes = stored_.map((row) => ({
			model: c,
			id: String(row['id']),
			op: 'update',
			set: write,
			revision: Number(row['revision'])
		}));
		spec = {
			mode: 'anonymise',
			model: c,
			ids,
			purge: readers(model.computed ?? {}, Object.keys(values))
		};
	}
	yield* take('info', 'act.settled', { erased: writes.length });
	r.mode.sink({
		commit: {
			now: b.now,
			today: b.today,
			actor: auth.actor,
			writer: writerOf(auth),
			writes,
			runs: [],
			output: null,
			erase: spec
		}
	});
	return {
		kind: 'committed',
		output: null,
		records: stored_.map((row) => ({ model: c, id: String(row['id']), revision: Number(row['revision']) + 1 }))
	} satisfies Outcome;
});
/** The anonymised fields plus every computed field that reads one of them, transitively (38e(b)). */
function readers(
	computed: {
		readonly [name: string]: {
			expr: unknown;
		};
	},
	fields: readonly string[]
): string[] {
	const out = new Set(fields);
	for (let grew = true; grew;) {
		grew = false;
		for (const [name, c] of Object.entries(computed)) {
			if (out.has(name)) continue;
			const read = new Set<string>();
			exprFields(c.expr, read);
			if ([...read].some((x) => out.has(x))) {
				out.add(name);
				grew = true;
			}
		}
	}
	return [...out];
}
