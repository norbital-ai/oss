// engine/write and engine/query on PGlite, the P2 review gaps: erase (38e), history and prune (17), import and export
// (30), same-shape merge (12), relation-action upsert (28), cascades and frozen parents (41), the delete guard (27),
// telemetry (§5.12), pipeline order (19), guest failures (42, 72a), `expired` (31) and the roll-up oracle (21).
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { Authority, GuestOutcome, Invocation, Outcome, Pred, TenantDb } from '../src/engine/contracts.ts';
import { BoltError } from '../src/engine/contracts.ts';
import { EventLog } from '../src/engine/guest/telemetry.ts';
import { readEngine } from '../src/engine/query/engine.ts';
import { pruneHistory, readHistory } from '../src/engine/query/history.ts';
import { act, type ActRequest, type WriteEngine } from '../src/engine/write/act.ts';
import { exportRows } from '../src/engine/write/import.ts';
import { admin, arm, authority, grants, NOW, TODAY } from './write-fixture.ts';
import { manifest, open } from './write-p2.fixture.ts';

let pg: PGlite, db: TenantDb;
const count = { reads: 0, writes: 0, statements: 0 };
let n = 0;
beforeEach(async () => {
	const x = await open();
	pg = x.pg;
	db = { read: (s) => (count.reads++, count.statements += s.length, x.db.read(s)), write: (s, l) => (count.writes++, x.db.write(s, l)),
		transaction: (b, l) => x.db.transaction(b, l) };
	count.reads = 0; count.writes = 0; count.statements = 0;
});

const bindings = { now: NOW, today: TODAY, tz: 'UTC', params: {} };
type Over = Partial<ActRequest> & Pick<ActRequest, 'verb' | 'input'>;
const run = (over: Over, engine: Partial<WriteEngine> = {}) => act({ manifest, db, ...engine },
	{ collection: 'orders', key: `key-${n}`, issuedAt: NOW, authority: admin, bindings, invocationId: `inv-${n++}`, ...over });
const rows = async (sql: string) => (await pg.query<Record<string, Json>>(sql)).rows;
const one = async (sql: string) => (await rows(sql))[0]!;
const ok = (o: Outcome) => { if (o.kind !== 'committed' && o.kind !== 'pendingApproval') throw new Error(JSON.stringify(o)); return o; };
const idOf = (o: Outcome, c = 'orders') => ok(o).records.find((r) => r.collection === c)!.id;
const order = async (title = 'desk', lines: { label: string; amount: string }[] = []) =>
	idOf((await run({ verb: 'create', input: { title, lines: { create: lines } } })).outcome);
const person = async (code: string, name: string, email: string | null = null) =>
	idOf((await run({ collection: 'people', verb: 'create', input: { code, name, email } })).outcome, 'people');
const FALSE: Pred = { t: 'const', value: false };
const REQUEST = '0199a000-0000-7000-8000-0000000000aa';
/** A grant whose writes route to approval, and the hook that holds them under `REQUEST`. */
const routed = (op: 'create' | 'update') => authority({ orders: grants({ [op]: [{ ...arm(), approval: [{ steps: [['finance']] }] }] }) });
const holding: Partial<WriteEngine> = { approval: { participant: () => false, route: () => ({ requestId: REQUEST }) } };
function transform(body: (inv: Invocation) => GuestOutcome, collection = 'orders', calls: Invocation[] = []): Partial<WriteEngine> {
	return { transforms: new Set([collection]), guest: { invoke: async (inv) => (calls.push(inv), body(inv)) } };
}

describe('engine-owned staged transform identities',()=>{
 it('exposes genuine root and owned child identities and persists those exact coordinates',async()=>{
  const calls:Invocation[]=[];
  const result=await run({verb:'create',input:{title:'staged',lines:{create:[{label:'contract',amount:'1'}]}}},transform(inv=>({kind:'ok',output:inv.input,cpuMs:1}),'orders',calls));
  ok(result.outcome);
  const staged=calls[0]!.ctx.staged!;
  expect(staged).toHaveLength(2);
  const parent=staged.find(row=>row.collection==='orders')!,child=staged.find(row=>row.collection==='lines')!;
  expect(parent.parent).toBeUndefined();
  expect(child.parent).toEqual({collection:'orders',id:parent.id,relation:'lines',field:'order'});
  expect(child.path).toEqual(['lines','create',0]);
  expect((await one('select id::text as id from orders')).id).toBe(parent.id);
  expect(await one('select id::text as id, "order"::text as owner from lines')).toEqual({id:child.id,owner:parent.id});
 });
 it('refuses transformed mint-order changes before committing a staged owner capture',async()=>{
  await expect(run({verb:'create',input:[{title:'first'},{title:'second'}]},transform(inv=>({kind:'ok',output:(inv.input as Record<string,Json>[]).map((row,index)=>index===0?{...row,lines:{create:[{label:'new',amount:'1'}]}}:row),cpuMs:1})))).rejects.toThrow(/engine-assigned identity/);
  expect(await rows('select id from orders')).toEqual([]);
 });
});

describe('engine/write: erase (rule 38e, §5.13)', () => {
	it('remove deletes as a delete would, keeps one erased revision, and drops the rest of its history and its notices', async () => {
		const id = await order('desk', [{ label: 'a', amount: '1' }, { label: 'b', amount: '2' }]);
		ok((await run({ verb: 'update', input: { target: id, set: { note: 'n' } } })).outcome);
		await pg.query(`insert into sys_notification (id, recipient, title, link, at) values ('n1', '{}', 'Hi', $1, now())`, [JSON.stringify({ collection: 'orders', id })]);
		count.writes = 0;
		const { outcome, captured } = await run({ verb: 'erase', input: { target: id } });
		expect(ok(outcome).records).toEqual([{ collection: 'orders', id, revision: 3 }]);
		// hook:identity — the removed rows reach live views only; no event trigger fires and no run is queued (38e(d))
		expect(captured.map((x) => [x.collection, x.op])).toEqual([['orders', 'delete'], ['lines', 'delete'], ['lines', 'delete']]);
		expect(await one(`select count(*)::int n from sys_run`)).toEqual({ n: 0 });
		expect(count.writes).toBe(1);
		expect(await one(`select (select count(*)::int from orders) o, (select count(*)::int from lines) l, (select count(*)::int from sys_notification) n`)).toEqual({ o: 0, l: 0, n: 0 });
		expect(await rows(`select collection, op, cause, changes from bolt_history order by collection`)).toEqual([{ collection: 'orders', op: 'delete', cause: 'erased', changes: {} }]);
	});

	it('anonymise purges the fields and their computed readers from earlier revisions; the erased revision holds the set values', async () => {
		const id = await person('p1', 'Ada', 'ada@example.com');
		ok((await run({ collection: 'people', verb: 'update', input: { target: id, set: { name: 'Ada L' } } })).outcome);
		ok((await run({ collection: 'people', verb: 'erase', input: { target: id, set: { name: 'Erased' } } })).outcome);
		const history = await rows(`select revision, cause, changes from bolt_history where collection = 'people' order by revision`);
		// revision 2 changed only name (and shout), so it is left empty and goes
		expect(history.map((h) => [h['revision'], h['cause']])).toEqual([[1, 'direct'], [3, 'erased']]);
		expect(Object.keys(history[0]!['changes'] as object)).not.toContain('name');
		expect(Object.keys(history[0]!['changes'] as object)).not.toContain('shout');
		expect(history[0]!['changes']).toMatchObject({ code: 'p1', email: 'ada@example.com' });
		expect(history[1]!['changes']).toEqual({ name: 'Erased', shout: 'ERASED' });
		expect(await one(`select name, shout from people`)).toEqual({ name: 'Erased', shout: 'ERASED' });
	});

	it('on a frozen row remove is locked and anonymise of an erasable field commits past edit: none', async () => {
		const id = await person('p1', 'Ada', 'ada@example.com');
		ok((await run({ collection: 'people', verb: 'update', input: { target: id, set: { status: 'archived' } } })).outcome);
		expect((await run({ collection: 'people', verb: 'update', input: { target: id, set: { email: null } } })).outcome).toMatchObject({ code: 'locked' });
		expect((await run({ collection: 'people', verb: 'erase', input: { target: id } })).outcome).toMatchObject({ code: 'locked' });
		ok((await run({ collection: 'people', verb: 'erase', input: { target: id, set: { email: null } } })).outcome);
		expect(await one(`select email, status from people`)).toEqual({ email: null, status: 'archived' });
	});

	it('is admin-only, refuses a held row, and a restricting child refuses a remove', async () => {
		const id = await order('desk');
		expect((await run({ verb: 'erase', input: { target: id }, authority: authority({ orders: grants() }) })).outcome).toMatchObject({ code: 'forbidden' });
		const held = idOf((await run({ verb: 'create', input: { title: 'held' }, authority: routed('create') }, holding)).outcome);
		expect((await run({ verb: 'erase', input: { target: held } })).outcome).toMatchObject({ code: 'approvalHeld' });
		ok((await run({ collection: 'receipts', verb: 'create', input: { memo: 'r', order: id } })).outcome);
		expect((await run({ verb: 'erase', input: { target: id } })).outcome).toMatchObject({ code: 'restricted' });
		expect((await run({ verb: 'delete', input: { target: id } })).outcome).toMatchObject({ code: 'restricted' });
	});
});

describe('engine/query: history (rule 17)', () => {
	const history = (id: string, reader: Authority, at?: { revision: number } | { before: string }) =>
		readHistory(db, manifest, { kind: 'history', collection: 'orders', id, ...(at === undefined ? {} : { at }) }, { as: 'caller', authority: reader }, bindings) as Promise<{ revision: number; cause: string; changed: { [k: string]: Json }; actor: unknown }[]>;

	it('reads revisions in order, cut by `at`, masked by the reader\'s grant, and none without a history grant', async () => {
		const id = await order('desk');
		ok((await run({ verb: 'update', input: { target: id, set: { note: 'a' } } })).outcome);
		ok((await run({ verb: 'update', input: { target: id, set: { note: 'b' } } })).outcome);
		const all = await history(id, admin);
		expect(all.map((r) => [r.revision, r.changed['note']])).toEqual([[1, null], [2, 'a'], [3, 'b']]);
		expect(all[0]!.actor).toEqual({ kind: 'member', id: admin.actor.kind === 'member' ? admin.actor.id : '' });
		expect(await history(id, admin, { revision: 2 })).toHaveLength(2);
		const masked = authority({ orders: grants({ history: [arm()], masks: { note: FALSE } }) });
		expect((await history(id, masked)).map((r) => r.changed['note'])).toEqual([{ $masked: true }, { $masked: true }, { $masked: true }]);
		expect(await history(id, authority({ orders: grants() }))).toEqual([]);
		// a grant that depends on the caller resolves its `{ actor }` operand against the reader, not the workspace
		const own = authority({ orders: grants({ history: [arm({ t: 'cmp', field: 'note', op: 'eq', arg: { actor: 'id' } })] }) });
		expect(await history(id, own)).toEqual([]);
		ok((await run({ verb: 'delete', input: { target: id } })).outcome);
		expect(await history(id, authority({ orders: grants({ history: [arm()] }) }))).toHaveLength(4);   // read: true sees a deleted row's
	});

	it('get(…, { revision }) folds the revisions into the full record as of that revision (L-BOLT-181)', async () => {
		const id = await order('desk');
		ok((await run({ verb: 'update', input: { target: id, set: { note: 'a' } } })).outcome);
		ok((await run({ verb: 'update', input: { target: id, set: { note: 'b' } } })).outcome);
		const at = (revision: number, reader: Authority = admin) => readHistory(db, manifest, { kind: 'history', collection: 'orders', id, at: { revision }, full: true },
			{ as: 'caller', authority: reader }, bindings) as Promise<{ [k: string]: Json } | null>;
		expect(await at(2)).toMatchObject({ id, revision: 2, title: 'desk', note: 'a' });
		expect(await at(3)).toMatchObject({ revision: 3, title: 'desk', note: 'b' });
		expect(await at(2, authority({ orders: grants({ history: [arm()], masks: { note: FALSE } }) }))).toMatchObject({ note: { $masked: true } });
		expect(await at(2, authority({ orders: grants() }))).toBeNull();
		await pruneHistory(db, 1);
		expect(await at(3)).toBeNull();   // the create is gone: nothing to fold from
	});

	it('`before: requestId` is the approval restore point', async () => {
		const id = await order('desk');
		expect((await run({ verb: 'update', input: { target: id, set: { note: 'held' } }, authority: routed('update') }, holding)).outcome).toMatchObject({ kind: 'pendingApproval' });
		expect((await history(id, admin, { before: REQUEST })).map((r) => r.revision)).toEqual([1]);
	});

	it('the prune keeps the newest revisions, every erased revision, and an open approval\'s restore point', async () => {
		const a = await order('a');
		for (const note of ['1', '2', '3']) ok((await run({ verb: 'update', input: { target: a, set: { note } } })).outcome);
		const held = await order('held');
		ok((await run({ verb: 'update', input: { target: held, set: { note: 'x' } }, authority: routed('update') }, holding)).outcome);
		const p = await person('p1', 'Ada');
		ok((await run({ collection: 'people', verb: 'erase', input: { target: p, set: { name: 'E' } } })).outcome);
		ok((await run({ collection: 'people', verb: 'update', input: { target: p, set: { email: 'e@x' } } })).outcome);
		expect(await pruneHistory(db, 1)).toBe(4);   // a: 1–3 go; people: the create goes
		const kept = await rows(`select collection, record::text r, revision, cause from bolt_history order by collection, record, revision`);
		expect(kept.filter((h) => h['r'] === a).map((h) => h['revision'])).toEqual([4]);
		expect(kept.filter((h) => h['r'] === held).map((h) => h['revision'])).toEqual([1, 2]);
		expect(kept.filter((h) => h['r'] === p).map((h) => h['cause'])).toEqual(['erased', 'direct']);
	});
});

describe('engine/write: import and export (rule 30)', () => {
	const imp = (input: Json, over: Partial<ActRequest> = {}) => run({ collection: 'people', verb: 'import', input, ...over });
	const report = (o: Outcome) => (ok(o) as unknown as { output: { rows: { index: number | null; action: string }[] } }).output.rows.map((r) => `${r.index}:${r.action}`);

	it('one act upserts every row and reports each; refuse and skip; onConflict is required on a keyed collection', async () => {
		count.writes = 0;
		expect(report((await imp({ rows: [{ code: 'p1', name: 'A' }], onConflict: 'update' })).outcome)).toEqual(['0:created']);
		expect(report((await imp({ rows: [{ code: 'p1', name: 'B' }, { code: 'p2', name: 'C' }], onConflict: 'update' })).outcome)).toEqual(['0:updated', '1:created']);
		expect(count.writes).toBe(2);
		expect((await imp({ rows: [{ code: 'p2', name: 'C' }, { code: 'p1', name: 'X' }], onConflict: 'refuse' })).outcome).toMatchObject({ code: 'unique', row: 0 });
		expect(report((await imp({ rows: [{ code: 'p1', name: 'Z' }, { code: 'p9', name: 'N' }], onConflict: 'update', onMissing: 'skip' })).outcome))
			.toEqual(['0:updated', '1:skipped']);
		expect(await rows(`select code, name from people order by code`)).toEqual([{ code: 'p1', name: 'Z' }, { code: 'p2', name: 'C' }]);
		expect((await imp({ rows: [{ code: 'p3', name: 'N' }] })).outcome).toMatchObject({ code: 'invalidInput', field: 'onConflict' });
	});

	it('prune deletes the absent keys inside its Where; dryRun writes nothing', async () => {
		ok((await imp({ rows: ['p1', 'p2', 'p3'].map((code) => ({ code, name: code })), onConflict: 'update' })).outcome);
		expect(report((await imp({ rows: [{ code: 'p1', name: 'p1' }], onConflict: 'keep', prune: { code: { in: ['p1', 'p2'] } } })).outcome))
			.toEqual(['0:kept', 'null:deleted']);
		expect((await rows(`select code from people order by code`)).map((r) => r['code'])).toEqual(['p1', 'p3']);
		count.writes = 0;
		expect(report((await imp({ rows: [{ code: 'p9', name: 'x' }], onConflict: 'update', dryRun: true })).outcome)).toEqual(['0:created']);
		expect(count.writes).toBe(0);
		expect(await one(`select (select count(*)::int from people) p, (select count(*)::int from bolt_idem) i`)).toEqual({ p: 2, i: 2 });
	});

	it('a ref accepts the target\'s key values', async () => {
		const id = await order('desk');
		ok((await run({ collection: 'receipts', verb: 'import', input: { rows: [{ memo: 'r', order: { title: 'desk' } }] } })).outcome);
		expect(await one(`select "order"::text o from receipts`)).toEqual({ o: id });
		expect((await run({ collection: 'receipts', verb: 'import', input: { rows: [{ memo: 'r', order: { title: 'nope' } }] } })).outcome)
			.toMatchObject({ code: 'notFound', field: 'order', row: 0 });
	});

	it('export is every row the caller reads, masked', async () => {
		await order('desk');
		await order('secret');
		ok((await run({ verb: 'update', input: { target: await order('chair'), set: { note: 'n' } } })).outcome);
		const caller = authority({ orders: grants({ read: [arm({ t: 'cmp', field: 'title', op: 'ne', arg: { lit: 'secret' } })], masks: { note: FALSE } }) });
		const reads = readEngine({ db, manifest });
		const out = await exportRows(reads.run, reads.catalog, 'orders', { select: { title: true, note: true }, orderBy: 'title' }, { as: 'caller', authority: caller }, bindings,
			async (r) => r);
		expect(out).toEqual([{ id: expect.any(String), title: 'chair', note: { $masked: true } }, { id: expect.any(String), title: 'desk', note: { $masked: true } }]);
	});
});

describe('engine/query: same-shape reads merge (rule 12)', () => {
	it('gets of one collection and select are one statement, answered in order', async () => {
		const [a, b] = [await order('a'), await order('b')];
		const missing = '0199a000-0000-7000-8000-0000000000ff';
		const reads = readEngine({ db, manifest });
		const get = (id: string, c = 'orders') => ({ kind: 'get' as const, collection: c, id, select: { fields: c === 'orders' ? ['title'] : null, relations: {} } });
		count.reads = 0; count.statements = 0;
		const out = await reads.run([get(b), get(a), get(missing), get(a, 'tags')], { as: 'workspace' }, bindings);
		expect(out).toEqual([{ id: b, title: 'b' }, { id: a, title: 'a' }, null, null]);
		expect(count).toMatchObject({ reads: 1, statements: 1 }); // the merged gets and the lone one compose into one statement
	});
});

describe('engine/write: relation actions and cascades (rules 28, 41)', () => {
	it('a relation-action upsert states its conflict rule: keep leaves the existing row, update takes it over', async () => {
		const [a, b] = [await order('a'), await order('b')];
		ok((await run({ verb: 'update', input: { target: a, set: { tags: { upsert: [{ name: 't' }] } } } })).outcome);
		const tag = String((await one(`select id::text from tags where name = 't'`))['id']);
		const tagOrder = async () => (await one(`select "order"::text o from tags where name = 't'`))['o'];
		ok((await run({ verb: 'update', input: { target: b, set: { tags: { upsert: [{ values: { id: tag }, onConflictDoUpdate: false }] } } } })).outcome);
		expect(await tagOrder()).toBe(a);
		ok((await run({ verb: 'update', input: { target: b, set: { tags: { upsert: [{ values: { id: tag }, onConflictDoUpdate: true }] } } } })).outcome);
		expect(await tagOrder()).toBe(b);
		expect((await run({ verb: 'update', input: { target: b, set: { tags: { upsert: [{ values: { id: tag }, onConflictDoUpdate: 'x' }] } } } })).outcome)
			.toMatchObject({ code: 'invalidInput' });
	});

	it('judges a nested id upsert as an update of the stored child', async () => {
		const [a, b] = [await order('a'), await order('b')];
		ok((await run({ verb: 'update', input: { target: a, set: { tags: { upsert: [{ name: 't' }] } } } })).outcome);
		const tag = String((await one(`select id::text from tags where name = 't'`))['id']);
		const caller = authority({ orders: grants(), tags: grants({ create: [arm(undefined, [])], update: [arm()] }) });
		ok((await run({ verb: 'update', input: { target: b, set: { tags: { upsert: [{ id: tag, name: 't' }] } } }, authority: caller })).outcome);
		expect((await one(`select "order"::text as id from tags where id = '${tag}'`))['id']).toBe(b);
	});

	it('a nested change to an owned child of a frozen parent is locked; an administrator still deletes the frozen parent with its children', async () => {
		const id = await order('desk', [{ label: 'a', amount: '1' }]);
		const [line] = await rows(`select id::text from lines`);
		ok((await run({ verb: 'update', input: { target: id, set: { status: 'submitted' } } })).outcome);
		expect((await run({ verb: 'update', input: { target: id, set: { lines: { update: [{ target: String(line!['id']), set: { amount: '2' } }] } } } })).outcome)
			.toMatchObject({ code: 'locked' });
		expect((await run({ verb: 'update', input: { target: id, set: { lines: { create: [{ label: 'b', amount: '1' }] } } } })).outcome).toMatchObject({ code: 'locked' });
		ok((await run({ verb: 'delete', input: { target: id } })).outcome);
		expect(await one(`select count(*)::int n from lines`)).toEqual({ n: 0 });
	});

	it('a nested delete of a child outside the caller\'s read scope is notFound', async () => {
		const id = await order('desk', [{ label: 'hidden', amount: '1' }]);
		const [line] = await rows(`select id::text from lines`);
		const caller = authority({ orders: grants(), lines: grants({ read: [arm({ t: 'cmp', field: 'label', op: 'ne', arg: { lit: 'hidden' } })] }) });
		expect((await run({ verb: 'update', input: { target: id, set: { lines: { delete: [String(line!['id'])] } } }, authority: caller })).outcome)
			.toMatchObject({ code: 'notFound' });
		expect(await one(`select count(*)::int n from lines`)).toEqual({ n: 1 });
	});

	it('delete: { transform: true } runs the transform as a guard for members; administrators skip it (rules 27, 35)', async () => {
		const calls: Invocation[] = [];
		const guard = transform(() => ({ kind: 'refused', message: 'the tag is in use', cpuMs: 1 }), 'tags', calls);
		const tag = idOf((await run({ collection: 'tags', verb: 'create', input: { name: 't' } })).outcome, 'tags');
		const member = authority({ tags: grants() });
		expect((await run({ collection: 'tags', verb: 'delete', input: { target: tag }, authority: member }, guard)).outcome)
			.toEqual({ kind: 'refused', code: 'refused', message: 'the tag is in use', rule: 'tags.transform' });
		expect(calls.map((c) => c.input)).toEqual([[{ $delete: true }]]);
		ok((await run({ collection: 'tags', verb: 'delete', input: { target: tag } }, guard)).outcome);
		expect(calls).toHaveLength(1);
	});
});

describe('engine/write: telemetry (§5.12)', () => {
	it('an act writes its events as a piece of its one statement; a refusal before guest code writes none', async () => {
		const lines: string[] = [];
		const log = () => new EventLog({ invocation: 'i' }, undefined, (l) => lines.push(l));
		count.writes = 0;
		ok((await run({ verb: 'create', input: { title: 'a' }, log: log() })).outcome);
		expect(count.writes).toBe(1);
		expect((await run({ verb: 'create', input: { title: 1 }, log: log() })).outcome).toMatchObject({ code: 'invalidInput' });
		expect(count.writes).toBe(1);
		const refusing = transform(() => ({ kind: 'refused', message: 'no', cpuMs: 1 }));
		expect((await run({ verb: 'create', input: { title: 'b' }, log: log() }, refusing)).outcome).toMatchObject({ code: 'refused' });
		expect(count.writes).toBe(2);
		expect(await rows(`select severity, event, attributes->>'callable' c from sys_event order by id`)).toEqual([
			{ severity: 'info', event: 'act.settled', c: 'orders.create' }, { severity: 'warn', event: 'act.refused', c: 'orders.create' }]);
		expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual(['act.settled', 'act.refused', 'act.refused']);
	});
});

describe('engine/write: pipeline order (rule 19)', () => {
	type Row = { name: string; expect: string; guest: boolean; writes: number; act: () => Promise<Outcome>; calls: Invocation[] };
	const refusing = (calls: Invocation[]) => transform(() => ({ kind: 'refused', message: 'guest', cpuMs: 1 }), 'orders', calls);
	const table: ((calls: Invocation[]) => Omit<Row, 'calls'> & { setup?: () => Promise<string> })[] = [
		(calls) => ({ name: 'rate admission before decode', expect: 'rateLimited', guest: false, writes: 0,
			act: async () => (await run({ verb: 'create', input: { title: 1 } }, { ...refusing(calls), admit: () => ({ retryAfter: 1 }) })).outcome }),
		(calls) => ({ name: 'expiry before decode', expect: 'expired', guest: false, writes: 0,
			act: async () => (await run({ verb: 'create', input: { title: 1 }, issuedAt: '2026-09-20T00:00:00.000Z' }, refusing(calls))).outcome }),
		(calls) => ({ name: 'decode before the caller', expect: 'invalidInput', guest: false, writes: 0,
			act: async () => (await run({ verb: 'create', input: { title: 1 }, authority: authority({}) }, refusing(calls))).outcome }),
		(calls) => ({ name: 'the caller before holds', expect: 'forbidden', guest: false, writes: 0,
			act: async () => (await run({ verb: 'update', input: { target: await heldOrder(), set: { note: 'x' } }, authority: authority({ orders: grants({ update: [] }) }) },
				{ ...refusing(calls), ...holding })).outcome }),
		(calls) => ({ name: 'holds before guest code', expect: 'approvalHeld', guest: false, writes: 0,
			act: async () => (await run({ verb: 'update', input: { target: await heldOrder(), set: { note: 'x' } }, authority: authority({ orders: grants() }) },
				{ ...refusing(calls), ...holding })).outcome }),
		(calls) => ({ name: 'the observed revision before guest code', expect: 'conflict', guest: false, writes: 0,
			act: async () => { const id = await order('o'); count.writes = 0; return (await run({ verb: 'update', input: { target: id, set: { note: 'x' } }, observed: { [id]: 7 } }, refusing(calls))).outcome; } }),
		(calls) => ({ name: 'guest code before the post-image scope', expect: 'refused', guest: true, writes: 1,
			act: async () => (await run({ verb: 'create', input: { title: 'x' }, authority: authority({ orders: grants({ create: [arm(FALSE)] }) }) }, refusing(calls))).outcome }),
		() => ({ name: 'the post-image scope before the approval route', expect: 'forbidden', guest: false, writes: 0,
			act: async () => (await run({ verb: 'create', input: { title: 'x' }, authority: authority({ orders: grants({ create: [{ ...arm(FALSE), approval: [{ steps: [['f']] }] }] }) }) },
				{ approval: { participant: () => false, route: () => { throw new Error('routed'); } } })).outcome }),
		() => ({ name: 'the approval route before the commit', expect: 'pendingApproval', guest: false, writes: 1,
			act: async () => (await run({ verb: 'create', input: { title: 'x' }, authority: routed('create') }, holding)).outcome }),
	];
	const heldOrder = async () => {
		const id = idOf((await run({ verb: 'create', input: { title: `held-${n}` }, authority: routed('create') }, holding)).outcome);
		count.writes = 0;
		return id;
	};
	for (const make of table) {
		const calls: Invocation[] = [];
		const row = make(calls);
		it(row.name, async () => {
			count.writes = 0;
			const o = await row.act();
			expect(o.kind === 'refused' ? o.code : o.kind).toBe(row.expect);
			expect(calls.length > 0).toBe(row.guest);
			expect(count.writes).toBe(row.writes);
		});
	}
});

describe('engine/write: guest failures (rules 42, 72a)', () => {
	it('a throw is internal, a budget keeps its code, a platform fault throws with its cause', async () => {
		const failing = (code: string) => transform(() => ({ kind: 'failed', error: new BoltError(code, 'guest', `${code}!`), cpuMs: 1 }));
		expect((await run({ verb: 'create', input: { title: 'a' } }, failing('guestError'))).outcome).toEqual({ kind: 'refused', code: 'internal', message: 'guestError!' });
		expect((await run({ verb: 'create', input: { title: 'a' } }, failing('cpuBudget'))).outcome).toEqual({ kind: 'refused', code: 'cpuBudget', message: 'cpuBudget!' });
		await expect(run({ verb: 'create', input: { title: 'a' } }, failing('missingBody'))).rejects.toMatchObject({ code: 'missingBody' });
	});
});

describe('engine/write: roll-ups against a re-select oracle (rule 21)', () => {
	it('every roll-up equals a fresh aggregate after any sequence of child and parent writes', async () => {
		let seed = 7;
		const rand = (k: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
		const AMOUNTS = ['0', '50', '99.99', '100', '150.5', '250'];
		const amount = () => AMOUNTS[rand(AMOUNTS.length)]!;
		const pick = async (sql: string) => { const r = await rows(sql); return r.length === 0 ? null : String(r[rand(r.length)]!['id']); };
		for (let step = 0; step < 40; step++) {
			const kind = rand(6);
			const o = await pick(`select id::text from orders order by id`);
			const l = await pick(`select id::text from lines order by id`);
			const lineOrder = l === null ? null : String((await one(`select "order"::text o from lines where id = '${l}'`))['o']);
			if (kind === 0 || o === null) await order(`o${step}`, Array.from({ length: rand(3) }, (_, i) => ({ label: `l${i}`, amount: amount() })));
			else if (kind === 1) ok((await run({ verb: 'update', input: { target: o, set: { lines: { create: [{ label: 'x', amount: amount() }] } } } })).outcome);
			else if (kind === 2 && l !== null) ok((await run({ collection: 'lines', verb: 'update', input: { target: l, set: { amount: amount() } } })).outcome);
			else if (kind === 3 && l !== null) ok((await run({ verb: 'update', input: { target: lineOrder!, set: { note: `s${step}`, lines: { delete: [l] } } } })).outcome);
			else if (kind === 4) ok((await run({ collection: 'lines', verb: 'create', input: { label: 'd', amount: amount(), order: o } })).outcome);
			else if (kind === 5 && rand(3) === 0) ok((await run({ verb: 'delete', input: { target: o } })).outcome);
			const drift = await rows(`select o.id from orders o where o.total <> coalesce((select sum(amount) from lines l where l."order" = o.id), 0)
				or o.big_lines <> (select count(*) from lines l where l."order" = o.id and l.amount >= 100)`);
			expect(drift, `step ${step} (kind ${kind})`).toEqual([]);
		}
	});
});
