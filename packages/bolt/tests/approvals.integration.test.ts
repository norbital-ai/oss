// engine/approvals on PGlite (rules 44–47; ported race/hold specs L-BOLT-104, 191–195, 201, 203, 205, 206): the hold,
// decisions, seal and restore through the real act pipeline. One guarantee per test.
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { ApprovalRoute, Authority, EngineActor, EngineManifest, Outcome, TenantDb } from '../src/engine/contracts.ts';
import { approvals, type Approvals } from '../src/engine/approvals/approvals.ts';
import { openPglite } from '../src/engine/db/pglite.ts';
import { readEngine } from '../src/engine/query/engine.ts';
import { readHistory } from '../src/engine/query/history.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { act, type ActRequest } from '../src/engine/write/act.ts';
import { admin, arm, authority, grants, manifest as base, member as anyMember, NOW, TODAY } from './write-fixture.ts';

const member = anyMember as Extract<EngineActor, { kind: 'member' }>;
const note = (title: string, to: readonly unknown[]) => [{ channel: 'inbox', to, title }];
const manifest: EngineManifest = { ...base, collections: { ...base.collections, orders: { ...base.collections['orders']!, notifications: {
	approvalStarted: note('Started', ['requestor']), approvalStepRequested: note('Awaiting your decision', ['step_approvers']),
	committed: note('Committed', ['requestor']), approvalConflicted: note('Conflicted', [{ team: 'Admins' }]), rejected: note('Rejected', ['requestor']),
} } } };
const ROUTES: readonly ApprovalRoute[] = [{ steps: [['Finance'], ['Leadership']], superceded_by: ['Leadership'] }];
const NOTE: readonly ApprovalRoute[] = [{ match: { changed: ['note'] }, steps: [['Finance']] }];
const person = (id: string, teamPath: string[]): Authority => ({
	...authority({ orders: grants({ create: [{ ...arm(), approval: ROUTES }], update: [{ ...arm(), approval: NOTE }] }) }),
	actor: { ...member, id, teamPath },
});
const sales = person('0199a000-0000-7000-8000-000000000001', ['Sales']);
const finance = person('0199a000-0000-7000-8000-000000000002', ['Finance']);
const lead = person('0199a000-0000-7000-8000-000000000003', ['Leadership']);
const ops = person('0199a000-0000-7000-8000-000000000004', ['Ops']);

let pg: PGlite, db: TenantDb, flows: Approvals, n = 0, writes = 0;
beforeEach(async () => {
	({ pg, db } = await openPglite());
	await applyPlan(db, plan(null, manifest), { accept: true });
	// L-BOLT-354: inbox notices fan out to members on file, so each person is a member of their team
	await pg.exec(`INSERT INTO sys_team (id, name) VALUES ('t-sales', 'Sales'), ('t-fin', 'Finance'), ('t-lead', 'Leadership'), ('t-ops', 'Ops'), ('t-adm', 'Admins');
		INSERT INTO sys_user (id, name, team) VALUES ${[[sales, 'Sal', 't-sales'], [finance, 'Fin', 't-fin'], [lead, 'Lea', 't-lead'], [ops, 'Ops', 't-ops'], [admin, 'Adm', 't-adm']]
		.map(([a, name, team]) => `('${((a as Authority).actor as { id: string }).id}', '${name}', '${team}')`).join(', ')}`);
	const inner = db;
	db = { ...inner, write: (s, l) => (writes++, inner.write(s, l)) };
	flows = approvals(manifest, db);
});
const run = (auth: Authority, over: Partial<ActRequest> & Pick<ActRequest, 'verb' | 'input'>) => act({ manifest, db, approval: flows.hook },
	{ collection: 'orders', key: `key-${n}`, issuedAt: NOW, authority: auth, bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} }, invocationId: `inv-${n++}`, ...over });
const rows = async (sql: string) => (await pg.query<Record<string, Json>>(sql)).rows;
const one = async (sql: string) => (await rows(sql))[0]!;
const pending = (o: Outcome) => { if (o.kind !== 'pendingApproval') throw new Error(JSON.stringify(o)); return o.requestId; };
const ok = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o.records.find((r) => r.collection === 'orders')?.id ?? ''; };
const decide = (requestId: string, auth: Authority, status: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE' | 'SUPERSEDED', reason?: string) =>
	flows.process({ requestId, status, authority: auth, now: NOW, ...(reason === undefined ? {} : { reason }) });
const titles = async () => (await rows(`select title from sys_notification order by title`)).map((r) => r['title']);

describe('approvals: the provisional commit (rule 45, L-BOLT-191)', () => {
	it('a routed create commits stamped in one statement, with a null hold, the request, its requestor and notices', async () => {
		writes = 0;
		const id = pending((await run(sales, { verb: 'create', input: { title: 'desk', lines: { create: [{ label: 'a', amount: '5' }] } } })).outcome);
		expect(writes).toBe(1);
		expect(await rows(`select approval_id::text a from orders union all select approval_id::text from lines`)).toEqual([{ a: id }, { a: id }]);
		expect(await rows(`select collection, changes from bolt_history where cause = 'hold' order by collection`)).toEqual([{ collection: 'lines', changes: null }, { collection: 'orders', changes: null }]);
		expect(await one(`select a.state, r.status, r.approver_teams, q.user_id from bolt_approvals a join approval_request r using (id) join requestor q on q.approval_request_id = r.id`))
			.toEqual({ state: 'Pending', status: 'ONGOING', approver_teams: ['finance'], user_id: '0199a000-0000-7000-8000-000000000001' });
		expect(await rows(`select recipient from sys_notification order by title`)).toEqual([
			{ recipient: { channel: 'inbox', recipients: [{ team: 'Finance' }] } }, { recipient: { channel: 'inbox', recipients: [{ user: (sales.actor as { id: string }).id }] } }]);
	});

	it('a routed update holds the full pre-image; a replay returns the recorded outcome and opens nothing (L-BOLT-201, 205)', async () => {
		const order = ok((await run(admin, { verb: 'create', input: { title: 'desk' } })).outcome);
		const first = await run(sales, { verb: 'update', input: { target: order, set: { note: 'x' } }, key: 'k' });
		const again = await run(sales, { verb: 'update', input: { target: order, set: { note: 'x' } }, key: 'k' });
		expect(again.outcome).toEqual(first.outcome);
		expect(await one(`select changes->>'note' note, changes->>'title' title from bolt_history where cause = 'hold'`)).toEqual({ note: null, title: 'desk' });
		expect(await one(`select count(*)::int n from bolt_approvals`)).toEqual({ n: 1 });
	});

	it('a write matching no route commits directly; an administrator never routes', async () => {
		const order = ok((await run(admin, { verb: 'create', input: { title: 'desk' } })).outcome);
		expect((await run(sales, { verb: 'update', input: { target: order, set: { title: 'chair' } } })).outcome.kind).toBe('committed');
		expect((await run(admin, { verb: 'update', input: { target: order, set: { note: 'x' } } })).outcome.kind).toBe('committed');
	});
});

describe('approvals: the hold (rule 46, L-BOLT-192)', () => {
	it('a non-participant write is refused approvalHeld; the requestor\'s write rides the request, stamped and hold-revisioned', async () => {
		const id = pending((await run(sales, { verb: 'create', input: { title: 'desk' } })).outcome);
		const [order] = await rows(`select id::text from orders`);
		const target = String(order!['id']);
		expect((await run(ops, { verb: 'update', input: { target, set: { title: 'x' } } })).outcome).toMatchObject({ code: 'approvalHeld' });
		expect((await run(sales, { verb: 'update', input: { target, set: { note: 'n', lines: { create: [{ label: 'b', amount: '1' }] } } } })).outcome)
			.toMatchObject({ kind: 'pendingApproval', requestId: id });
		expect(await one(`select (select count(*)::int from bolt_approvals) r, (select count(*)::int from bolt_history where cause = 'hold') h,
			(select approval_id::text from lines) l`)).toEqual({ r: 1, h: 3, l: id });
	});
});

describe('approvals: decisions and seal (rules 46, 47, L-BOLT-193, 104, 205)', () => {
	it('a two-step flow stays held after the first approval and seals on the last, once, with committed', async () => {
		const id = pending((await run(sales, { verb: 'create', input: { title: 'desk' } })).outcome);
		expect(await decide(id, lead, 'APPROVED')).toMatchObject({ code: 'forbidden' });
		expect(await decide(id, finance, 'APPROVED')).toEqual({ kind: 'decided', requestId: id, status: 'ONGOING' });
		expect(await one(`select approval_id::text a from orders`)).toEqual({ a: id });
		expect(await one(`select step, approver_teams from approval_request`)).toEqual({ step: 1, approver_teams: ['leadership'] });
		expect(await decide(id, lead, 'APPROVED')).toMatchObject({ status: 'APPROVED' });
		expect(await one(`select approval_id, (select applied_at is not null from approval_request) applied from orders`)).toEqual({ approval_id: null, applied: true });
		expect(await flows.seal(id, NOW)).toEqual({ sealed: false, records: [] });
		expect((await titles()).filter((t) => t === 'Committed')).toHaveLength(1);
	});

	it('two concurrent final decisions: exactly one lands, the other is no longer pending; racing resumes seal once', async () => {
		const id = pending((await run(sales, { verb: 'update', input: { target: ok((await run(admin, { verb: 'create', input: { title: 'd' } })).outcome), set: { note: 'x' } } })).outcome);
		const both = await Promise.all([decide(id, finance, 'APPROVED'), decide(id, finance, 'REJECTED')]);
		expect(both.map((d) => d.kind).sort()).toEqual(['conflict', 'decided']);
		expect(await decide(id, finance, 'APPROVED')).toMatchObject({ kind: 'conflict' });
		const seals = await Promise.all([flows.seal(id, NOW), flows.seal(id, NOW)]);
		expect(seals.filter((s) => s.sealed)).toHaveLength(0); // the decision's fast path already sealed or restored
	});

	it('supersede needs a superseder and a reason, and finishes every remaining step', async () => {
		const id = pending((await run(sales, { verb: 'create', input: { title: 'desk' } })).outcome);
		expect(await decide(id, finance, 'SUPERSEDED', 'why')).toMatchObject({ code: 'forbidden' });
		expect(await decide(id, lead, 'SUPERSEDED')).toMatchObject({ code: 'invalidInput', field: 'reason' });
		expect(await decide(id, lead, 'SUPERSEDED', 'urgent')).toMatchObject({ status: 'APPROVED' });
		expect(await one(`select approval_id from orders`)).toEqual({ approval_id: null });
	});
});

describe('approvals: restore (rule 47, L-BOLT-194, 195)', () => {
	it('reject restores an update, deletes rows born under the hold, re-inserts deleted rows and recomputes roll-ups', async () => {
		const order = ok((await run(admin, { verb: 'create', input: { title: 'desk', lines: { create: [{ label: 'a', amount: '10' }, { label: 'b', amount: '20' }] } } })).outcome);
		const before = await rows(`select label, amount::text, approval_id from lines order by label`);
		const [a, b] = (await rows(`select id::text from lines order by label`)).map((r) => String(r['id']));
		const id = pending((await run(sales, { verb: 'update', input: { target: order, set: { note: 'x' } } })).outcome);
		pending((await run(sales, { verb: 'update', input: { target: order, set: { note: 'y', lines: { update: [{ target: a!, set: { amount: '99' } }], delete: [b!], create: [{ label: 'c', amount: '1' }] } } } })).outcome);
		expect(await decide(id, finance, 'REJECTED')).toMatchObject({ status: 'REJECTED' });
		expect(await rows(`select label, amount::text, approval_id from lines order by label`)).toEqual(before);
		expect(await one(`select note, total::text, approval_id from orders`)).toEqual({ note: null, total: '30', approval_id: null });
		expect(await one(`select count(*)::int n from bolt_history where cause = 'restore'`)).toEqual({ n: 4 });
		expect(await flows.restore(id, NOW)).toBe('noop');
	});

	it('request-for-change needs a reason; withdraw is the requestor\'s; both restore', async () => {
		const id = pending((await run(sales, { verb: 'create', input: { title: 'desk' } })).outcome);
		expect(await decide(id, finance, 'REQUEST_FOR_CHANGE')).toMatchObject({ code: 'invalidInput' });
		expect(await flows.withdraw({ requestId: id, authority: finance, now: NOW })).toMatchObject({ code: 'forbidden' });
		expect(await flows.withdraw({ requestId: id, authority: sales, now: NOW })).toMatchObject({ status: 'WITHDRAWN' });
		expect(await one(`select count(*)::int n from orders`)).toEqual({ n: 0 });
	});

	it('a restore that cannot apply keeps the hold, marks CONFLICTED and notifies; a retry after the fix restores', async () => {
		const id = pending((await run(sales, { verb: 'create', input: { title: 'desk' } })).outcome);
		const [order] = await rows(`select id::text from orders`);
		await pg.query(`insert into tags (id, name, "order") values ('0199a000-0000-7000-8000-0000000000f1', 't', $1)`, [order!['id']]);
		expect(await decide(id, finance, 'REJECTED')).toMatchObject({ status: 'CONFLICTED' });
		expect(await one(`select (select approval_id::text from orders) a, (select status from approval_request) s`)).toEqual({ a: id, s: 'CONFLICTED' });
		expect(await titles()).toContain('Conflicted');
		await pg.query(`delete from tags`);
		expect(await flows.restore(id, NOW)).toBe('restored');
		expect(await one(`select (select count(*)::int from orders) n, (select status from approval_request) s`)).toEqual({ n: 0, s: 'REJECTED' });
	});
});

describe('approvals: participants read held rows (rule 13, L-BOLT-206)', () => {
	it('an approver of the open request reads the held row while open, not after', async () => {
		const id = pending((await run(sales, { verb: 'create', input: { title: 'desk' } })).outcome);
		const reads = readEngine({ db, manifest });
		const see = async (auth: Authority) => {
			const scoped: Authority = { ...auth, collections: { orders: grants({ read: [arm({ t: 'const', value: false }), arm(await flows.heldScope(auth))] }) } };
			return reads.run([{ kind: 'read', collection: 'orders', select: { fields: ['title'], relations: {} }, page: { limit: 10 } }], { as: 'caller', authority: scoped },
				{ now: NOW, today: TODAY, tz: 'UTC', params: {} });
		};
		expect(JSON.stringify(await see(finance))).toContain('desk');
		expect(JSON.stringify(await see(ops))).not.toContain('desk');
		await decide(id, lead, 'SUPERSEDED', 'go');
		expect(JSON.stringify(await see(finance))).not.toContain('desk');
	});
});

describe('approvals: seal and restore prove progress (rule 25a)', () => {
	const skip = async (event: 'UPDATE' | 'INSERT') => pg.exec(`CREATE OR REPLACE FUNCTION skip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
		CREATE TRIGGER skip BEFORE ${event} ON orders FOR EACH ROW EXECUTE FUNCTION skip();`);
	const held = async () => {
		const order = ok((await run(admin, { verb: 'create', input: { title: 'desk' } })).outcome);
		return pending((await run(sales, { verb: 'update', input: { target: order, set: { note: 'x' } } })).outcome);
	};

	it('a seal that clears none of its stamped rows seals nothing; its queued run records noProgress', async () => {
		const id = await held();
		await skip('UPDATE');
		expect(await decide(id, finance, 'APPROVED')).toMatchObject({ status: 'APPROVED' });
		expect(await one(`select a.sealed_at, o.approval_id::text a from bolt_approvals a, orders o`)).toEqual({ sealed_at: null, a: id });
		await expect(flows.handlers()['collections.resume']!({ requestId: id })).rejects.toMatchObject({ code: 'noProgress', phase: 'commit' });
		expect(await one(`select state from sys_run where key = '${id}:collections.resume'`)).toEqual({ state: 'queued' });
	});

	it('a restore that writes none of its held rows rolls back; its queued run records noProgress', async () => {
		const id = await held();
		await skip('INSERT');
		expect(await decide(id, finance, 'REJECTED')).toMatchObject({ status: 'REJECTED' });
		expect(await one(`select a.restored_at, o.note from bolt_approvals a, orders o`)).toEqual({ restored_at: null, note: 'x' });
		await expect(flows.handlers()['collections.discard']!({ requestId: id })).rejects.toMatchObject({ code: 'noProgress', phase: 'commit' });
	});
});

describe('approvals: the view and the decision log (§3.8, L-BOLT-484, 600)', () => {
	it('a participant or a reader of the held row sees the flow, each decision and what they may do; anyone else sees nothing', async () => {
		const id = pending((await run(sales, { verb: 'create', input: { title: 'desk' } })).outcome);
		const unread = async () => false;
		expect(await flows.view(id, ops, unread)).toBeNull();
		expect(await flows.view(id, ops, async () => true)).toMatchObject({ status: 'ONGOING', canDecide: false, canSupersede: false, participant: false, mine: false });
		expect(await flows.view(id, finance, unread)).toMatchObject({ steps: [['Finance'], ['Leadership']], superceded_by: ['Leadership'], step: 0,
			canDecide: true, canSupersede: false, participant: true, decisions: [], collection: 'orders', action: 'create' });
		await decide(id, finance, 'APPROVED', 'fine');
		expect(await flows.view(id, sales, unread)).toMatchObject({ step: 1, mine: true, canDecide: false,
			decisions: [{ step: 0, status: 'APPROVED', reason: 'fine', by: { ref: `member:${(finance.actor as { id: string }).id}`, name: 'Fin' } }] });
		await decide(id, lead, 'SUPERSEDED', 'go');
		const done = await flows.view(id, sales, unread);
		expect(done!.decisions.map((d) => [d.step, d.status])).toEqual([[0, 'APPROVED'], [1, 'SUPERSEDED']]);
		expect(done).toMatchObject({ status: 'APPROVED', canDecide: false, participant: false });
		expect(done!.appliedAt).not.toBeNull();
	});

	it('lists the requests a caller may see: open ones by collection or record, closed ones on asking', async () => {
		const first = pending((await run(sales, { verb: 'create', input: { title: 'desk' } })).outcome);
		const second = pending((await run(sales, { verb: 'create', input: { title: 'lamp' } })).outcome);
		const unread = async () => false;
		expect((await flows.list({ collection: 'orders' }, finance, unread)).map((v) => v.id).toSorted()).toEqual([second, first].toSorted());
		expect(await flows.list({ collection: 'orders' }, ops, unread)).toEqual([]);
		expect(await flows.list({ collection: 'invoices' }, finance, unread)).toEqual([]);
		const [view] = await flows.list({ ids: [first] }, finance, unread);
		expect(view).toMatchObject({ id: first, status: 'ONGOING', canDecide: true, requestor: { name: 'Sal' } });
		const record = view!.record;
		expect((await flows.list({ records: [record] }, finance, unread)).map((v) => v.id)).toEqual([first]);
		await decide(first, finance, 'REJECTED');
		expect((await flows.list({ collection: 'orders' }, sales, unread)).map((v) => v.id)).toEqual([second]);
		expect((await flows.list({ collection: 'orders', all: true }, sales, unread)).map((v) => v.id).toSorted()).toEqual([first, second].toSorted());
	});

	it('a final decision is one write statement with its seal or its restore (rule 20)', async () => {
		const inner = db, statements: string[] = [];
		const counted = (s: { text: string }) => { if (!/^\s*SELECT/i.test(s.text)) statements.push(s.text.slice(0, 40)); };
		db = { ...inner, write: (s, l) => (counted(s), inner.write(s, l)),
			transaction: (body, lock) => inner.transaction((tx) => body({ ...tx, query: (s) => (counted(s), tx.query(s)) }), lock) };
		flows = approvals(manifest, db);
		const order = ok((await run(admin, { verb: 'create', input: { title: 'desk' } })).outcome);
		const held = pending((await run(sales, { verb: 'update', input: { target: order, set: { note: 'x' } } })).outcome);
		statements.length = 0;
		expect(await decide(held, finance, 'REJECTED')).toMatchObject({ status: 'REJECTED' });
		expect(statements).toHaveLength(1);
		expect(await one(`select note, approval_id from orders`)).toEqual({ note: null, approval_id: null });
		expect(await flows.restore(held, NOW)).toBe('noop');
		const again = pending((await run(sales, { verb: 'update', input: { target: order, set: { note: 'y' } } })).outcome);
		statements.length = 0;
		expect(await decide(again, finance, 'APPROVED')).toMatchObject({ status: 'APPROVED' });
		expect(statements).toHaveLength(1);
		expect(await one(`select note, approval_id, (select applied_at is not null from approval_request where id = '${again}') applied from orders`))
			.toEqual({ note: 'y', approval_id: null, applied: true });
		expect(await one(`select count(*)::int n from sys_run`)).toEqual({ n: 0 });
	});
});

describe('approvals: history of a record created under approval (rule 17)', () => {
	it('a held create, approved, reads its history: the hold revision is skipped (L-BOLT-185)', async () => {
		const id = pending((await run(sales, { verb: 'create', input: { title: 'desk' } })).outcome);
		expect(await decide(id, finance, 'APPROVED')).toMatchObject({ status: 'ONGOING' });
		expect(await decide(id, lead, 'APPROVED')).toMatchObject({ status: 'APPROVED' });
		const order = String((await one(`select id::text from orders`))['id']);
		const history = await readHistory(db, manifest, { kind: 'history', collection: 'orders', id: order }, { as: 'caller', authority: admin }, { now: NOW, today: TODAY, tz: 'UTC', params: {} }) as { cause: string; changed: object }[];
		expect(history.length).toBeGreaterThan(0);
		expect(history.map((h) => h.cause)).not.toContain('hold');
	});
});
