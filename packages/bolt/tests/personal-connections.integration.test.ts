import { Effect, Result, Schema } from 'effect';
import { describe } from 'vitest';
import { expect, it, layer, TestWorkspace } from '../../bolt-cli/src/test/effect.ts';
import { id_of } from '../src/decl/id.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { decode_manifest } from '../src/engine/manifest.ts';
import { navigation_paths, route } from '../src/shell/nav.ts';
import type { Json } from '../src/decl/values.ts';

const userId = Schema.decodeUnknownSync(id_of('sys_user'));
const integrationId = Schema.decodeUnknownSync(id_of('sys_integration'));

const manifest: EngineManifest = Result.getOrThrow(
	decode_manifest({
		needs: [],
		workspace: { tz: 'UTC', locale: 'en' },
		models: {},
		relationships: {},
		exposures: {},
		integrations: {
			gcal: {
				description: 'Personal Google Calendar',
				driver: 'calendar',
				scope: 'personal',
				configuration: { calendars: { kind: 'text', many: true, default: ['primary'] } }
			},
			desk_mail: {
				description: 'Shared desk mailbox',
				driver: 'email'
			},
			erp: {
				description: 'Workspace ERP',
				driver: 'http'
			}
		},
		policies: {
			connector: {
				description: 'Connect personal WhatsApp and calendar',
				grants: {},
				capabilities: { personal_connections: ['whatsapp', 'gcal'] }
			},
			reader: {
				description: 'Read all integration rows',
				grants: {
					sys_integration: { outputs: { default: {} } }
				}
			}
		},
		automations: {},
		mcp: {},
		apps: {},
		custom_fields: {},
		agent: { skills: {} }
	} satisfies EngineManifest)
);

const Integrations = Schema.Struct({
	sys_integration: Schema.Struct({
		rows: Schema.Array(
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				integration: Schema.String,
				owner: Schema.NullOr(Schema.String),
				active: Schema.Boolean,
				revision: Schema.Number
			})
		),
		next: Schema.NullOr(Schema.String),
		total: Schema.Number
	})
});

layer(TestWorkspace.layer({ manifest }))('personal connections and integration scope', (it) => {
	it.effect('enforces integration.scope for personal, workspace-default, and both definitions', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const alice = t.member(['connector']);
			const admin = yield* t.as(t.admin);
			yield* t.as(alice);

			// scope: 'personal' allows owner = member, refuses owner = null even as admin
			expect(
				yield* Effect.flip(
					admin.act({
						'sys_integration.create': [{ integration: 'gcal', name: 'Shared Cal', owner: null }]
					})
				)
			).toMatchObject({ _tag: 'ActRefused' });
			const ownCal = yield* admin.act({
				'sys_integration.create': [{ integration: 'gcal', name: 'Alice Cal', owner: userId(alice.id) }]
			});
			expect(ownCal.kind).toBe('committed');

			// custom email without scope defaults to 'workspace': allows owner = null, refuses owner = member
			const desk = yield* admin.act({
				'sys_integration.create': [{ integration: 'desk_mail', name: 'Support Desk', owner: null }]
			});
			expect(desk.kind).toBe('committed');
			expect(
				yield* Effect.flip(
					admin.act({
						'sys_integration.create': [
							{ integration: 'desk_mail', name: 'Personal Desk', owner: userId(alice.id) }
						]
					})
				)
			).toMatchObject({ _tag: 'ActRefused' });

			// built-in whatsapp has scope: 'both': allows both owner = null and owner = member
			expect(
				(
					yield* admin.act({
						'sys_integration.create': [{ integration: 'whatsapp', name: 'Main WA', owner: null }]
					})
				).kind
			).toBe('committed');
			expect(
				(
					yield* admin.act({
						'sys_integration.create': [
							{ integration: 'whatsapp', name: 'Alice WA', owner: userId(alice.id) }
						]
					})
				).kind
			).toBe('committed');
		})
	);

	it.effect(
		'capabilities.personal_connections grants own-row CRUD on allowed integrations and isolates writes from read-only policies',
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				const bob = t.member(['connector', 'reader']);
				const carol = t.member(['connector']);
				const external = t.member(['connector'], { external: true });
				const bobCaller = yield* t.as(bob);
				const carolCaller = yield* t.as(carol);
				const extCaller = yield* t.as(external);

				// Bob creates his own whatsapp and gcal accounts
				const createdWa = yield* bobCaller.act({
					'sys_integration.create': [
						{ integration: 'whatsapp', name: 'Bob WA', owner: userId(bob.id) }
					]
				});
				expect(createdWa.kind).toBe('committed');
				const waId =
					createdWa.kind === 'committed' ? createdWa.records[0]?.id : undefined;
				if (waId === undefined) throw new Error('Missing created whatsapp id');

				const createdCal = yield* bobCaller.act({
					'sys_integration.create': [{ integration: 'gcal', name: 'Bob Cal', owner: userId(bob.id) }]
				});
				expect(createdCal.kind).toBe('committed');

				// Carol creates her own whatsapp account
				const carolWa = yield* carolCaller.act({
					'sys_integration.create': [
						{ integration: 'whatsapp', name: 'Carol WA', owner: userId(carol.id) }
					]
				});
				expect(carolWa.kind).toBe('committed');
				const carolWaId = carolWa.kind === 'committed' ? carolWa.records[0]?.id : undefined;
				if (carolWaId === undefined) throw new Error('Missing carol whatsapp id');

				// Carol (without reader policy) reads ONLY her own allowed rows
				const carolRows = yield* Schema.decodeUnknownEffect(Integrations)(
					yield* carolCaller.query({
						sys_integration: {
							fields: ['name', 'integration', 'owner', 'active', 'revision'],
							limit: 50
						}
					})
				);
				expect(carolRows.sys_integration.rows.map((r) => [r.integration, r.owner])).toEqual([
					['whatsapp', carol.id]
				]);

				// Refused creates: workspace owner=null, other owner, unallowed integration (email), envoy field, external actor
				expect(
					yield* Effect.flip(
						bobCaller.act({
							'sys_integration.create': [{ integration: 'whatsapp', name: 'Shared', owner: null }]
						})
					)
				).toMatchObject({ _tag: 'ActRefused' });
				expect(
					yield* Effect.flip(
						bobCaller.act({
							'sys_integration.create': [
								{ integration: 'whatsapp', name: 'For Carol', owner: userId(carol.id) }
							]
						})
					)
				).toMatchObject({ _tag: 'ActRefused' });
				expect(
					yield* Effect.flip(
						bobCaller.act({
							'sys_integration.create': [{ integration: 'email', name: 'Bob Mail', owner: userId(bob.id) }]
						})
					)
				).toMatchObject({ _tag: 'ActRefused' });
				const withEnvoy: Record<string, Json> = {
					'sys_integration.create': [
						{ integration: 'whatsapp', name: 'Envoy WA', owner: bob.id, envoy: 'e1' }
					]
				};
				expect(yield* Effect.flip(bobCaller.act(withEnvoy))).toMatchObject({
					_tag: 'ActRefused'
				});
				expect(
					yield* Effect.flip(
						extCaller.act({
							'sys_integration.create': [
								{ integration: 'whatsapp', name: 'Ext WA', owner: userId(external.id) }
							]
						})
					)
				).toMatchObject({ _tag: 'ActRefused' });

				// Even though Bob also holds `reader` (can read Carol's row), Bob CANNOT manage, update or delete Carol's row
				expect(yield* t.integrations.may(bob, waId)).toBe(true);
				expect(yield* t.integrations.may(bob, carolWaId)).toBe(false);
				expect(yield* t.integrations.may(carol, carolWaId)).toBe(true);
				expect(yield* t.integrations.may(carol, waId)).toBe(false);
				expect(
					yield* Effect.flip(
						bobCaller.act({
							'sys_integration.update': [
								{ target: { id: integrationId(carolWaId) }, set: { name: 'Hijacked' } }
							]
						})
					)
				).toMatchObject({ _tag: 'ActRefused' });
				expect(
					yield* Effect.flip(
						bobCaller.act({
							'sys_integration.delete': [{ target: { id: integrationId(carolWaId) } }]
						})
					)
				).toMatchObject({ _tag: 'ActRefused' });

				// Bob CAN update his own account's name, active, and listening scope (`listen`), and delete it
				expect(
					(
						yield* bobCaller.act({
							'sys_integration.update': [
								{
									target: { id: integrationId(waId) },
									set: {
										name: 'Bob Phone',
										listen: {
											dm: { mode: 'selected', handles: ['+65 9000 0010'] },
											groups: { mode: 'selected', threads: [{ id: 'proj-grp@g.us', label: 'Project A' }] }
										}
									}
								}
							]
						})
					).kind
				).toBe('committed');

				// Ingest filter: allowed DM & allowed group are stored; unrelated chats are skipped yet recorded in bolt_seen_thread
				yield* t.receive(waId, [
					{
						id: 'm-dm-ok',
						thread: '6590000010@s.whatsapp.net',
						from: { handle: '6590000010@s.whatsapp.net', name: 'Client VIP' },
						text: 'Allowed DM',
						attachments: [],
						sent_at: t.clock.now()
					},
					{
						id: 'm-dm-skip',
						thread: '6599999999@s.whatsapp.net',
						from: { handle: '6599999999@s.whatsapp.net', name: 'Personal Friend' },
						text: 'Ignore me',
						attachments: [],
						sent_at: t.clock.now()
					},
					{
						id: 'm-grp-ok',
						thread: 'proj-grp@g.us',
						group: true,
						title: 'Project A',
						from: { handle: '6591111111@s.whatsapp.net', name: 'Teammate' },
						text: 'Allowed group',
						attachments: [],
						sent_at: t.clock.now()
					},
					{
						id: 'm-grp-skip',
						thread: 'family-grp@g.us',
						group: true,
						title: 'Family Chat',
						from: { handle: '6592222222@s.whatsapp.net', name: 'Family' },
						text: 'Private family',
						attachments: [],
						sent_at: t.clock.now()
					}
				]);
				const storedTexts = (
					yield* t.db.rows(Schema.Struct({ text: Schema.NullOr(Schema.String) }), {
						text: 'SELECT text FROM sys_message WHERE integration = $1 ORDER BY text',
						params: [waId]
					})
				).map((r) => r.text);
				expect(storedTexts).toEqual(['Allowed DM', 'Allowed group']);
				const seenThreads = (
					yield* t.db.rows(Schema.Struct({ thread: Schema.String, kind: Schema.String }), {
						text: 'SELECT thread, kind FROM bolt_seen_thread WHERE instance = $1 ORDER BY thread',
						params: [waId]
					})
				).map((r) => `${r.kind}:${r.thread}`);
				expect(seenThreads).toEqual([
					'dm:6590000010@s.whatsapp.net',
					'dm:6599999999@s.whatsapp.net',
					'group:family-grp@g.us',
					'group:proj-grp@g.us'
				]);

				expect(
					(
						yield* bobCaller.act({
							'sys_integration.update': [
								{ target: { id: integrationId(waId) }, set: { active: false } }
							]
						})
					).kind
				).toBe('committed');
				expect(
					(
						yield* bobCaller.act({
							'sys_integration.delete': [{ target: { id: integrationId(waId) } }]
						})
					).kind
				).toBe('committed');
			})
	);
});

describe('shell personal connections route', () => {
	it('parses /connections and gates it in navigation_paths', () => {
		expect(route(manifest, new URL('https://workspace.test/connections'))).toEqual({
			kind: 'connections'
		});
		expect(navigation_paths([], false, true)).toContain('/connections');
		expect(navigation_paths([], false, false)).not.toContain('/connections');
	});
});
