// `<c>.erase` (rule 38e, §5.13): the engine write of an administrator's generated `delete` (remove) or `update`
// (anonymise) with no transform, never routed, refused on a held row, and with its history purged in the same one
// statement. Admission (admin-only, `approvalHeld`, `locked`, erasable fields) is identity's `judgeErase`; this file
// decodes, reads, and compiles the act.
import type { Json } from '../../decl/values.ts';
import type { Captured, Outcome, RowData } from '../contracts.ts';
import { BoltError } from '../contracts.ts';
import { catalogOf } from '../access/pred.ts';
import { exprFields, judgeErase } from '../identity/erase.ts';
import { q } from '../../protocol/catalog.ts';
import { type ActRequest, type ActResult, constraintsOf, expired, idempotency, k, ownedLocks, readRows, refused, stateField, type Taker, type WriteEngine } from './act.ts';
import { compileCommit, compileOutcomeRecord, type Commit, type Write } from './commit.ts';
import { Flattener } from './flatten.ts';
import { decided } from './sql.ts';

type Obj = { readonly [key: string]: Json };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function erase(e: WriteEngine, r: ActRequest, take: Taker): Promise<ActResult> {
	const m = e.manifest, cat = catalogOf(m), auth = r.authority, b = r.bindings, c = r.collection, model = m.models[c];
	const none = (outcome: Outcome): ActResult => ({ outcome, captured: [] });
	if (model === undefined || m.collections[c] === undefined) throw new BoltError('unknownCollection', 'decode', `unknown collection '${c}'`);
	const late = expired(r);
	if (late !== null) return none(late);
	if (!auth.admin) return none(refused('forbidden', 'Only an administrator can erase.'));

	// decode: `{ target }` removes, `{ target, set }` anonymises stored authored fields (X-24 shapes)
	const input = r.input;
	if (!isObj(input) || Object.keys(input).some((x) => x !== 'target' && x !== 'set')) return none(refused('invalidInput', 'erase takes { target } or { target, set }.'));
	const ids = Array.isArray(input['target']) ? input['target'] : [input['target']];
	if (ids.length === 0 || !ids.every((x): x is string => typeof x === 'string')) return none(refused('invalidInput', 'target is an id or a list of ids.', ['target']));
	const set = input['set'];
	let values: RowData = {};
	if (set !== undefined) {
		if (!isObj(set) || Object.keys(set).length === 0) return none(refused('invalidInput', 'set names the fields to anonymise.', ['set']));
		const f = new Flattener(m, cat, () => '');
		f.update(c, 'any', ids[0], set, null, []);
		const other = Object.keys(set).find((x) => model.fields[x] === undefined);
		if (other !== undefined) return none(refused('invalidInput', `'${other}' is not a stored authored field.`, ['set', other]));
		if (f.problems.length > 0) return none(refused('invalidInput', f.problems.map((p) => `${p.path.join('.')}: ${p.message}`).join('; '), f.problems[0]!.path));
		values = (f.items[0]!.change as { set: RowData }).set;
	}
	const req = set === undefined ? { mode: 'remove' as const } : { mode: 'anonymise' as const, set: values };

	const { key, digest, stored } = await idempotency(e, r, auth);
	if (r.retry) { const o = await stored(); if (o !== null) return none(o); }

	// the targets and their owned children (a held child refuses too), one round trip
	const owned = Object.entries(m.relationships).filter(([, rel]) => rel.owned && (typeof rel.to === 'string' ? rel.to === c : rel.to.includes(c)))
		.map(([name]) => name.split('.') as [string, string]);
	const [rows, children] = await Promise.all([readRows(e.db, catalogOf(m), ids.map((id) => [c, id] as const)),
		owned.length === 0 ? [] : e.db.read(owned.map(([child, fk]) => ({
			text: `SELECT approval_id::text AS approval_id FROM ${q(child)} WHERE ${q(fk)}::text IN (SELECT jsonb_array_elements_text($1::jsonb)) AND approval_id IS NOT NULL LIMIT 1`,
			params: [JSON.stringify(ids)] })))]);
	const missing = ids.find((id) => !rows.has(k(c, id)));
	if (missing !== undefined) return none(refused('notFound', 'The record does not exist.', ['target']));
	const stored_ = ids.map((id) => rows.get(k(c, id))!);
	const verdict = judgeErase(m, auth, c, stored_, req);
	if (!verdict.ok) return none({ kind: 'refused', code: verdict.code, message: verdict.message, ...(verdict.requestId === undefined ? {} : { data: { requestId: verdict.requestId } }) }); // hook:identity
	const heldChild = children.flatMap((x) => x.rows)[0];
	if (heldChild !== undefined) return none({ kind: 'refused', code: 'approvalHeld', message: `An owned record is held by approval request ${String(heldChild['approval_id'])}.`,
		data: { requestId: String(heldChild['approval_id']) } }); // hook:approvals

	// anonymise on an unlocked row still follows the state's `to` edges (rule 40)
	const state = stateField(m, c);
	if (state !== undefined && values[state] !== undefined) {
		const states = (model.fields[state] as { states: { readonly [s: string]: { to?: readonly string[] } } }).states;
		const bad = stored_.find((row) => row[state] !== values[state] && !(states[String(row[state])]?.to ?? []).includes(String(values[state])));
		if (bad !== undefined) return none(refused('invalidInput', `'${String(bad[state])}' cannot move to '${String(values[state])}'.`, ['set', state]));
	}

	let writes: Write[], spec: NonNullable<Commit['erase']>;
	if (req.mode === 'remove') {
		writes = stored_.map((row) => ({ collection: c, id: String(row['id']), op: 'delete', revision: Number(row['revision']) }));
		spec = { mode: 'remove' };
	} else {
		// 38e(b): an authored vector the set names is nulled; a platform embedding whose sources it names goes
		const nulled = Object.fromEntries(Object.keys(values).filter((x) => model.fields[x]?.kind === 'vector').map((x) => [x, null]));
		const embedded = model.search?.semantic?.fields.some((x) => x in values) ? { bolt_embedding: null } : {};
		const write = { ...values, ...nulled, ...embedded };
		writes = stored_.map((row) => ({ collection: c, id: String(row['id']), op: 'update', set: write, revision: Number(row['revision']) }));
		spec = { mode: 'anonymise', collection: c, ids, purge: readers(model.computed ?? {}, Object.keys(values)) };
	}
	const common = { key, digest, issuedAt: r.issuedAt, rate: r.rate ?? [] };
	const commit: Commit = { ...common, now: b.now, today: b.today, actor: auth.actor, writes, owned: req.mode === 'remove' ? ownedLocks(m, cat, writes, rows) : [],
		runs: [], notices: [], outbox: [], output: null, erase: spec, events: take('info', 'act.settled', { erased: writes.length }) };
	try {
		const res = await e.db.write(compileCommit(m, cat, commit));
		// no event trigger fires and no outbox row is written (38e(d)); the captured rows re-answer live views only
		return { outcome: (res.rows[0]!['outcome'] as Outcome | null) ?? await stored() ?? refused('refused', 'The outcome was lost.'),
			captured: res.rows[0]!['captured'] as unknown as Captured[] }; // hook:identity — erase commits reach the live lane
	} catch (err) {
		const d = decided(err, constraintsOf(m));
		if (!d.record) return none(d.outcome);
		const events = take('warn', 'act.refused', d.outcome.kind === 'refused' ? { code: d.outcome.code, message: d.outcome.message } : { code: d.outcome.kind });
		const res = await e.db.write(compileOutcomeRecord({ ...common, events }, d.outcome as Json));
		return none((res.rows[0]?.['outcome'] as Outcome | null) ?? d.outcome);
	}
}

/** The anonymised fields plus every computed field that reads one of them, transitively (38e(b)). */
function readers(computed: { readonly [name: string]: { expr: unknown } }, fields: readonly string[]): string[] {
	const out = new Set(fields);
	for (let grew = true; grew;) {
		grew = false;
		for (const [name, c] of Object.entries(computed)) {
			if (out.has(name)) continue;
			const read = new Set<string>();
			exprFields(c.expr, read);
			if ([...read].some((x) => out.has(x))) { out.add(name); grew = true; }
		}
	}
	return [...out];
}
