// The session cookie follows the database session: every signed-in boot re-sends it with what is left of the sliding
// expiry, so a member who keeps coming back is not signed out on day seven; a name sent twice keeps the first (the
// most specific path), so a stray `Path=/` cookie cannot shadow the workspace's own.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EngineManifest } from '../src/engine/contracts.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { loadKeys, mint, type IdentityHost } from '../src/engine/identity/session.ts';
import { shellHost } from '../src/shell/host.ts';
import { COOKIES, SHELL } from '../src/shell/nav.ts';
import { testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', apps: [], agent: { triage: false } },
	models: {}, relationships: {}, collections: {}, policies: {}, apps: {}, agent: { skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, customFields: {}
} as unknown as EngineManifest;

describe('the session cookie', () => {
	it('slides with the database session on every boot, and of duplicate names the first live one wins', async () => {
		const t = await testWorkspace({ manifest });
		const identity: IdentityHost = { db: t.db, now: () => new Date(t.clock.now()), windows: new RateWindows(), keys: await loadKeys(t.db),
			mail: { send: async () => ({ providerId: 'x' }), subscribe: () => () => {} }, devSink: true, publicUrl: 'https://acme.example/acme' };
		const shell = shellHost({ manifest, identity, authorities: new Authorities(manifest, 'test'), workspace: { name: 'Acme', handle: 'acme' }, ip: () => '203.0.113.9' });
		const id = randomUUID();
		await t.db.write({ text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ($1, 'ada@x.test', 'Ada', 'staff', true)`, params: [id] });
		const s = await mint(identity, id);
		if (!s.ok) throw new Error(s.message);
		const session = `${COOKIES.session}=${encodeURIComponent(s.value.token)}`;
		const boot = (cookie: string) => shell.handle(new Request(`https://acme.example${SHELL}`, { headers: { cookie } }));

		// six days on, the database session refreshes (a day since the last) and the cookie is re-sent for seven more days
		t.clock.set(new Date(Date.parse(t.clock.now()) + 6 * 86_400_000).toISOString());
		const later = (await boot(session))!;
		expect(later.status).toBe(200);
		const maxAge = Number(/Max-Age=(\d+)/.exec(later.headers.get('set-cookie') ?? '')?.[1]);
		expect(maxAge).toBeGreaterThan(6 * 86_400);
		expect(later.headers.get('set-cookie')).toContain('; Path=/acme;');

		expect((await boot(`${session}; ${COOKIES.session}=stray`))!.status).toBe(200);
		// a dead cookie sent first (one set before cookies were Partitioned) no longer hides the live one behind it
		expect((await boot(`${COOKIES.session}=stray; ${session}`))!.status).toBe(200);
		expect((await boot(`${COOKIES.session}=stray`))!.status).toBe(401);
	});
});
