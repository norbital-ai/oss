// The shell host's administration surface over HTTP on PGlite: the environment badge and host notice in the boot,
// `access.explain`, preview-as a team (rule 39), members ordered admins first, the audit view newest first, team
// rename and delete, and invitation resend through the settings verbs.
import { beforeAll, describe, expect, it } from 'vitest';
import type { EngineManifest, TransportPort } from '../src/engine/contracts.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { founderBootstrap, loadKeys, type IdentityHost } from '../src/engine/identity/session.ts';
import { boltHandler } from '../src/protocol/http.ts';
import { devTurnstile, shellHost } from '../src/shell/host.ts';
import type { Settings } from '../src/shell/data.ts';
import type { ShellBoot } from '../src/shell/nav.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', apps: ['sales'] },
	models: { openings: { description: 'Roles', label: 'title', fields: { title: { kind: 'text' } } } },
	relationships: {}, collections: { openings: { read: { fields: 'all' } } }, integrations: {}, pipelines: {},
	policies: { rep: { description: 'Rep', capabilities: { apps: ['sales'] }, grants: { openings: { read: true } } } },
	apps: { sales: { title: 'Sales', description: 'd', icon: 'i', pages: { deals: { title: 'Deals' } } } },
	teams: { Sales: ['rep'] }, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, customFields: {},
	agent: { skills: {} },
} as unknown as EngineManifest;

let t: TestWorkspace;
let handle: (r: Request) => Promise<Response>;
const mailbox: { to: string; text: string }[] = [];
const ORIGIN = 'https://acme.example';
type Jar = Map<string, string>;
async function call(j: Jar, method: string, path: string, body?: unknown) {
	const cookie = [...j].map(([k, v]) => `${k}=${v}`).join('; ');
	const res = await handle(new Request(`${ORIGIN}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
	for (const c of res.headers.getSetCookie()) {
		const [k, v] = c.split(';')[0]!.split('=') as [string, string];
		if (/Max-Age=0/.test(c)) j.delete(k); else j.set(k, v);
	}
	const text = await res.text();
	return { status: res.status, body: text === '' ? null : JSON.parse(text) as { value?: unknown; error?: { code: string } } };
}
async function signIn(email: string): Promise<Jar> {
	const j: Jar = new Map();
	await call(j, 'POST', '/__bolt/session/code', { address: email });
	expect((await call(j, 'POST', '/__bolt/session/verify', { address: email, code: '123456' })).status).toBe(200);
	return j;
}
const op = (j: Jar, name: string, input: unknown) => call(j, 'POST', '/__bolt/shell/settings', { op: name, input });
const settings = async (j: Jar) => (await call(j, 'GET', '/__bolt/shell/settings')).body!.value as Settings;
const boot = async (j: Jar) => (await call(j, 'GET', '/__bolt/shell')).body!.value as ShellBoot;

beforeAll(async () => {
	t = await testWorkspace({ manifest });
	const mail: TransportPort = { send: async (_c, msg) => { mailbox.push(msg as { to: string; text: string }); return { providerId: 'x' }; }, subscribe: () => () => {} };
	const identity: IdentityHost = { db: t.db, now: () => new Date(t.clock.now()), windows: new RateWindows(), keys: await loadKeys(t.db), mail, devSink: true, publicUrl: ORIGIN };
	const shell = shellHost({ manifest, identity, authorities: new Authorities(manifest, 'test'), workspace: { name: 'Acme', handle: 'acme' }, ip: () => '203.0.113.9',
		turnstile: devTurnstile, environment: 'staging',
		notice: async (a) => a.admin ? { text: 'Your trial ends in 3 days.', tone: 'warning', href: '/billing', action: 'Upgrade' } : null });
	const bolt = boltHandler({ engine: t.engine, session: shell.authority, uuid: () => crypto.randomUUID(),
		bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	handle = async (r) => (await shell.handle(r)) ?? (await bolt(r)) ?? new Response(null, { status: 404 });
	expect((await founderBootstrap(identity, 'boss@acme.example')).ok).toBe(true);
});

describe('shell administration', () => {
	let admin: Jar, rep: Jar, teamId = '';

	it('the boot carries the environment badge and the host notice for whom it applies', async () => {
		admin = await signIn('boss@acme.example');
		const b = await boot(admin);
		expect(b.workspace.environment).toBe('staging');
		expect(b.notice).toEqual({ text: 'Your trial ends in 3 days.', tone: 'warning', href: '/billing', action: 'Upgrade' });
		const team = await op(admin, 'createTeam', { name: 'Sales' });
		teamId = (team.body!.value as { id: string }).id;
		await op(admin, 'invite', { email: 'rep@acme.example', team: teamId });
		rep = await signIn('rep@acme.example');
		expect((await boot(rep)).notice).toBeUndefined();
	});

	it('explain answers the caller’s own grants; another member’s or team’s only for an administrator', async () => {
		const own = (await call(rep, 'GET', '/__bolt/shell/explain')).body!.value as { policies: string[]; admin: boolean; collections: object; key?: string };
		expect(own).toMatchObject({ policies: ['rep'], admin: false, capabilities: { apps: ['sales'] } });
		expect(own.collections).toHaveProperty('openings');
		expect(own.key).toBeUndefined();
		expect((await call(rep, 'GET', `/__bolt/shell/explain?team=${teamId}`)).status).toBe(403);
		expect((await call(admin, 'GET', `/__bolt/shell/explain?team=${teamId}`)).body!.value).toMatchObject({ policies: ['rep'], admin: false });
		expect((await call(admin, 'GET', '/__bolt/shell/explain?team=nope')).status).toBe(404);
	});

	it('an administrator previews as a team: its grants apply, the administrator flag clears, and it ends', async () => {
		expect((await call(rep, 'POST', '/__bolt/shell/preview', { team: teamId })).status).toBe(403);
		expect((await call(admin, 'POST', '/__bolt/shell/preview', { team: teamId })).status).toBe(204);
		const b = await boot(admin);
		expect(b).toMatchObject({ admin: false, preview: { team: teamId }, surfaces: { settings: false } });
		expect(b.nav.map((n) => n.name)).toEqual(['sales']);
		expect((await call(admin, 'POST', '/__bolt/shell/preview', { team: null })).status).toBe(204);
		expect(await boot(admin)).toMatchObject({ admin: true, preview: null });
	});

	it('members list administrators first; the audit reads newest first; teams rename and delete; invitations resend', async () => {
		await t.db.write({ text: `INSERT INTO sys_user (id, email, name, kind) VALUES ('ext1', 'aa@partner.example', 'Aaron', 'external')`, params: [] });
		const s = await settings(admin);
		const ours = ['boss@acme.example', 'rep@acme.example', 'aa@partner.example'];
		expect(s.members.map((u) => u['email']).filter((e) => ours.includes(String(e)))).toEqual(ours);
		expect(s.audit.length).toBeGreaterThan(0);
		const at = s.audit.map((e) => Date.parse(e.at));
		expect(at).toEqual([...at].sort((a, b) => b - a));
		expect((await op(admin, 'renameTeam', { id: teamId, name: 'Field' })).status).toBe(200);
		expect((await settings(admin)).teams.map((x) => x['name'])).toEqual(['Field']);
		expect((await op(rep, 'renameTeam', { id: teamId, name: 'X' })).status).toBe(403);
		const inv = await op(admin, 'invite', { email: 'later@acme.example' });
		const invId = (inv.body!.value as { id: string }).id;
		const sent = mailbox.length;
		expect((await op(admin, 'resendInvitation', { id: invId })).status).toBe(200);
		expect(mailbox.slice(sent)).toMatchObject([{ to: 'later@acme.example' }]);
		expect((await op(admin, 'deleteTeam', { id: teamId })).status).toBe(200);
		const after = await settings(admin);
		expect(after.teams).toEqual([]);
		expect(after.members.find((u) => u['email'] === 'rep@acme.example')!['team']).toBeNull();
		expect(after.audit.filter((e) => e.at === after.audit[0]!.at)).toContainEqual(expect.objectContaining({ collection: 'sys_team', op: 'delete' }));
		expect((await op(admin, 'deleteTeam', {})).body!.error!.code).toBe('check');
	});
});
