import { Array as EffectArray, Effect, Schema } from 'effect';
import { WriteOutcome as OutcomeSchema } from '../../protocol/schema.ts';
// `<c>.erase` (rule 38e, §5.13): the engine write of an administrator's generated `delete` (remove) or `update`
// (anonymise) with no transform, never routed. Durable audit delays history purge until its full
// external acknowledgement. Admission (admin-only, `locked`, erasable fields) is identity's `judgeErase`; this file
// decodes, reads, and compiles the act.
import { Predicate } from 'effect';
import type { Outcome, RowData } from '../contracts.ts';

import { BoltError } from '../../protocol/errors.ts';
import { catalogOf } from '../access/pred.ts';
import { exprFields, judgeErase } from '../identity/erase.ts';
import {
	type ActRequest,
	type ActResult,
	constraintsOf,
	expired,
	idempotency,
	k,
	ownedLocks,
	readRows,
	refused,
	type Taker,
	type WriteEngine
} from './act.ts';
import { executeCommit, compileOutcomeRecord, type Commit, type Write } from './commit.ts';
import { writerOf } from '../runs/queue.ts';
import { Flattener } from './flatten.ts';
import { decided } from './sql.ts';
export const erase = Effect.fn('Bolt.erase')(function* (
	e: WriteEngine,
	r: ActRequest,
	take: Taker
) {
	const m = e.manifest,
		cat = catalogOf(m),
		auth = r.authority,
		b = r.bindings,
		c = r.model,
		model = m.models[c];
	const none = (outcome: Outcome): ActResult => ({ outcome, captured: [], v: 0 });
	if (model === undefined || m.exposures[c] === undefined)
		return yield* Effect.fail(BoltError.make('unknownModel', 'decode', `unknown model '${c}'`));
	const late = expired(r);
	if (late !== null) return none(late);
	if (!auth.admin) return none(refused('forbidden', 'Only an administrator can erase.'));
	// decode: `{ target }` removes, `{ target, set }` anonymises stored authored fields (X-24 shapes)
	const input = r.input;
	if (!Predicate.isObject(input) || Object.keys(input).some((x) => x !== 'target' && x !== 'set'))
		return none(refused('invalidInput', 'erase takes { target } or { target, set }.'));
	const target = input['target'];
	const ids = EffectArray.isArray<typeof target>(target) ? target : [target];
	if (ids.length === 0 || !ids.every((x): x is string => typeof x === 'string'))
		return none(refused('invalidInput', 'target is an id or a list of ids.', ['target']));
	const set = input['set'];
	let values: RowData = {};
	if (set !== undefined) {
		if (!Predicate.isObject(set) || Object.keys(set).length === 0)
			return none(refused('invalidInput', 'set names the fields to anonymise.', ['set']));
		const f = new Flattener(m, cat, () => '');
		f.update(c, 'any', ids[0], set, null, []);
		const other = Object.keys(set).find((x) => model.fields[x] === undefined);
		if (other !== undefined)
			return none(
				refused('invalidInput', `'${other}' is not a stored authored field.`, ['set', other])
			);
		if (f.problems.length > 0)
			return none(
				refused(
					'invalidInput',
					f.problems.map((p) => `${p.path.join('.')}: ${p.message}`).join('; '),
					f.problems[0]!.path
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
	const { key, digest, stored } = yield* idempotency(e, r, auth);
	if (r.retry) {
		const o = yield* stored();
		if (o !== null) return none(o);
	}
	const rows = yield* readRows(
		e.db,
		cat,
		ids.map((id) => [c, id] as const)
	);
	const stored_: RowData[] = [];
	for (const id of ids) {
		const row = rows.get(k(c, id));
		if (row === undefined) return none(refused('notFound', `No ${c} has this id.`, ['target']));
		stored_.push(row);
	}
	const verdict = judgeErase(m, auth, c, stored_, req);
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
	const common = { key, digest, issuedAt: r.issuedAt, rate: r.rate ?? [] };
	const commit: Commit = {
		...common,
		now: b.now,
		today: b.today,
		actor: auth.actor,
		writer: writerOf(auth),
		writes,
		owned: req.mode === 'remove' ? ownedLocks(m, cat, writes, rows) : [],
		runs: [],
		notices: [],
		output: null,
		erase: spec
	};
	yield* take('info', 'act.settled', { erased: writes.length });
	if (r.mode._tag === 'Record') {
		const { key: _key, digest: _digest, issuedAt: _issuedAt, rate: _rate, ...planned } = commit;
		r.mode.sink({ commit: planned });
		return none({
			kind: 'committed',
			output: null,
			records: writes.map((write) => ({
				model: write.model,
				id: write.id,
				revision: write.op === 'create' ? 1 : write.revision + 1
			}))
		});
	}
	return yield* Effect.gen(function* () {
		const rows = yield* executeCommit(e.db, m, cat, commit);
		const row = rows[0];
		if (row === undefined)
			return yield* Effect.fail(
				BoltError.make('badAnswer', 'commit', 'The commit returned no answer.')
			);
		const outcome = row.outcome ?? (yield* stored()) ?? refused('refused', 'The outcome was lost.');
		return {
			outcome,
			captured: row.captured,
			v: e.committed === undefined ? 0 : yield* e.committed(row, outcome)
		};
	}).pipe(
		Effect.catch((err) =>
			Effect.gen(function* () {
				const d = yield* Effect.try({
					try: () => decided(err, constraintsOf(m)),
					catch: (error) =>
						error instanceof BoltError
							? error
							: BoltError.make('bug', 'commit', String(error), error)
				});
				if (!d.record) return none(d.outcome);
				yield* take(
					'warn',
					'act.refused',
					d.outcome.kind === 'refused'
						? { code: d.outcome.code, message: d.outcome.message }
						: { code: d.outcome.kind }
				);
				const value = yield* Schema.decodeUnknownEffect(Schema.Json)(d.outcome).pipe(
					Effect.mapError((error) => BoltError.make('badAnswer', 'commit', error.message, error))
				);
				const res = yield* e.db.returning(
					Schema.Struct({ outcome: Schema.NullOr(OutcomeSchema) }),
					compileOutcomeRecord(common, value)
				);
				return none(res[0]?.outcome ?? d.outcome);
			})
		)
	);
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
