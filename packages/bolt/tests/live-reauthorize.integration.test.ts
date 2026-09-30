// A live connection answers only the one who opened it (rules 64–66). When their authority changed since — a policy, a
// team, the record they were just bound to — registering on it re-answers every view under the new authority instead
// of refusing; another member is still refused.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Authority, EngineManifest } from '../src/engine/contracts.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { boltHandler } from '../src/protocol/http.ts';
import type { Frame } from '../src/protocol/wire.ts';
import { testWorkspace } from '../src/test/index.ts';
import { sse } from './support/live-bolt.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	models: {}, relationships: {}, collections: {}, policies: {},
	agent: { internal: 'Staff brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean) => { for (let i = 0; i < 1_000 && !ok(); i++) await sleep(5); expect(ok()).toBe(true); };

it('the same member with a changed authority re-registers and is answered again; another member is refused', async () => {
	const t = await testWorkspace({ manifest });
	await t.db.write({ text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann'), ('bob', 'bob@x.test', 'Bob')`, params: [] });
	const authorities = new Authorities(manifest, 'test');
	const ann = (await authorities.member(t.db, 'ann'))!;
	const bob = (await authorities.member(t.db, 'bob'))!;
	let who: Authority = ann;
	const handle = boltHandler({ engine: t.engine, session: async () => who, uuid: randomUUID,
		bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	const fetch = (async (url: string | URL | Request, init?: RequestInit) =>
		await handle(new Request(new URL(String(url), 'http://cell'), init)) ?? new Response(null, { status: 404 })) as typeof globalThis.fetch;
	const frames: Frame[] = [];
	const source = sse((u) => fetch(u), '/__bolt/live');
	source.onmessage = (m) => frames.push(JSON.parse(m.data) as Frame);
	await until(() => frames.some((f) => f.t === 'hello'));
	const conn = (frames.find((f) => f.t === 'hello') as Extract<Frame, { t: 'hello' }>).conn;
	const register = (view: string) => fetch('/__bolt/live', { method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ conn, add: [{ view, read: { m: 'conversations', a: [] } }] }) });
	const answers = (view: string) => frames.filter((f) => f.t === 'answer' && f.view === view).length;

	expect((await register('a')).status).toBe(200);
	await until(() => answers('a') === 1);
	// Ann is bound to her record: her authority (its key) changes, her identity does not
	who = { ...ann, key: `${ann.key}:bound`, actor: { ...ann.actor, party: { collection: 'customers', id: 'c1' } } } as Authority;
	expect((await register('b')).status).toBe(200);
	await until(() => answers('a') === 2 && answers('b') === 1);   // the open view re-answered under the new authority
	who = bob;
	expect((await register('c')).status).toBe(403);
	source.close();
});
