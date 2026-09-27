// The shell's host half over HTTP on PGlite (§5.10, §5.11, rules 38a, 38d, 39): sign-in and sign-out, the boot,
// settings as an administrator only, preview-as, the inbox, the PWA manifest, and a visitor applying through the
// public careers page with a Turnstile token, composed in front of `boltHandler` as a host mounts them.
import { beforeAll, describe, expect, it } from 'vitest';
import type { EngineManifest, TransportPort } from '../src/engine/contracts.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { founderBootstrap, loadKeys, type IdentityHost } from '../src/engine/identity/session.ts';
import { boltHandler } from '../src/protocol/http.ts';
import { Chain, noticeInsert } from '../src/engine/write/sql.ts';
import { devTurnstile, shellHost } from '../src/shell/host.ts';
import type { ShellBoot } from '../src/shell/nav.ts';
import type { StudioOp, StudioPort, StudioState } from '../src/shell/studio.ts';
import { BoltError } from '../src/engine/contracts.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const OPEN = '0199a000-0000-4000-8000-00000000000a';
const manifest = {
	workspace: { tz: 'UTC', locale: 'en', apps: ['sales'] },
	models: {
		openings: { description: 'Roles', label: 'title', fields: { title: { kind: 'text' }, status: { kind: 'enum', values: ['open', 'closed'] } } },
		applications: { description: 'Applications', label: 'name', fields: { name: { kind: 'text' } } },
	},
	relationships: { 'applications.opening': { to: 'openings', inverse: 'applications' } },
	collections: { openings: { read: { fields: 'all' } }, applications: { read: { fields: 'all' }, create: { input: { columns: ['opening', 'name'] } } } },
	integrations: {}, pipelines: {},
	policies: {
		applicant: { description: 'Apply', grants: { openings: { read: { where: { status: { eq: 'open' } }, fields: ['title'] } },
			applications: { create: { opening: { is: { status: { eq: 'open' } } } } } } },
		rep: { description: 'Rep', capabilities: { apps: ['sales'] }, grants: { openings: { read: true } } },
	},
	apps: {
		sales: { title: 'Sales', description: 'd', icon: 'i', pages: { deals: { title: 'Deals' } } },
		careers: { title: 'Careers', description: 'Jobs', icon: 'i', audience: { public: ['applicant'], challenge: 'turnstile' }, pages: { apply: { title: 'Apply' } } },
	},
	teams: { Sales: ['rep'] }, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, customFields: {},
	agent: { internal: 'You help.', skills: {} },
} as unknown as EngineManifest;

let t: TestWorkspace;
// a host's Studio: one workbench head; a save over a stale head is refused
const sources = ['src/data/collection/openings/+collection.ts', 'src/data/collection/applications/+collection.ts', 'src/access/+applicant.policy.ts',
	'src/access/+rep.policy.ts', 'src/app/sales/+app.ts', 'src/app/careers/+app.ts'];
const studioState: StudioState = { commit: 'c2', files: { 'src/a.ts': 'x', ...Object.fromEntries(sources.map((p) => [p, ''])) }, changes: [], manifest, log: [], preview: null,
	releases: [{ commit: 'c2', at: '2026-09-25T00:00:00Z', message: 'two', current: true }, { commit: 'c1', at: '2026-09-24T00:00:00Z', message: 'one', current: false }] };
const studioOps: StudioOp[] = [];
// the host's branding port (L-COL-199): what an administrator wrote
const branded: { name: string; logo: string | null }[] = [];
const studio: StudioPort = {
	state: async () => studioState,
	run: async (_auth, op) => {
		if (op.op === 'save' && op.expected !== studioState.commit) throw new BoltError('conflict', 'decode', 'The workbench moved; reload it.');
		studioOps.push(op);
		return studioState;
	},
	watch: (_auth, send) => {
		send({ kind: 'log', line: { at: 't', level: 'info', message: 'build started' } });
		return () => {};
	},
};
let handle: (r: Request) => Promise<Response>;
const mailbox: { to: string; text: string }[] = [];
const ORIGIN = 'https://acme.example';

type Jar = Map<string, string>;
const jar = (): Jar => new Map();
async function call(j: Jar, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
	const cookie = [...j].map(([k, v]) => `${k}=${v}`).join('; ');
	const res = await handle(new Request(`${ORIGIN}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
	for (const c of res.headers.getSetCookie()) {
		const [pair] = c.split(';');
		const [k, v] = pair!.split('=') as [string, string];
		if (/Max-Age=0/.test(c)) j.delete(k); else j.set(k, v);
	}
	const text = await res.text();
	return { status: res.status, body: text === '' ? null : JSON.parse(text) as { value?: unknown; error?: { code: string } } & Record<string, unknown>, headers: res.headers };
}
async function signIn(email: string): Promise<Jar> {
	const j = jar();
	expect((await call(j, 'POST', '/__bolt/session/code', { email })).status).toBe(200);
	const v = await call(j, 'POST', '/__bolt/session/verify', { email, code: '123456' });
	expect(v.status).toBe(200);
	expect(j.has('nb_s')).toBe(true);
	return j;
}
const boot = async (j: Jar, app?: string) => {
	const r = await call(j, 'GET', `/__bolt/shell${app === undefined ? '' : `?app=${app}`}`);
	return { status: r.status, boot: r.body?.value as ShellBoot };
};

beforeAll(async () => {
	t = await testWorkspace({ manifest, seed: { openings: [{ id: OPEN, title: 'Engineer', status: 'open' }] } });
	const mail: TransportPort = { send: async (_c, msg) => { mailbox.push(msg as { to: string; text: string }); return { providerId: 'x' }; }, subscribe: () => () => {} };
	const identity: IdentityHost = { db: t.db, now: () => new Date(t.clock.now()), windows: new RateWindows(), keys: await loadKeys(t.db), mail, devSink: true, publicUrl: ORIGIN };
	const authorities = new Authorities(manifest, 'test');
	const shell = shellHost({ manifest, identity, authorities, workspace: { name: 'Acme', handle: 'acme' }, ip: () => '203.0.113.9', turnstile: devTurnstile, runs: t.engine.runs!, studio, ai: false,
		apex: 'https://example.test/pick', organization: { write: async (_auth, b) => { branded.push(b); } } });
	const bolt = boltHandler({ engine: t.engine, session: shell.authority, uuid: () => crypto.randomUUID(),
		bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	handle = async (r) => (await shell.handle(r)) ?? (await bolt(r)) ?? new Response(null, { status: 404 });
	expect((await founderBootstrap(identity, 'boss@acme.example')).ok).toBe(true);
});

describe('shell host (§5.10)', () => {
	let admin: Jar, rep: Jar, repId = '';

	it('signs the founder in with an emailed code; the boot shows every app and the settings', async () => {
		admin = await signIn('boss@acme.example');
		expect(mailbox.at(-1)).toMatchObject({ to: 'boss@acme.example' });
		const { status, boot: b } = await boot(admin);
		expect(status).toBe(200);
		expect(b).toMatchObject({ admin: true, name: 'boss', surfaces: { inbox: true, runs: true, settings: true, agent: true, studio: true }, visitor: null });
		expect(b.nav.map((n) => n.name)).toEqual(['sales', 'careers']);
		expect(b.aiUnconfigured).toBe(true); // the host binds no AI: the agent panel says so
		// ui's forms read the caller's exposure from the boot
		expect(b.catalog['applications']).toEqual({ label: ['name'], description: 'Applications', fields: { name: { kind: 'text' } }, relations: { opening: { targets: ['openings'], inverse: 'applications' } }, create: { columns: ['opening', 'name'] } });
		expect((await boot(jar())).status).toBe(401);
		expect(b.workspace).toMatchObject({ name: 'Acme', handle: 'acme', apex: 'https://example.test/pick', organization: true });
	});

	it('a signed-out boot names the workspace, its handle and where to change workspace', async () => {
		const r = await call(jar(), 'GET', '/__bolt/shell');
		expect(r.status).toBe(401);
		expect((r.body!.error as unknown as { workspace: ShellBoot['workspace'] }).workspace).toMatchObject({ name: 'Acme', handle: 'acme', apex: 'https://example.test/pick' });
	});

	it('an act stating a retired schema in Bolt-Contract is refused releaseChanged; the booted one passes (L-BOLT-171)', async () => {
		const { boot: b } = await boot(admin);
		expect(b.contract).toMatch(/^[0-9a-f]{64}$/);
		const act = (contract: string) => call(admin, 'POST', '/__bolt/act', { callable: 'applications.create', input: { opening: OPEN, name: 'Ada' }, issuedAt: t.clock.now() },
			{ 'Idempotency-Key': crypto.randomUUID(), 'Bolt-Contract': contract });
		const stale = await act('0'.repeat(64));
		expect(stale.status).toBe(409);
		expect(stale.body!['outcome']).toMatchObject({ kind: 'refused', code: 'releaseChanged' });
		expect((await act(b.contract!)).body!['outcome']).toMatchObject({ kind: 'committed' });
	});

	it('serves GET /__bolt/openapi.json: OpenAPI 3.1 of the callables the caller may invoke (L-BOLT-294)', async () => {
		const r = await call(admin, 'GET', '/__bolt/openapi.json');
		expect(r.status).toBe(200);
		const doc = r.body as unknown as { openapi: string; paths: { [p: string]: { post: { requestBody: { content: { 'application/json': { schema: { oneOf?: { properties: { callable: { const: string } } }[] } } } } } } } };
		expect(doc.openapi).toBe('3.1.0');
		const callables = doc.paths['/__bolt/act']!.post.requestBody.content['application/json'].schema.oneOf!.map((o) => o.properties.callable.const);
		expect(callables).toContain('applications.create');
		expect(callables).not.toContain('openings.create');   // openings declares no create
		expect((await call(jar(), 'GET', '/__bolt/openapi.json')).status).toBe(401);
	});

	it('an administrator invites a member into a team; the invitee signs in and sees only their apps, no settings', async () => {
		const team = await call(admin, 'POST', '/__bolt/shell/settings', { op: 'createTeam', input: { name: 'Sales' } });
		const teamId = (team.body!.value as { id: string }).id;
		expect((await call(admin, 'POST', '/__bolt/shell/settings', { op: 'invite', input: { email: 'rep@acme.example', team: teamId } })).status).toBe(200);
		expect((await call(admin, 'POST', '/__bolt/shell/settings', { op: 'invite', input: { email: 42 } })).body!.error!.code).toBe('check');
		const s = (await call(admin, 'GET', '/__bolt/shell/settings')).body!.value as { invitations: { email: string; status: string }[] };
		expect(s.invitations).toMatchObject([{ email: 'rep@acme.example', status: 'open' }]);
		rep = await signIn('rep@acme.example');
		const { boot: b } = await boot(rep);
		repId = (b.actor as { id: string }).id;
		expect(b).toMatchObject({ admin: false, surfaces: { settings: false, inbox: true } });
		expect(b.nav.map((n) => n.name)).toEqual(['sales']);
		expect(Object.keys(b.catalog)).toEqual(['openings', 'sys_user', 'sys_team']);   // the kernel directory: pickers at members and teams
		expect((await call(rep, 'GET', '/__bolt/shell/settings')).status).toBe(403);
		expect((await call(rep, 'POST', '/__bolt/shell/settings', { op: 'setAdmin', input: { id: repId, admin: true } })).status).toBe(403);
	});

	it('preview-as is admin-only and clears the administrator flag (rule 39)', async () => {
		expect((await call(rep, 'POST', '/__bolt/shell/preview', { user: repId })).status).toBe(403);
		expect((await call(admin, 'POST', '/__bolt/shell/preview', { user: repId })).status).toBe(204);
		const { boot: b } = await boot(admin);
		expect(b).toMatchObject({ admin: false, preview: { user: repId }, surfaces: { settings: false } });
		expect((await call(admin, 'GET', '/__bolt/shell/settings')).status).toBe(403);
		expect((await call(admin, 'POST', '/__bolt/shell/preview', { user: null })).status).toBe(204);
		expect((await boot(admin)).boot).toMatchObject({ admin: true, preview: null });
	});

	it('the inbox lists requests the viewer may decide and notices addressed to them or their team', async () => {
		await t.db.write({ text: `INSERT INTO bolt_approvals (id, state, step, collection, record, action, requestor, route, at) VALUES
			('0199a000-0000-4000-8000-0000000000a1', 'Pending', 0, 'openings', $1, 'update', 'member:someone', '{"steps":[["sales"]],"superceded_by":[]}', now()),
			('0199a000-0000-4000-8000-0000000000a2', 'Pending', 0, 'openings', $1, 'update', 'member:someone', '{"steps":[["Finance"]],"superceded_by":[]}', now())`, params: [OPEN] });
		// L-BOLT-354: through the one writer, an inbox notice fans out to one row per member it names (user, team, policy)
		const c = new Chain();
		noticeInsert(c, 'n', [
			{ id: 'n1', to: { channel: 'inbox', recipients: [{ user: repId }] }, title: 'To you' },
			{ id: 'n2', to: { channel: 'inbox', recipients: [{ team: 'SALES' }] }, title: 'To the team' },
			{ id: 'n3', to: { channel: 'inbox', recipients: [{ team: 'Finance' }] }, title: 'Not you' },
			{ id: 'n4', to: { channel: 'email', recipients: [{ user: repId }] }, title: 'By email' },
			{ id: 'n5', to: { policy: 'rep' }, title: 'To the policy' },
		], t.clock.now(), manifest.teams, 'true');
		await t.db.write(c.sql('1 AS done'));
		expect((await t.db.read([{ text: `SELECT id, member FROM sys_notification ORDER BY id`, params: [] }]))[0]!.rows).toEqual([
			{ id: `n1:${repId}`, member: repId }, { id: `n2:${repId}`, member: repId }, { id: 'n4', member: null }, { id: `n5:${repId}`, member: repId }]);
		const notices = async () => ((await call(rep, 'GET', '/__bolt/shell/inbox')).body!.value as { notices: { id: string; title: string; read: boolean }[] }).notices;
		const box = (await call(rep, 'GET', '/__bolt/shell/inbox')).body!.value as { requests: { id: string; canDecide: boolean }[]; notices: { title: string }[] };
		expect(box.requests).toEqual([expect.objectContaining({ id: '0199a000-0000-4000-8000-0000000000a1', canDecide: true, mine: false })]);
		expect(box.notices.map((n) => n.title).sort()).toEqual(['To the policy', 'To the team', 'To you']);
		expect((await boot(rep)).boot.inbox).toBe(4);
		// the member marks their own rows read; another member's id is ignored
		const read = (ids: string[], j = rep) => call(j, 'POST', '/__bolt/act', { callable: 'sys_notification.markRead', input: { ids }, issuedAt: t.clock.now() },
			{ 'Idempotency-Key': crypto.randomUUID() });
		expect((await read([`n1:${repId}`, 'n4'])).body!['outcome']).toMatchObject({ kind: 'committed' });
		expect((await notices()).filter((n) => n.read).map((n) => n.title)).toEqual(['To you']);
		expect((await boot(rep)).boot.inbox).toBe(3);
		await read([`n2:${repId}`], admin);
		expect((await notices()).find((n) => n.title === 'To the team')!.read).toBe(false);
		// an administrator may supersede every open request
		expect(((await call(admin, 'GET', '/__bolt/shell/inbox')).body!.value as { requests: unknown[] }).requests).toHaveLength(2);
	});

	it('the workspace log pages sys_event newest first by cursor, filters, follows the tail, and is admin-only', async () => {
		const at = (i: number) => new Date(Date.parse('2026-09-25T00:00:00Z') + i * 1000).toISOString();
		const rows = Array.from({ length: 250 }, (_, i) => ({ at: at(i), severity: i % 50 === 0 ? 'error' : 'info', event: i % 50 === 0 ? 'act.failed' : 'act.settled',
			invocation: `i${i}`, attributes: { n: i } }));
		await t.db.write({ text: 'DELETE FROM sys_event', params: [] });
		await t.db.write({ text: `INSERT INTO sys_event (at, severity, event, invocation, attributes) SELECT e.at, e.severity, e.event, e.invocation, e.attributes
			FROM jsonb_to_recordset($1::jsonb) AS e(at timestamptz, severity text, event text, invocation text, attributes jsonb) ORDER BY e.at`, params: [JSON.stringify(rows)] });
		type Log = { id: string; event: string; severity: string; attributes: { n: number } }[];
		const logs = async (q: string) => (await call(admin, 'GET', `/__bolt/shell/logs${q}`)).body!.value as Log;
		const newest = await logs('');
		expect(newest).toHaveLength(200);
		expect(newest[0]!.attributes.n).toBe(249);
		const older = await logs(`?before=${newest.at(-1)!.id}`);
		expect(older.map((r) => r.attributes.n)).toEqual(Array.from({ length: 50 }, (_, i) => 49 - i));
		expect((await logs('?level=error')).map((r) => r.attributes.n)).toEqual([200, 150, 100, 50, 0]);
		expect((await logs('?q=FAILED&level=error')).length).toBe(5);
		expect(await logs(`?after=${newest[0]!.id}`)).toEqual([]);
		await t.db.write({ text: `INSERT INTO sys_event (at, severity, event, invocation, attributes) VALUES (now(), 'warn', 'act.refused', 'late', '{"n":250}')`, params: [] });
		expect((await logs(`?after=${newest[0]!.id}`)).map((r) => r.event)).toEqual(['act.refused']);
		expect((await call(rep, 'GET', '/__bolt/shell/logs')).status).toBe(403);
	});

	it('Studio runs over the host port for staff members; ops are checked at the boundary', async () => {
		const view = (await call(admin, 'GET', '/__bolt/shell/studio')).body!.value as { sections: { apps: unknown[] }; releases: unknown[] } & Record<string, unknown>;
		expect(view.sections.apps).toEqual([{ name: 'careers', path: 'src/app/careers/+app.ts', href: '/app/careers' }, { name: 'sales', path: 'src/app/sales/+app.ts', href: '/app/sales' }]);
		expect('manifest' in view).toBe(false);
		expect((await call(admin, 'POST', '/__bolt/shell/studio', { op: { op: 'restore', commit: 'c1' } })).status).toBe(200);
		expect(studioOps).toEqual([{ op: 'restore', commit: 'c1' }]);
		expect((await call(admin, 'POST', '/__bolt/shell/studio', { op: { op: 'save', expected: 'c2', files: { '../../etc': 'x' } } })).status).toBe(422);
		const stale = await call(admin, 'POST', '/__bolt/shell/studio', { op: { op: 'save', expected: 'c1', files: { 'src/a.ts': 'y' } } });
		expect([stale.status, stale.body!.error!.code]).toEqual([409, 'conflict']);
		// a staff member who is not an administrator opens Studio too; the host port decides what they may do
		expect((await call(rep, 'GET', '/__bolt/shell/studio')).status).toBe(200);
		// an administrator's authoring stream: the host's pushed frames as server-sent events
		const events = await handle(new Request(`${ORIGIN}/__bolt/shell/studio/events`, { headers: { cookie: [...admin].map(([k, v]) => `${k}=${v}`).join('; ') } }));
		expect(events.headers.get('content-type')).toBe('text/event-stream');
		const reader = events.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('"message":"build started"');
		await reader.cancel();
		expect((await boot(rep)).boot.surfaces.studio).toBe(true);
	});

	it('an administrator edits the branding through the host port; a member cannot, and a malformed body is refused (L-COL-199)', async () => {
		const logo = 'data:image/png;base64,iVBORw0KGgo=';
		expect((await call(admin, 'POST', '/__bolt/shell/organization', { name: ' Acme Ltd ', logo })).status).toBe(200);
		expect((await call(admin, 'POST', '/__bolt/shell/organization', { name: 'Acme', logo: null })).status).toBe(200);
		expect(branded).toEqual([{ name: 'Acme Ltd', logo }, { name: 'Acme', logo: null }]);
		expect((await call(admin, 'POST', '/__bolt/shell/organization', { name: '', logo: null })).status).toBe(400);
		expect((await call(admin, 'POST', '/__bolt/shell/organization', { name: 'Acme', logo: 7 })).status).toBe(400);
		expect((await call(rep, 'POST', '/__bolt/shell/organization', { name: 'Rep Co', logo: null })).status).toBe(403);
		expect(branded).toHaveLength(2);
	});

	it('serves the PWA manifest from the configured origin, never the Host header', async () => {
		const res = await handle(new Request('https://evil.example/manifest.webmanifest', { headers: { host: 'evil.example' } }));
		expect(await res.json()).toMatchObject({ id: 'acme', name: 'Acme', scope: `${ORIGIN}/`, start_url: `${ORIGIN}/` });
	});

	it('signs out: the session row goes and the cookie is cleared', async () => {
		const j = await signIn('rep@acme.example');
		expect((await call(j, 'POST', '/__bolt/session/signout')).status).toBe(204);
		expect(j.has('nb_s')).toBe(false);
		expect((await boot(j)).status).toBe(401);
	});
});

describe('visitor pages (§5.10, rule 38d)', () => {
	const V = { 'Bolt-App': 'careers' };

	it('mints the visitor cookie, boots only the public app, and runs every request as its visitor', async () => {
		const j = jar();
		const { boot: b } = await boot(j, 'careers');
		expect(j.has('__bolt_v')).toBe(true);
		expect(b).toMatchObject({ actor: { kind: 'visitor', app: 'careers' }, visitor: { app: 'careers', siteKey: 'dev' }, surfaces: { inbox: false, agent: false } });
		expect(b.catalog['openings']!.fields).toEqual({ title: { kind: 'text' } }); // the grant's fields narrow the exposure
		expect(b.catalog['applications']!.create).toEqual({ columns: ['opening', 'name'] });
		expect(b.nav.map((n) => n.name)).toEqual(['careers']);
		const q = await call(j, 'POST', '/__bolt/q', { reads: [{ m: 'read', a: ['openings', { all: true }] }] }, V);
		expect(q.status).toBe(200);
		expect((q.body!['answers'] as { rows: { title: string }[] }[])[0]!.rows.map((r) => r.title)).toEqual(['Engineer']);
		expect((await call(j, 'POST', '/__bolt/q', { reads: [{ m: 'aggregate', a: ['openings', { count: true }] }] }, V)).status).toBe(403);
		expect((await call(j, 'POST', '/__bolt/q', { reads: [{ m: 'read', a: ['applications', { all: true }] }] }, V)).status).toBe(403);
		expect((await call(j, 'GET', '/__bolt/live', undefined, V)).status).toBe(403);
		expect((await call(j, 'GET', '/__bolt/shell/inbox', undefined, V)).status).toBe(403);
	});

	it('a signed-in admin on a public page is still the visitor', async () => {
		const admin = await signIn('boss@acme.example');
		expect((await call(admin, 'POST', '/__bolt/q', { reads: [{ m: 'read', a: ['applications', { all: true }] }] }, V)).status).toBe(403);
	});

	it('applies with a fresh Turnstile token; without one, or with a bad one, the act is refused before decode', async () => {
		const j = jar();
		await boot(j, 'careers');
		const apply = (token?: string) => call(j, 'POST', '/__bolt/act', { callable: 'applications.create', input: { opening: OPEN, name: 'Ada' }, issuedAt: t.clock.now() },
			{ ...V, 'Idempotency-Key': crypto.randomUUID(), ...(token === undefined ? {} : { 'Bolt-Challenge': token }) });
		expect((await apply()).status).toBe(403);
		expect((await apply('forged')).status).toBe(403);
		const ok = await apply('dev-pass');
		expect(ok.status).toBe(200);
		expect(ok.body!['outcome']).toMatchObject({ kind: 'committed' });
		expect((await call(j, 'POST', '/__bolt/act', { callable: 'openings.update', input: { target: OPEN, set: {} }, issuedAt: t.clock.now() },
			{ ...V, 'Idempotency-Key': crypto.randomUUID(), 'Bolt-Challenge': 'dev-pass' })).status).toBe(403);
	});
});
