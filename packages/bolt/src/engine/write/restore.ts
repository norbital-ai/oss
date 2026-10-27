// Per-record restore (rule 17): one live record's own stored fields back to a past revision, as one ordinary `update`
// that history records `restored` from that revision. Later history stays; restoring an earlier entry undoes it. Not
// point-in-time recovery (the whole database to a moment) and not a source rollback (the workspace code).
import { Effect, Option, Predicate, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Authority, Bindings, Outcome, RowData } from '../contracts.ts';
import type { ActRequest, ActResult } from '../services.ts';
import type { EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { catalogOf } from '../access/pred.ts';
import { q, SYSTEM_COLUMNS } from '@norbital-ai/store';
import { lowerRead, readEngine } from '../query/engine.ts';
import { readHistory } from '../query/history.ts';
import { decodeValue } from './flatten.ts';
import type { RestorePreview, RestoreSkip } from '../../protocol/record-contracts.ts';
import { k, readRows, recordCapabilities, stateField, type WriteEngine } from './act.ts';

export type RestoreTarget = { model: string; record: string; revision: number };
type Previewed =
	| { ok: true; preview: RestorePreview }
	| { ok: false; outcome: Extract<Outcome, { kind: 'refused' }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAST = '__bolt_restore_past';
const SYSTEM = new Set<string>(SYSTEM_COLUMNS);
const masked = (v: Json | undefined) => Predicate.isObject(v) && v['$masked'] === true;
const stored = (v: Json): Json =>
	Predicate.isObject(v) && Object.keys(v).length === 1 && typeof v['$dec'] === 'string'
		? v['$dec']
		: v;
const refused = (code: 'notFound' | 'invalidInput', message: string): Previewed => ({
	ok: false,
	outcome: { kind: 'refused', code, message }
});
const Row = Schema.Record(Schema.String, Schema.Json);
const Probe = Schema.Struct({ kept: Row, differs: Schema.Array(Schema.String) });

/**
 * What restoring `target` writes and leaves. `authority` null is the engine's own rollback of an approval request
 * (rules 44–46): the workspace's stored past, every own stored field, no grant or state edge to honour. Only that
 * internal rollback may count targets its same plan will recreate as present.
 */
export const restorePreview = Effect.fn('Bolt.restorePreview')(function* (
	e: Pick<WriteEngine, 'manifest' | 'db' | 'guest' | 'bridge'>,
	target: RestoreTarget,
	authority: Authority | null,
	bindings: Bindings,
	prospectiveTargets?: ReadonlySet<string>
): Effect.fn.Return<Previewed, EngineError> {
	const m = e.manifest,
		cat = catalogOf(m),
		{ model, record: id, revision } = target,
		c = cat.exposures.get(model);
	const gone = refused('notFound', 'Not found or no access.');
	if (c === undefined || m.models[model] === undefined || !UUID.test(id)) return gone;
	const caller =
		authority === null ? ({ as: 'workspace' } as const) : ({ as: 'caller', authority } as const);
	const getOf = (col: string, i: string) =>
		Effect.try({
			try: () => lowerRead(m, 'get', [col, i]),
			catch: (error) =>
				error instanceof BoltError ? error : BoltError.make('invalid', 'decode', String(error))
		});
	const asRow = (answer: readonly Json[]): RowData | null => {
		const row = answer[0];
		return Schema.is(Row)(row) ? row : null;
	};
	const reads = readEngine({ manifest: m, db: e.db });
	const readable = (col: string, i: string) =>
		getOf(col, i).pipe(
			Effect.flatMap((ir) => reads.run([ir], caller, bindings)),
			Effect.map(asRow)
		);
	const getIR = yield* getOf(model, id);
	const live = yield* readable(model, id);
	if (live === null) return gone;
	const caps =
		authority === null
			? null
			: yield* recordCapabilities(
					{ ...e, manifest: m },
					model,
					id,
					authority,
					bindings,
					readable
				);
	if (authority !== null && caps === null) return gone;
	if (caps?.update.reasons.includes('underApproval'))
		return {
			ok: false,
			outcome: {
				kind: 'refused',
				code: 'locked',
				message: 'Under approval: it changes only through its approval request.'
			}
		};
	const liveRevision =
		caps?.revision ??
		Number((yield* readRows(e.db, cat, [[model, id]])).get(k(model, id))?.['revision']);
	if (!Number.isSafeInteger(revision) || revision < 1 || revision >= liveRevision)
		return refused('invalidInput', `Revision ${revision} is not a past revision of this record.`);
	const history = (reader: { as: 'workspace' } | typeof caller) =>
		readHistory(
			e.db,
			m,
			{ kind: 'history', model, id, at: { _tag: 'Revision', revision }, full: true },
			reader,
			bindings
		);
	// the caller's fold authorizes (the history grant) and masks; the workspace's is the stored past to compare
	const seen = yield* history(caller);
	const raw = yield* history({ as: 'workspace' });
	if (!Predicate.isObject(seen) || !Predicate.isObject(raw) || Array.isArray(raw))
		return refused(
			'notFound',
			`Revision ${revision} cannot be rebuilt from this record's history.`
		);
	const past = Object.fromEntries(Object.entries(raw).map(([f, v]) => [f, stored(v)]));
	const table = c.model.name;
	// the stored values that still cast to their column (a jsonb column takes any value), and those that differ from live
	const probe = yield* e.db.one(Probe, {
		text: `WITH e AS (SELECT e.k, e.v FROM jsonb_each($1::jsonb) e(k, v)
	JOIN pg_attribute a ON a.attrelid = $2::regclass AND a.attname = e.k AND a.attnum > 0 AND NOT a.attisdropped
	WHERE a.atttypid = 'jsonb'::regtype OR jsonb_typeof(e.v) NOT IN ('string', 'number', 'boolean')
		OR pg_input_is_valid(e.v #>> '{}', format_type(a.atttypid, a.atttypmod))),
kept AS (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) AS j FROM e)
SELECT kept.j AS kept, (SELECT coalesce(jsonb_agg(d.key), '[]'::jsonb) FROM jsonb_each(to_jsonb(jsonb_populate_record(t, kept.j))) d
	WHERE to_jsonb(t) -> d.key IS DISTINCT FROM d.value) AS differs
FROM kept, ${q(table)} t WHERE t.id::text = $3`,
		params: [JSON.stringify(past), q(table), id]
	});
	if (Option.isNone(probe)) return gone;
	const { kept, differs } = probe.value;
	// the past row as the caller reads it: the read engine over the live row with the past values laid on it
	const prospective = {
		...e.db,
		read: (statements: Parameters<typeof e.db.read>[0]) =>
			e.db.read(
				statements.map((s) => {
					const params = [...s.params, JSON.stringify(kept), id];
					const cte = `${q(PAST)} AS (SELECT (jsonb_populate_record(t, $${params.length - 1}::jsonb)).* FROM ${q(table)} t WHERE t.id::text = $${params.length}::text)`;
					const text = s.text.trimStart();
					return {
						text: `WITH ${cte}${text.startsWith('WITH ') ? `, ${text.slice(5)}` : ` ${text}`}`,
						params
					};
				})
			)
	};
	const then = asRow(
		yield* readEngine({
			manifest: m,
			db: prospective,
			querySources: { sources: new Map([[table, PAST]]) }
		}).run([getIR], caller, bindings)
	);
	if (then === null) return refused('notFound', `Revision ${revision} is not readable to you.`);
	const changes: RestorePreview['changes'][number][] = [],
		skipped: RestorePreview['skipped'][number][] = [];
	const columns = new Set([...c.model.fields.values()].map((f) => f.column));
	for (const [key, value] of Object.entries(past))
		if (!columns.has(key) && !key.startsWith('bolt_') && value !== null)
			skipped.push({
				field: key,
				reason: 'definitionChanged',
				current: null,
				restored: masked(seen[key]) ? { $masked: true } : value
			});
	const state = stateField(m, model);
	for (const [name, f] of c.model.fields) {
		if (SYSTEM.has(name) || f.computed || f.derived || name.includes('.')) continue;
		const cols = f.arms === undefined ? [f.column] : f.arms.map((arm) => `${f.column}__${arm}`);
		const present = cols.filter((col) => Object.hasOwn(past, col));
		if (present.length === 0 || !Object.hasOwn(live, name)) continue; // not historied, or not visible
		const current = live[name] ?? null,
			restored = then[name] ?? null;
		const skip = (reason: RestoreSkip) =>
			skipped.push({
				field: name,
				reason,
				current,
				restored: reason === 'definitionChanged' ? null : restored
			});
		if (present.some((col) => !Object.hasOwn(kept, col))) {
			skip('definitionChanged');
			continue;
		}
		if (!cols.some((col) => differs.includes(col))) continue;
		if (masked(current) || masked(restored) || present.some((col) => masked(seen[col]))) {
			skip('masked');
			continue;
		}
		if (decodeValue(f, restored, m.models[model]?.fields[name]) !== null) {
			skip('definitionChanged');
			continue;
		}
		const cap = caps?.fields[name];
		let approval = false;
		if (caps === null) {
			// the engine's rollback: every own stored field, whatever the grants and state edges say
		} else if (name === state) {
			const to = String(restored);
			if (!(caps.moves[name] ?? []).includes(to)) {
				if (!(caps.proposalMoves[name] ?? []).includes(to)) {
					skip('stateLocked');
					continue;
				}
				approval = true;
			}
		} else {
			if (cap === undefined) {
				skip('noGrant');
				continue;
			}
			const reasons = cap.reasons;
			if (
				reasons.some((r) => r === 'syncOwned' || r === 'ownedParent' || r === 'ownedParentLocked')
			) {
				skip('readOnly');
				continue;
			}
			if (reasons.includes('stateLocked')) {
				skip('stateLocked');
				continue;
			}
			if (!cap.writable) {
				if (!cap.proposal) {
					skip('noGrant');
					continue;
				}
				approval = true;
			}
		}
		// ordinary restore never writes the target; rollback can recreate it in the same decision
		if (restored !== null && c.model.one.has(name)) {
			const ref: readonly [string, string] | null =
				typeof restored === 'string'
					? [c.model.one.get(name)!.targets[0]!, restored]
					: Predicate.isObject(restored) &&
						  typeof restored['model'] === 'string' &&
						  typeof restored['id'] === 'string'
						? [restored['model'], restored['id']]
						: null;
			if (
				ref === null ||
				(!(authority === null && prospectiveTargets?.has(k(...ref)) === true) &&
					!(yield* readRows(e.db, cat, [ref])).has(k(...ref)))
			) {
				skip('deletedTarget');
				continue;
			}
		}
		changes.push({ field: name, current, restored, approval });
	}
	return {
		ok: true,
		preview: { model, record: id, revision, live: liveRevision, changes, skipped }
	};
});

/** Restores the record's own fields as one ordinary update against the observed live revision (rule 25). */
export const restoreRecord = Effect.fn('Bolt.restoreRecord')(function* (
	e: Pick<WriteEngine, 'manifest' | 'db' | 'guest' | 'bridge'>,
	write: (request: ActRequest) => Effect.Effect<ActResult, EngineError>,
	target: RestoreTarget,
	request: Pick<
		ActRequest,
		'authority' | 'bindings' | 'key' | 'issuedAt' | 'retry' | 'invocationId' | 'observed' | 'rate'
	>
): Effect.fn.Return<{ outcome: Outcome; v?: number }, EngineError> {
	const previewed = yield* restorePreview(e, target, request.authority, request.bindings);
	if (!previewed.ok) return { outcome: previewed.outcome };
	const { preview } = previewed;
	if (preview.changes.length === 0)
		return {
			outcome: {
				kind: 'refused',
				code: 'invalidInput',
				message: `Revision ${target.revision} has nothing you may restore.`
			}
		};
	return yield* write({
		...request,
		model: target.model,
		verb: 'update',
		mode: { _tag: 'Direct' },
		input: [
			{
				target: target.record,
				set: Object.fromEntries(preview.changes.map((change) => [change.field, change.restored]))
			}
		],
		observed: request.observed ?? { [target.record]: preview.live },
		restored: { id: target.record, revision: target.revision }
	});
});
