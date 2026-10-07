// `bolt start`'s channel routes (rule 61): `/__bolt/transports/<channel>` serves every transport for an administrator,
// several channels share a transport, credentials are sealed in the secrets store and resumed on the next start, and
// each channel's `/hooks/bolt.<transport>/<channel>` reaches its own link. Providers are fakes: no service is called.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT } from '../../bolt/src/compiler/artifact/index.ts';
import { artifactHash, sha, treeHash } from '../../bolt/src/compiler/artifact/read.ts';
import { connection, type ChannelProvider } from '../../bolt/src/engine/channels/connection.ts';
import type { EngineManifest } from '../../bolt/src/engine/contracts.ts';
import type { Json } from '../../bolt/src/decl/values.ts';
import { fingerprint, schemaSlice } from '../../bolt/src/engine/schema/plan.ts';
import { decodeConfig } from '../src/config.ts';
import { devSink } from '../src/mail.ts';
import { start, type Server } from '../src/server.ts';

const TRANSPORTS = ['whatsapp', 'telegram', 'slack', 'discord', 'wechat'] as const;
const manifest = {
	workspace: { tz: 'UTC', locale: 'en' }, models: {}, relationships: {}, collections: {}, policies: {}, automations: {}, integrations: {}, pipelines: {}, teams: {},
	channelTypes: { wa_sales: { transport: 'whatsapp' }, wa_ops: { transport: 'whatsapp' }, tg: { transport: 'telegram' }, sl: { transport: 'slack' },
		dc: { transport: 'discord' }, wx: { transport: 'wechat' }, partner: { transport: 'custom', inbound: { verify: { scheme: 'hmac-sha256', secret: 'signingSecret' } } }, mail: { transport: 'email' } },
	channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

/** A provider that pairs on `{ key }` and turns each webhook body into one inbound message of its channel. */
const fake = (transport: string, id = 'fake'): ChannelProvider => ({
	transport: transport as ChannelProvider['transport'], id, label: `Fake ${id}`, setup: { kind: 'form', webhook: true, fields: [{ name: 'key', label: 'Key', secret: true }], steps: [] },
	test: { to: { name: 'to', label: 'To' } },
	async open(ctx) {
		let key = (ctx.credential as { key?: string } | null)?.key ?? null;
		return {
			connection: () => connection(ctx.channel, transport, key === null ? 'unpaired' : 'connected', { pairedAs: key, stored: key !== null }),
			async pair(input) {
				const k = (input as { key?: unknown }).key;
				if (typeof k !== 'string') throw new Error('a key is required');
				key = k;
				await ctx.save({ key });
				ctx.changed();
			},
			async unpair() { key = null; await ctx.save(null); },
			async close() {},
			async send(channel, message) { tests.push([channel, message]); return { providerId: `${id}-1` }; },
			async webhook(request) {
				if (request.headers.get('x-signed') !== key) return new Response(null, { status: 401 });
				await ctx.emit({ kind: 'inbound', channel: ctx.channel, message: await request.json() as Json });
				return new Response(null, { status: 200 });
			},
		};
	},
});
const tests: [string, Json][] = [];
const providers = [...TRANSPORTS.map((t) => fake(t)), fake('whatsapp', 'other'), fake('email')];

const root = join(tmpdir(), 'norbital-scratch', `bolt-server-channels-${randomUUID()}`), artifact = join(root, 'artifact');
const guest = 'export default { channel: { partner: { inbound: { messages: ({ body }) => body.events } } } };';
function writeFixture(): void {
	mkdirSync(join(artifact, 'client'), { recursive: true });
	const text = JSON.stringify(manifest);
	writeFileSync(join(artifact, 'manifest.json'), text);
	writeFileSync(join(artifact, 'guest.mjs'), guest);
	writeFileSync(join(artifact, 'client', 'index.html'), '<!doctype html>');
	const body = { format: 1, contract: CONTRACT, handle: 'acme', name: 'Acme', schema: fingerprint(schemaSlice(manifest)),
		transforms: [], projections: [], client: { entry: '', css: [] }, hashes: { manifest: sha(text), guest: sha(guest), client: treeHash(join(artifact, 'client')) } };
	writeFileSync(join(artifact, 'artifact.json'), JSON.stringify({ ...body, hash: artifactHash(artifact, body as Parameters<typeof artifactHash>[1]) }));
}
const FOUNDER = 'boss@acme.example';
const config = () => decodeConfig({ BOLT_ARTIFACT: artifact, BOLT_PORT: '0', BOLT_PUBLIC_URL: 'http://localhost:3100', BOLT_PGLITE_DIR: join(root, 'db'),
	BOLT_FILES_PROVIDER: 'local', BOLT_FILES_ENDPOINT: join(root, 'files'), BOLT_MASTER_KEY: createHash('sha256').update('master').digest('hex') }, [`--founder=${FOUNDER}`]);

let server: Server, cookie = '';
const mail = devSink();
const call = (method: string, path: string, body?: unknown, headers: { [k: string]: string } = {}) => fetch(`${server.url}${path}`, { method,
	headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const state = async (channel: string) => ((await (await call('GET', `/__bolt/transports/${channel}`)).json()) as { value: { [k: string]: unknown } }).value;
const signIn = async () => {
	await call('POST', '/__bolt/session/code', { address: FOUNDER });
	const code = /\b(\d{6})\b/.exec(mail.mail.at(-1)?.text ?? '')![1]!;
	const r = await call('POST', '/__bolt/session/verify', { address: FOUNDER, code });
	cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
};

beforeAll(async () => {
	writeFixture();
	server = await start(config(), { mail, log: () => {}, channelProviders: providers });
	await signIn();
	for (const [id, type] of Object.entries(manifest.channelTypes!)) {
		const response = await call('POST', '/__bolt/transports/', { id, type: type.transport === 'custom' ? id : type.transport, name: id });
		expect(response.status).toBe(200);
	}
}, 60_000);
afterAll(async () => {
	await server?.close();
	rmSync(root, { recursive: true, force: true });
});

describe('channel routes', () => {
	it('refuses a visitor; answers every transport with its setup and this channel\'s webhook URL', async () => {
		const saved = cookie;
		cookie = '';
		expect((await call('GET', '/__bolt/transports/tg')).status).toBe(403);
		cookie = saved;
		for (const [channel, transport] of [['wa_sales', 'whatsapp'], ['tg', 'telegram'], ['sl', 'slack'], ['dc', 'discord'], ['wx', 'wechat']] as const)
			expect(await state(channel)).toMatchObject({ channel, transport, state: 'unpaired', about: { webhookUrl: `http://localhost:3100/hooks/bolt.${transport}/${channel}` } });
		expect(((await state('wa_sales'))['providers'] as { id: string }[]).map((p) => p.id)).toEqual(['fake', 'other']);
		// email is a channel like any other now: the tenant's own mailbox, set up by an administrator
		expect(await state('mail')).toMatchObject({ transport: 'email', state: 'unpaired', providers: [{ id: 'fake' }] });
		expect((await call('GET', '/__bolt/transports/nope')).status).toBe(404);
	});

	it('pairs two WhatsApp channels on different providers, answers refusals verbatim, and streams the state', async () => {
		expect(await (await call('POST', '/__bolt/transports/wa_sales/pair', { key: 'k' })).json()).toEqual({ error: { code: 'invalid', message: expect.stringContaining('choose how to connect') } });
		expect(await (await call('POST', '/__bolt/transports/wa_sales/pair', { provider: 'fake' })).json()).toEqual({ error: { code: 'invalid', message: 'a key is required' } });
		expect((await call('POST', '/__bolt/transports/wa_sales/pair', { provider: 'fake', key: 'sales' })).status).toBe(200);
		expect((await call('POST', '/__bolt/transports/wa_ops/pair', { provider: 'other', key: 'ops' })).status).toBe(200);
		expect(await state('wa_sales')).toMatchObject({ state: 'connected', provider: 'fake', pairedAs: 'sales' });
		expect(await state('wa_ops')).toMatchObject({ state: 'connected', provider: 'other', pairedAs: 'ops' });
		const sse = await call('GET', '/__bolt/transports/wa_ops', undefined, { accept: 'text/event-stream' });
		expect(new TextDecoder().decode((await sse.body!.getReader().read()).value)).toMatch(/"pairedAs":"ops"/);
	});

	it('routes each channel\'s webhook to its own link: a verified message lands on that channel', async () => {
		expect((await call('POST', '/__bolt/transports/sl/pair', { key: 'slk' })).status).toBe(200);
		const message = { id: 'C1:1', thread: 'C1', sentAt: '2026-10-01T10:00:00.000Z', from: { handle: 'U1', name: null }, text: 'hello' };
		expect((await call('POST', '/hooks/bolt.slack/sl', message, { 'x-signed': 'wrong' })).status).toBe(401);
		expect((await call('POST', '/hooks/bolt.slack/sl', message, { 'x-signed': 'slk' })).status).toBe(200);
		expect((await call('POST', '/hooks/bolt.slack/dc', message)).status).toBe(404); // the path's transport is not the channel's
		expect((await call('POST', '/hooks/bolt.discord/dc', message)).status).toBe(404); // not paired
		// paths under a channel's hook reach its link too (an email channel's OAuth callback and open pixel live there)
		expect((await call('POST', '/hooks/bolt.slack/sl/oauth/callback', message, { 'x-signed': 'wrong' })).status).toBe(401);
		const [r] = await server.db.read([{ text: `SELECT channel, text FROM sys_message WHERE direction = 'inbound'`, params: [] }]);
		expect(r!.rows).toEqual([{ channel: 'sl', text: 'hello' }]);
	});

	it('sends a test message through a connected channel, and refuses one that is not', async () => {
		expect((await state('wa_sales'))['test']).toEqual({ to: { name: 'to', label: 'To' } });
		expect((await state('tg'))['test']).toBeUndefined();
		expect((await call('POST', '/__bolt/transports/tg/test', { to: '5' })).status).toBe(400);
		expect((await call('POST', '/__bolt/transports/wa_sales/test', { to: 'whatsapp:+6591111111' })).status).toBe(200);
		expect(tests.at(-1)).toEqual(['wa_sales', { id: expect.any(String), to: 'whatsapp:+6591111111', text: expect.stringContaining('Norbital test message') }]);
	});

	it('seals credentials: the next start resumes them; unpair destroys them', async () => {
		await server.close();
		server = await start(config(), { mail, log: () => {}, channelProviders: providers });
		expect(await state('wa_ops')).toMatchObject({ state: 'connected', provider: 'other', pairedAs: 'ops' });
		expect((await call('POST', '/__bolt/transports/wa_ops/logout')).status).toBe(200);
		const [r] = await server.db.read([{ text: `SELECT count(*)::int AS n FROM sys_config WHERE key LIKE '%transport%'`, params: [] }]);
		expect(r!.rows[0]!['n']).toBe(2); // wa_sales and sl remain
		expect(await state('wa_ops')).toMatchObject({ state: 'unpaired' });
	}, 60_000);

	it('a custom channel\'s own webhook takes only a body signed with what its connect page paired, mapped by its inbound', async () => {
		expect(await state('partner')).toMatchObject({ state: 'unpaired', about: { webhookUrl: 'http://localhost:3100/hooks/bolt.custom/partner' } });
		expect((await call('POST', '/__bolt/transports/partner/pair', { signingSecret: 'shh' })).status).toBe(200);
		const body = { events: [{ id: 'x1', thread: 'chat-1', sentAt: '2026-10-01T10:00:00.000Z', from: { handle: 'partner-user', name: null }, text: 'from the partner' }] };
		const signed = (secret: string) => ({ 'x-signature': createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex') });
		expect((await call('POST', '/hooks/bolt.custom/partner', body, signed('guessed'))).status).toBe(401);
		expect((await call('POST', '/hooks/bolt.custom/partner', body, signed('shh'))).status).toBe(200);
		const [r] = await server.db.read([{ text: `SELECT text FROM sys_message WHERE channel = 'partner' AND direction = 'inbound'`, params: [] }]);
		expect(r!.rows).toEqual([{ text: 'from the partner' }]);
	});
});
