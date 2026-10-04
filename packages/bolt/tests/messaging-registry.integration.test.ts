import { describe, expect, it } from 'vitest';
import { testWorkspace } from '../src/test/index.ts';
import { channelRecords, messagingOp, refreshMessaging } from '../src/engine/channels/registry.ts';
import { loadPack } from '../src/engine/write/pack.ts';
import { decodeSeed } from '../src/engine/write/seed.ts';
import { lowerRead } from '../src/engine/index.ts';
import { patched } from '../src/client/bolt.ts';
import type { Json } from '../src/decl/values.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { manifest } from './engine-fixture.ts';

describe('runtime messaging records', () => {
	it('restores messaging defaults in a seed pack and refuses unknown system records', async () => {
		const t = await testWorkspace({ manifest });
		const rows = {
			sys_channel_connection: [{ id: 'mail', name: 'Mailbox', type: 'email', owner: null, configuration: {} }],
			sys_envoy: [{ id: 'desk', name: 'Desk', task: 'Help.', policies: ['rep'] }],
			sys_envoy_channel: [{ id: 'desk:mail', envoy: 'desk', channel_connection: 'mail' }]
		};
		const pack = { dir: '', meta: { format: 1 as const, name: 'base', hash: '', start: [], rows: {}, assets: [] }, rows };
		expect(await loadPack(t.db, t.manifest, pack, t.clock.now())).toBe(true);
		await refreshMessaging(t.db, t.manifest);
		expect(t.manifest.envoys['desk']).toMatchObject({ channels: ['mail'], task: 'Help.' });
		expect(await loadPack(t.db, t.manifest, pack, t.clock.now())).toBe(false);
		expect(() => decodeSeed(t.manifest, { sys_config: [{ id: 'forged' }] })).toThrow("unknown collection 'sys_config'");
	});

	it('persists user-owned connections and an envoy on multiple shared connections', async () => {
		const t = await testWorkspace({ manifest });
		const admin = t.engine.authority({ actor: { kind: 'member', id: 'admin', email: null, phone: null, external: false, teams: [], teamPath: [], admin: true, party: null }, admin: true, policies: [] });
		await t.db.write({ text: `INSERT INTO sys_user (id, name, kind, active, admin) VALUES ('admin', 'Admin', 'staff', true, true), ('u1', 'User', 'staff', true, false)`, params: [] });
		const user = t.engine.authority({ actor: { ...admin.actor, id: 'u1', admin: false } as Extract<typeof admin.actor, { kind: 'member' }>, admin: false, policies: [] });
		const tabs = [0, 1].map(() => {
			let value: Json | undefined;
			const conn = t.engine.live.connect(admin, (frame) => {
				if (frame.t === 'answer') value = frame.value;
				if (frame.t === 'patch') value = patched(value, frame.ops);
			}, () => {});
			return { conn, value: () => value };
		});
		for (const tab of tabs) await t.engine.live.register(tab.conn, 'connections', { read: lowerRead(t.engine.manifest, 'read', ['sys_channel_connection', { select: { name: true, owner: true }, all: true }]) });
		const publish = (changes: Parameters<typeof t.engine.live.publish>[0]) => { t.engine.live.publish(changes); };
		await messagingOp(t.db, t.engine.manifest, user, 'saveChannel', { id: 'personal', name: 'My mailbox', type: 'email' }, publish);
		await t.engine.live.settled();
		for (const tab of tabs) expect(tab.value()).toMatchObject({ rows: [{ id: 'personal', name: 'My mailbox', owner: 'u1' }] });
		for (const id of ['desk_mail', 'desk_chat']) await messagingOp(t.db, t.engine.manifest, admin, 'saveChannel', { id, name: id, type: id === 'desk_mail' ? 'email' : 'whatsapp' });
		await messagingOp(t.db, t.engine.manifest, admin, 'saveEnvoy', { id: 'desk', name: 'Desk', task: 'Help.', policies: ['rep'], channels: ['desk_mail', 'desk_chat'] });
		expect(t.engine.manifest.envoys['desk']!['channels']).toEqual(['desk_chat', 'desk_mail']);
		expect((await channelRecords(t.db, user)).map((r) => r.id)).toEqual(['personal']);
		await expect(messagingOp(t.db, t.engine.manifest, user, 'saveEnvoy', { id: 'bad' })).rejects.toMatchObject({ code: 'forbidden' });
		await expect(messagingOp(t.db, t.engine.manifest, user, 'saveChannel', { id: 'desk_mail', name: 'stolen', type: 'email' })).rejects.toMatchObject({ code: 'forbidden' });
		await expect(messagingOp(t.db, t.engine.manifest, admin, 'saveEnvoy', { id: 'other', name: 'Other', task: '', policies: ['rep'], channels: ['desk_mail'] })).rejects.toMatchObject({ code: 'invalid' });
		await expect(messagingOp(t.db, t.engine.manifest, admin, 'saveEnvoy', { id: 'other', name: 'Other', task: '', policies: ['rep'], channels: ['personal'] })).rejects.toMatchObject({ code: 'invalid' });
		await expect(messagingOp(t.db, t.engine.manifest, admin, 'saveEnvoy', { id: 'desk', name: 'Desk', task: '', policies: ['nonexistent'], channels: [] })).rejects.toMatchObject({ code: 'invalid' });
		const authorities = new Authorities(t.engine.manifest, 'test');
		const subject = { envoy: 'desk', channel: 'desk_mail', sender: 'unknown', member: null, dm: false };
		const old = await authorities.envoy(t.db, subject);
		await messagingOp(t.db, t.engine.manifest, admin, 'saveEnvoy', { id: 'desk', name: 'Edited desk', task: 'New instructions.', policies: ['rep'], channels: ['desk_chat'] }, publish);
		expect((await authorities.envoy(t.db, subject))?.key).not.toBe(old?.key);
		expect(t.engine.manifest.envoys['desk']!['channels']).toEqual(['desk_chat']);
		await messagingOp(t.db, t.engine.manifest, admin, 'saveEnvoy', { id: 'other', name: 'Other', task: '', policies: ['rep'], channels: ['desk_mail'] }, publish);
		await messagingOp(t.db, t.engine.manifest, admin, 'deleteEnvoy', { id: 'other' }, publish);
		expect((await t.db.read([{ text: "SELECT * FROM sys_envoy_channel WHERE envoy = 'other'", params: [] }]))[0]!.rows).toEqual([]);
		await messagingOp(t.db, t.engine.manifest, admin, 'deleteChannel', { id: 'desk_mail' }, publish);
		await t.engine.live.settled();
		for (const tab of tabs) expect(tab.value()).toMatchObject({ rows: expect.arrayContaining([{ id: 'personal', revision: 1, name: 'My mailbox', owner: 'u1' }]) });
		const reboot: typeof t.engine.manifest = { ...t.engine.manifest, channels: {}, envoys: {} };
		await refreshMessaging(t.db, reboot);
		expect(reboot.envoys).toEqual(t.engine.manifest.envoys);
		expect(reboot.channels['personal']!['owner']).toBe('u1');
	});
	it('schedules a newly created custom connection without recovering another active run', async () => {
		const t = await testWorkspace({ manifest: { ...manifest, channelTypes: { clock: { transport: 'custom', poll: { connection: 'api', cron: '*/5 * * * *', path: '/messages' } } } } });
		const admin = t.as(t.admin).authority;
		await t.db.write({ text: "INSERT INTO sys_run (id, automation, input, due_at, state, leases, cause, depth) VALUES ('working', 'nightly', '{}'::jsonb, now(), 'running', 0, 'start', 0)", params: [] });
		const changed = async () => { await t.engine.runs!.reconfigure(); };
		await messagingOp(t.db, t.manifest, admin, 'saveChannel', { id: 'clock-1', name: 'Clock', type: 'clock', configuration: { folder: 'inbox' } }, changed);
		expect(t.manifest.channels['clock-1']!['configuration']).toEqual({ folder: 'inbox' });
		expect((await t.db.read([{ text: "SELECT automation FROM sys_run WHERE state = 'queued'", params: [] }]))[0]!.rows).toEqual([{ automation: 'channels.poll:clock-1' }]);
		expect((await t.db.read([{ text: "SELECT state, leases FROM sys_run WHERE id = 'working'", params: [] }]))[0]!.rows).toEqual([{ state: 'running', leases: 0 }]);
		await messagingOp(t.db, t.manifest, admin, 'deleteChannel', { id: 'clock-1' }, changed);
		expect((await t.db.read([{ text: "SELECT automation FROM sys_run WHERE state = 'queued'", params: [] }]))[0]!.rows).toEqual([]);
	});

});
