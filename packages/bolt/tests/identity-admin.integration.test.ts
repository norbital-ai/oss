// Member administration beyond the basics (rules 38c, 39, §5.11.3): team rename and delete, invitation resend, a
// previewed team's Authority, and the membership projection (`bolt.membership` queued in the verb's statement only
// when the host binds the port, and handed to the port by its platform run).
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateWindows } from '../src/engine/access/rate.ts';
import type { Json } from '../src/decl/values.ts';
import { DbError, type EngineManifest, type Lock, type MembershipPort, type Rows, type Sql, type TenantDb, type TransportPort } from '../src/engine/contracts.ts';
import { Authorities, previewAs } from '../src/engine/identity/actor.ts';
import { eraseUser } from '../src/engine/identity/erase.ts';
import {
	assign, assignTeam, createTeam, deactivate, deleteTeam, invite, membershipRun, reactivate, renameTeam, resendInvitation, setAdmin
} from '../src/engine/identity/members.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { founderBootstrap, loadKeys, sendCode, verifyCode, type IdentityHost } from '../src/engine/identity/session.ts';

const json = (v: unknown): Json => v instanceof Date ? v.toISOString() : v as Json;
const rows = (r: { rows: unknown[]; affectedRows?: number }): Rows =>
	({ rows: r.rows.map((row) => Object.fromEntries(Object.entries(row as object).map(([k, v]) => [k, json(v)]))), affected: r.affectedRows ?? 0 });
function tenantDb(pg: PGlite): TenantDb {
	const run = async (tx: Pick<PGlite, 'query'>, s: Sql) => {
		try { return rows(await tx.query(s.text, s.params as unknown[])); } catch (e) {
			const x = e as { code?: string; constraint?: string; message: string };
			throw new DbError(x.code ?? 'XX000', x.message, x.constraint);
		}
	};
	const locked = async (tx: Pick<PGlite, 'query'>, lock?: Lock) => {
		for (const key of lock?.advisory ?? []) await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
	};
	return {
		read: (ss) => Promise.all(ss.map((s) => run(pg, s))),
		write: (s, lock) => pg.transaction(async (tx) => { await locked(tx, lock); return run(tx, s); }),
		transaction: (body, lock) => pg.transaction(async (tx) => { await locked(tx, lock); return body({ query: (s) => run(tx, s) }); }),
	};
}

const m = {
	workspace: { tz: 'UTC', locale: 'en' }, models: {}, relationships: {}, collections: {}, integrations: {}, pipelines: {},
	policies: { sales: { description: '', grants: {} }, field: { description: '', grants: {} }, finance: { description: '', grants: {} } },
	teams: { Sales: ['sales'], Field: ['field'] }, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
	agent: { skills: {} },
} as unknown as EngineManifest;

let pg: PGlite, db: TenantDb, h: IdentityHost, bound: IdentityHost;
const clock = Date.parse('2026-09-25T00:00:00Z');
let now = clock;
const outbox: { to: string; text: string }[] = [];
const mail: TransportPort = { send: async (_c, msg) => { outbox.push(msg as { to: string; text: string }); return { providerId: 'x' }; }, subscribe: () => () => {} };
const announced: string[] = [];
const one = async (text: string, ...params: Json[]) => (await db.read([{ text, params }]))[0]!.rows;
const authorities = new Authorities(m, 'r1');
const as = async (user: string) => (await authorities.member(db, user))!;
const projected = () => one(`SELECT input FROM sys_run WHERE automation = 'bolt.membership' ORDER BY due_at, id`);
/** Each verb at its own instant, so the queued runs order by `due_at`. */
const later = () => { now += 1_000; };
let founder = '';

beforeAll(async () => {
	pg = new PGlite();
	db = tenantDb(pg);
	await applyPlan(db, plan(null, m), { accept: true });   // the built-in layer's tables and the engine's private ones
	h = { db, now: () => new Date(now), windows: new RateWindows(), keys: await loadKeys(db), mail, publicUrl: 'https://acme.example' };
	bound = { ...h, membership: { announce: (at) => void announced.push(at) } };
	const f = await founderBootstrap(h, 'boss@acme.example');
	founder = f.ok ? f.value.user : '';
});
afterAll(() => pg.close());

describe('team rename and delete (rule 38c)', () => {
	it('a rename moves the team policies with the new name; a taken name and a non-admin are refused', async () => {
		const boss = await as(founder);
		const t = await createTeam(h, boss, 'Sales');
		const team = t.ok ? t.value.id : '';
		await assignTeam(h, boss, founder, team);
		expect((await createTeam(h, boss, 'Other')).ok).toBe(true);
		expect(await renameTeam(h, boss, team, 'Other')).toMatchObject({ ok: false, code: 'check' });
		expect(await renameTeam(h, boss, 'nope', 'X')).toMatchObject({ ok: false, code: 'notFound' });
		expect((await renameTeam(h, boss, team, 'Field')).ok).toBe(true);
		const p = await previewAs(await as(founder), authorities, db, { team });
		expect(p.authority.policies).toEqual(['field']);   // `+team.ts` matches the new name
		await pg.query(`INSERT INTO sys_user (id, email, name, kind) VALUES ('ext1', 'e@x.example', 'Ext', 'external')`);
		expect(await renameTeam(h, await as('ext1'), team, 'Y')).toMatchObject({ ok: false, code: 'forbidden' });
		await assignTeam(h, boss, founder, null);
	});

	it('a delete lifts sub-teams to its parent, clears members and invitations, drops its assignments, and keeps history', async () => {
		const boss = await as(founder);
		const id = async (name: string, parent: string | null = null) => { const r = await createTeam(h, boss, name, parent); return r.ok ? r.value.id : ''; };
		const top = await id('Ops'), mid = await id('Region', top), leaf = await id('Depot', mid);
		await assignTeam(h, boss, founder, mid);
		await invite(h, m, boss, { email: 'depot@acme.example', team: mid });
		await assign(h, m, boss, { type: 'sys_team', id: mid }, 'finance');
		expect((await deleteTeam(h, boss, mid)).ok).toBe(true);
		expect(await one('SELECT parent FROM sys_team WHERE id = $1', leaf)).toEqual([{ parent: top }]);
		expect(await one('SELECT count(*)::int AS n FROM sys_team WHERE id = $1', mid)).toEqual([{ n: 0 }]);
		expect(await one('SELECT team FROM sys_user WHERE id = $1', founder)).toEqual([{ team: null }]);
		expect(await one(`SELECT team FROM sys_invitation WHERE email = 'depot@acme.example'`)).toEqual([{ team: null }]);
		expect(await one(`SELECT count(*)::int AS n FROM sys_assignment WHERE principal_type = 'sys_team' AND principal = $1`, mid)).toEqual([{ n: 0 }]);
		expect(await one(`SELECT op FROM bolt_history WHERE collection = 'sys_team' AND record::text = $1 ORDER BY revision DESC LIMIT 1`, mid)).toEqual([{ op: 'delete' }]);
		expect(await deleteTeam(h, boss, mid)).toMatchObject({ ok: false, code: 'notFound' });
	});
});

describe('invitation resend (rule 38c)', () => {
	it('an open or expired invitation gets a fresh expiry and its notice again; an accepted one is refused', async () => {
		const boss = await as(founder);
		const inv = await invite(h, m, boss, { email: 'late@acme.example' });
		const id = inv.ok ? inv.value.id : '';
		now = clock + 8 * 86_400_000;   // past the 7-day expiry
		const sent = outbox.length;
		expect((await resendInvitation(h, boss, id)).ok).toBe(true);
		expect(outbox.length).toBe(sent + 1);
		expect(outbox.at(-1)).toMatchObject({ to: 'late@acme.example' });
		expect(Date.parse(String((await one('SELECT expires_at FROM sys_invitation WHERE id = $1', id))[0]!['expires_at']))).toBe(now + 7 * 86_400_000);
		await pg.query('UPDATE sys_invitation SET accepted_at = now() WHERE id = $1', [id]);
		expect(await resendInvitation(h, boss, id)).toMatchObject({ ok: false, code: 'notFound' });
		expect(await resendInvitation(h, await as('ext1'), id)).toMatchObject({ ok: false, code: 'forbidden' });
	});
});

describe('preview as a team (rule 39)', () => {
	it('holds the team policies and assignments, never admin; admin-only; an unknown team is notFound', async () => {
		const boss = await as(founder);
		const t = await createTeam(h, boss, 'Sales');
		const team = t.ok ? t.value.id : '';
		await assign(h, m, boss, { type: 'sys_team', id: team }, 'finance');
		const p = await previewAs(boss, authorities, db, { team });
		expect([...p.authority.policies].sort()).toEqual(['finance', 'sales']);
		expect(p.authority).toMatchObject({ admin: false, actor: { kind: 'member', id: founder, admin: false, teams: [team], teamPath: ['Sales'] }, teamTree: [team] });
		expect(p.authority.key.startsWith('preview:')).toBe(true);   // never links a channel handle (rule 39)
		expect(p.impersonatedBy).toBe(founder);
		await expect(previewAs(boss, authorities, db, { team: 'nope' })).rejects.toMatchObject({ code: 'notFound' });
		await expect(previewAs(await as('ext1'), authorities, db, { team })).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('membership projection (§5.11.3)', () => {
	it('no port bound: lifecycle verbs queue nothing', async () => {
		await pg.query('DELETE FROM sys_run');
		const boss = await as(founder);
		await deactivate(h, boss, 'ext1');
		await reactivate(h, boss, 'ext1');
		expect(await projected()).toEqual([]);
	});

	it('bound: acceptance, deactivation, reactivation, a team change and erase each queue one run in their statement', async () => {
		const boss = await as(founder);
		announced.length = 0;
		const inv = await invite(bound, m, boss, { email: 'new@acme.example' });
		expect(inv.ok).toBe(true);
		await sendCode(bound, 'new@acme.example', '5.5.5.5');
		const s = await verifyCode(bound, 'new@acme.example', /(\d{6})/.exec(outbox.at(-1)!.text)![1]!, '5.5.5.5');
		const user = s.ok ? s.value.user : '';
		const t = await createTeam(bound, boss, 'Crew');
		const team = t.ok ? t.value.id : '';
		later();
		expect((await assignTeam(bound, boss, user, team)).ok).toBe(true);
		later();
		expect((await deactivate(bound, boss, user)).ok).toBe(true);
		later();
		expect((await reactivate(bound, boss, user)).ok).toBe(true);
		later();
		expect((await deactivate(bound, boss, user)).ok).toBe(true);
		later();
		expect((await eraseUser(bound, boss, user)).ok).toBe(true);
		expect((await projected()).map((r) => r['input'])).toEqual([
			{ user, email: 'new@acme.example', phone: null, team: null, state: 'active' },
			{ user, email: 'new@acme.example', phone: null, team, state: 'active' },
			{ user, email: 'new@acme.example', phone: null, team, state: 'inactive' },
			{ user, email: 'new@acme.example', phone: null, team, state: 'active' },
			{ user, email: 'new@acme.example', phone: null, team, state: 'inactive' },
			{ user, email: null, phone: null, team: null, state: 'erased' },
		]);
		expect(announced.length).toBe(6);
		// an admin flag change is not a lifecycle change
		await pg.query(`DELETE FROM sys_run`);
		await pg.query(`INSERT INTO sys_user (id, email, name) VALUES ('staff2', 's2@acme.example', 'S2')`);
		expect((await setAdmin(bound, boss, 'staff2', true)).ok).toBe(true);
		expect(await projected()).toEqual([]);
	});

	it('the platform run hands the input to the port; a port failure fails the run', async () => {
		const seen: Json[] = [];
		const port: MembershipPort = { project: async (member) => { seen.push(member as unknown as Json); } };
		const input = { user: 'u1', email: 'a@b.example', team: null, state: 'active' };
		expect(await membershipRun(port)(input)).toBeNull();
		expect(seen).toEqual([input]);
		const broken: MembershipPort = { project: async () => { throw new Error('directory down'); } };
		await expect(membershipRun(broken)(input)).rejects.toMatchObject({ code: 'upstream', message: 'directory down' });
	});
});
