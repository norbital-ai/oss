// `/__bolt/files` (`filesHandler`): uploads through the engine's files port; a download is the uploader's, a reader's of
// a row holding it, or, for a message attachment, the conversation's owner, participants and (channel threads) staff.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { Authority, EngineManifest } from '../src/engine/contracts.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { filesHandler } from '../src/protocol/files.ts';
import { testWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, models: {}, relationships: {}, collections: {}, policies: {},
	agent: { internal: 'Staff brief.', external: 'External brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;

it('message attachments download for the conversation, not for every member', async () => {
	const t = await testWorkspace({ manifest });
	await t.db.write({ text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ('root', 'r@x.test', 'Root', 'staff', true), ('ann', 'a@x.test', 'Ann', 'staff', false),
		('bob', 'b@x.test', 'Bob', 'staff', false), ('eve', 'e@x.test', 'Eve', 'external', false)`, params: [] });
	const who: { [id: string]: Authority } = {};
	for (const id of ['root', 'ann', 'bob', 'eve']) who[id] = (await new Authorities(manifest, 'test').member(t.db, id))!;
	const files = filesHandler({ engine: t.engine, session: async (r) => who[r.headers.get('x-as') ?? ''] ?? null,
		bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	const call = async (as: string, method: string, rest: string, body?: Uint8Array<ArrayBuffer>, mime = 'image/png', name = 'pump.png') => (await files(new Request(`http://cell/__bolt/files/${rest}`, { method,
		headers: { 'x-as': as, 'content-type': mime, 'Idempotency-Key': randomUUID(), 'content-disposition': `attachment; filename*=UTF-8''${name}` }, ...(body === undefined ? {} : { body }) })))!;
	const up = async (as: string) => (await (await call(as, 'PUT', 'sys_message.files', new Uint8Array([1, 2, 3]))).json()) as { id: string; name: string; mime: string; bytes: number };
	const status = async (as: string, id: string) => (await call(as, 'GET', id)).status;

	expect(await files(new Request('http://cell/__bolt/q'))).toBeNull();
	expect(await status('nobody', randomUUID())).toBe(401);
	const panel = await up('ann');
	expect(panel).toMatchObject({ name: 'pump.png', mime: 'image/png', bytes: 3 });
	const down = await call('ann', 'GET', panel.id);
	expect(down.status).toBe(200); // the uploader, before the message is sent
	expect([...new Uint8Array(await down.arrayBuffer())]).toEqual([1, 2, 3]);
	expect(await status('bob', panel.id)).toBe(404);
	const heic = (await (await call('ann', 'PUT', 'sys_message.files', new Uint8Array(readFileSync(new URL('./fixtures/files/photo.heic', import.meta.url))), 'image/heic', 'photo.heic')).json()) as { id: string };
	const preview = await call('ann', 'GET', `${heic.id}?preview=jpeg`);
	expect(preview.headers.get('content-type')).toBe('image/jpeg');
	expect([...new Uint8Array(await preview.arrayBuffer()).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
	expect(await status('bob', `${heic.id}?preview=jpeg`)).toBe(404);

	// an in-app conversation: its owner, a member who posted in it, and an administrator
	const conversation = await t.engine.agents.start({ owner: 'ann' });
	await t.engine.agents.post({ conversation, as: { member: 'ann' }, text: 'see this', files: [panel] });
	const [row] = (await t.db.read([{ text: `SELECT content, files FROM sys_message WHERE conversation = $1`, params: [conversation] }]))[0]!.rows;
	expect(row).toMatchObject({ content: { text: 'see this' }, files: [{ id: panel.id }] }); // one copy: the files column
	expect((row!['content'] as { files?: unknown }).files).toBeUndefined();
	expect(await status('bob', panel.id)).toBe(404);
	expect(await status('root', panel.id)).toBe(200);
	await t.engine.agents.post({ conversation, as: { member: 'bob' }, text: 'on it' });
	expect(await status('bob', panel.id)).toBe(200);

	// a channel thread of no public envoy: only a participant reads it (a staff member too is refused), an external member as its linked sender
	const inbound = await up('root');
	await t.db.write({ text: `INSERT INTO sys_conversation (id, channel) VALUES ('wa-1', 'whatsapp')`, params: [] });
	await t.db.write({ text: `INSERT INTO sys_message (id, conversation, channel, text, files) VALUES ('m-1', 'wa-1', 'whatsapp', 'photo', $1::jsonb)`,
		params: [JSON.stringify([{ fileName: 'pump.png', mimeType: 'image/png', byteLength: 3, file: { id: inbound.id, name: 'pump.png', mime: 'image/png' } }])] });
	expect(await status('ann', inbound.id)).toBe(404);
	expect(await status('eve', inbound.id)).toBe(404);
	await t.db.write({ text: `INSERT INTO sys_message (id, conversation, channel, text, "as") VALUES ('m-2', 'wa-1', 'whatsapp', 'mine', $1::jsonb)`,
		params: [JSON.stringify({ envoy: { name: 'desk', channel: 'whatsapp', sender: '+65', member: 'eve', dm: true } })] });
	expect(await status('eve', inbound.id)).toBe(200);
}, 30_000);
