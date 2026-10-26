// `/__bolt/files` (`filesHandler`): uploads through the engine's files port; a download is the uploader's, a reader's of
// a row holding it, or, for a message attachment, the conversation's owner, participants and (an instance's threads) staff.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from '@effect/vitest';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { HttpServerRequest } from 'effect/unstable/http';
import { Agents } from '../src/engine/services.ts';
import { Files } from '../src/engine/ports.ts';
import { actReply, json, routeFixture } from './support/route-fixture.ts';
import type { Authority } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { actorRef } from '../src/engine/write/commit.ts';
import { filesRoutes } from '../src/protocol/files.ts';
import { ImagePreviewsLive } from '../src/protocol/image-previews.ts';
import { RateLimits } from '../src/protocol/http.ts';
import { KitInvalid, TestWorkspace } from '../src/test/index.ts';
import { filesOf } from '../src/engine/conversations/store.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	models: {},
	relationships: {},
	collections: {},
	policies: {},
	agent: { internal: 'Staff brief.', external: 'External brief.', skills: {} },
	integrations: {},
	teams: {},
	automations: {},
	connections: { whatsapp: { integration: 'whatsapp' } },
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {}
} satisfies EngineManifest;

it.live(
	'message attachments download for the conversation, not for every member',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
				const t = Context.get(context, TestWorkspace),
					agents = Context.get(context, Agents),
					route = yield* routeFixture(context);
				yield* t.db.write({
					text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ('root', 'r@x.test', 'Root', 'staff', true), ('ann', 'a@x.test', 'Ann', 'staff', false),
		('bob', 'b@x.test', 'Bob', 'staff', false), ('eve', 'e@x.test', 'Eve', 'external', false)`,
					params: []
				});
				const who: { [id: string]: Authority } = {};
				for (const id of ['root', 'ann', 'bob', 'eve']) {
					const authority = yield* new Authorities(manifest, 'test').member(t.db, id);
					if (authority === null) throw new Error(`Missing ${id}`);
					who[id] = authority;
				}
				const call = (
					as: string,
					method: string,
					rest: string,
					body?: Uint8Array<ArrayBuffer>,
					mime = 'image/png',
					name = 'pump.png'
				) =>
					route.handle(
						who[as] ?? null,
						new Request(`http://cell/__bolt/files/${rest}`, {
							method,
							headers: {
								'x-as': as,
								'content-type': mime,
								'Idempotency-Key': randomUUID(),
								'content-disposition': `attachment; filename*=UTF-8''${name}`
							},
							...(body === undefined ? {} : { body })
						})
					);
				const File = Schema.Struct({
					id: Schema.String,
					name: Schema.String,
					mime: Schema.String,
					bytes: Schema.Number
				});
				const up = (as: string) =>
					call(as, 'PUT', 'sys_conversation.inputs', new Uint8Array([1, 2, 3])).pipe(
						Effect.flatMap(json),
						Effect.flatMap(Schema.decodeUnknownEffect(File))
					);
				const status = (as: string, id: string) =>
					call(as, 'GET', id).pipe(Effect.map((response) => response.status));

				expect(
					Option.isNone(
						yield* filesRoutes(HttpServerRequest.fromWeb(new Request('http://cell/__bolt/q'))).pipe(
							Effect.provide(ImagePreviewsLive),
							Effect.provide(RateLimits.layer),
							Effect.provide(context)
						)
					)
				).toBe(true);
				expect(yield* status('nobody', randomUUID())).toBe(401);
				const panel = yield* up('ann');
				expect(panel).toMatchObject({ name: 'pump.png', mime: 'image/png', bytes: 3 });
				const down = yield* call('ann', 'GET', panel.id);
				expect(down.status).toBe(200); // the uploader, before the message is sent
				expect([
					...new Uint8Array(
						yield* Effect.tryPromise({
							try: () => down.arrayBuffer(),
							catch: (error) => new KitInvalid({ message: String(error) })
						})
					)
				]).toEqual([1, 2, 3]);
				expect(yield* status('bob', panel.id)).toBe(404);
				const heic = yield* Schema.decodeUnknownEffect(File)(
					yield* json(
						yield* call(
							'ann',
							'PUT',
							'sys_conversation.inputs',
							new Uint8Array(readFileSync(new URL('./fixtures/files/photo.heic', import.meta.url))),
							'image/heic',
							'photo.heic'
						)
					)
				);
				const files: Effect.Success<typeof Files> = Context.get(context, Files);
				const get = vi.spyOn(files, 'get');
				yield* Effect.addFinalizer(() => Effect.sync(() => get.mockRestore()));
				const preview = yield* call('ann', 'GET', `${heic.id}?preview=512`);
				expect(preview.headers.get('content-type')).toBe('image/jpeg');
				expect(preview.headers.get('cache-control')).toBe('private, max-age=3600');
				expect(get).toHaveBeenCalledTimes(1);
				expect([
					...new Uint8Array(
						yield* Effect.tryPromise({
							try: () => preview.arrayBuffer(),
							catch: (error) => new KitInvalid({ message: String(error) })
						})
					).subarray(0, 3)
				]).toEqual([0xff, 0xd8, 0xff]);
				expect(yield* status('bob', `${heic.id}?preview=512`)).toBe(404);
				expect(get).toHaveBeenCalledTimes(1);
				expect(yield* status('ann', `${heic.id}?preview=512`)).toBe(200);
				expect(get).toHaveBeenCalledTimes(1);
				expect(yield* status('ann', `${heic.id}?preview=65`)).toBe(400);
				expect(yield* status('bob', `${heic.id}?preview=65`)).toBe(404);
				expect(get).toHaveBeenCalledTimes(1);
				const original = yield* call('ann', 'GET', heic.id);
				expect(original.headers.get('content-type')).toBe('image/heic');
				expect(
					new Uint8Array(
						yield* Effect.tryPromise({
							try: () => original.arrayBuffer(),
							catch: (error) => new KitInvalid({ message: String(error) })
						})
					)
				).toEqual(
					new Uint8Array(readFileSync(new URL('./fixtures/files/photo.heic', import.meta.url)))
				);
				expect(get).toHaveBeenCalledTimes(2);

				// an in-app conversation: its owner, a member who posted in it, and an administrator
				const conversation = yield* agents.start({ owner: 'ann' });
				yield* agents.post({
					conversation,
					as: { member: 'ann' },
					text: 'see this',
					files: [panel]
				});
				const [row] = present(
					(yield* t.db.read([
						{
							text: `SELECT content, ${filesOf('m')} AS files FROM sys_message m WHERE conversation = $1`,
							params: [conversation]
						}
					]))[0]
				).rows;
				expect(row).toMatchObject({ content: { text: 'see this' }, files: [{ id: panel.id }] }); // one copy: the files column
				expect(
					(yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
						row?.['content']
					))['files']
				).toBeUndefined();
				expect(yield* status('bob', panel.id)).toBe(404);
				expect(yield* status('root', panel.id)).toBe(200);
				yield* agents.post({ conversation, as: { member: 'bob' }, text: 'on it' });
				expect(yield* status('bob', panel.id)).toBe(200);

				// an instance's thread of no public envoy: only a participant reads it (a staff member too is refused), an external member as its linked sender
				const inbound = yield* up('root');
				yield* t.db.write({
					// as an ingest stores it: among the conversation's inputs, naming its message
					text: `INSERT INTO sys_conversation (id, integration, inputs) VALUES ('wa-1', 'whatsapp', $1::jsonb)`,
					params: [
						JSON.stringify([
							{ id: inbound.id, name: 'pump.png', mime: 'image/png', bytes: 3, message: 'm-1' }
						])
					]
				});
				yield* t.db.write({
					text: `INSERT INTO sys_message (id, conversation, integration, text) VALUES ('m-1', 'wa-1', 'whatsapp', 'photo')`,
					params: []
				});
				expect(yield* status('ann', inbound.id)).toBe(404);
				expect(yield* status('eve', inbound.id)).toBe(404);
				yield* t.db.write({
					text: `INSERT INTO sys_message (id, conversation, integration, text, "as") VALUES ('m-2', 'wa-1', 'whatsapp', 'mine', $1::jsonb)`,
					params: [
						JSON.stringify({
							envoy: { name: 'desk', instance: 'whatsapp', sender: '+65', member: 'eve', dm: true }
						})
					]
				});
				expect(yield* status('eve', inbound.id)).toBe(200);
			})
		),
	30_000
);

it.live(
	"a message attachment filed into a record downloads for that record's readers, as any file field does",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const filed = {
					...manifest,
					models: {
						photos: {
							description: 'A photo',
							label: 'name',
							fields: {
								name: { kind: 'text' },
								photo: { kind: 'file', accept: ['image/png'], max: '20MiB' }
							}
						}
					},
					collections: {
						photos: { read: { fields: 'all' }, create: { input: { columns: ['name', 'photo'] } } }
					}
				} satisfies EngineManifest;
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: filed }));
				const t = Context.get(context, TestWorkspace),
					route = yield* routeFixture(context);
				yield* t.db.write({
					text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ('root', 'r@x.test', 'Root', 'staff', true), ('ann', 'a@x.test', 'Ann', 'staff', false),
		('bob', 'b@x.test', 'Bob', 'staff', false)`,
					params: []
				});
				const who: { [id: string]: Authority } = {};
				for (const id of ['root', 'ann', 'bob']) {
					const authority = yield* new Authorities(filed, 'test').member(t.db, id);
					if (authority === null) throw new Error(`Missing ${id}`);
					who[id] = authority;
				}
				const call = (as: string, method: string, rest: string, body?: Uint8Array<ArrayBuffer>) =>
					route.handle(
						who[as] ?? null,
						new Request(`http://cell/__bolt/files/${rest}`, {
							method,
							headers: {
								'x-as': as,
								'content-type': 'image/png',
								'Idempotency-Key': randomUUID(),
								'content-disposition': `attachment; filename*=UTF-8''pump.png`
							},
							...(body === undefined ? {} : { body })
						})
					);
				const photo = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String })
				)(
					yield* json(
						yield* call('ann', 'PUT', 'sys_conversation.inputs', new Uint8Array([1, 2, 3]))
					)
				);
				expect((yield* call('root', 'GET', photo.id)).status).toBe(404); // Ann's, in no conversation the administrator reads
				const o = (yield* actReply(route, t.as(t.admin).authority, {
					callable: 'photos.create',
					input: { name: 'pump', photo: { id: photo.id, name: photo.name, mime: photo.mime } },
					issuedAt: t.clock.now()
				})).outcome;
				expect(o.kind).toBe('committed');
				expect((yield* call('root', 'GET', photo.id)).status).toBe(200); // the record's reader
				expect((yield* call('bob', 'GET', photo.id)).status).toBe(404); // no grant on photos
			})
		)
);

it.live(
	'automation files download only when a full readable run returns their declared file reference',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const file = { kind: 'file', accept: ['*/*'], max: '20MiB', multiple: true } as const;
				const handover = {
					...manifest,
					policies: {
						controller: {
							description: 'Reads handovers',
							grants: {},
							automations: ['handover']
						}
					},
					automations: {
						handover: {
							description: 'Produces handover files',
							runAs: 'trigger',
							output: {
								kind: 'object',
								fields: {
									files: file,
									opaque: { kind: 'json' },
									lookalike: {
										kind: 'object',
										fields: { id: { kind: 'text' }, name: { kind: 'text' }, mime: { kind: 'text' } }
									}
								}
							}
						},
						other_handover: { description: 'Another file owner', runAs: 'trigger', output: file }
					}
				} satisfies EngineManifest;
				const context = yield* Layer.build(TestWorkspace.layer({ manifest: handover }));
				const t = Context.get(context, TestWorkspace),
					route = yield* routeFixture(context),
					files = Context.get(context, Files);
				const starter = t.member([]),
					controller = t.member(['controller']),
					stranger = t.member([]);
				const who = {
					starter: t.as(starter).authority,
					controller: t.as(controller).authority,
					stranger: t.as(stranger).authority,
					admin: t.as(t.admin).authority
				};
				const put = Effect.fnUntraced(function* (name: string, owner = 'handover') {
					const bytes = new Uint8Array([1, 2, 3]);
					const blob = yield* files.put(bytes, { name, mime: 'application/octet-stream' });
					const ref = { id: randomUUID(), name, mime: 'application/octet-stream' };
					yield* t.db.write({
						text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
						params: [ref.id, name, ref.mime, bytes.byteLength, blob.key, blob.sha256, owner]
					});
					return ref;
				});
				const returned = yield* put('handover.bin'),
					intermediate = yield* put('intermediate.bin'),
					opaque = yield* put('opaque.bin'),
					lookalike = yield* put('lookalike.bin'),
					wrongOwner = yield* put('other-owner.bin', 'other_handover'),
					actorOnly = yield* put('actor-only.bin');
				yield* t.db.write({
					text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, output, actor, starter) VALUES ('handover-run','handover','{}',now(),'manual',0,'succeeded',$1::jsonb,$2,$3::jsonb), ('actor-only-run','handover','{}',now(),'manual',0,'succeeded',$4::jsonb,$5,$3::jsonb)`,
					params: [
						JSON.stringify({ files: [returned, wrongOwner], opaque, lookalike }),
						actorRef(starter.actor),
						JSON.stringify(starter),
						JSON.stringify({ files: [actorOnly] }),
						actorRef(stranger.actor)
					]
				});
				// An earlier matching id in opaque JSON must not hide a later declared, readable file.
				yield* t.db.write({
					text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, output, starter) VALUES ('a-opaque-candidate','handover','{}',now(),'manual',0,'succeeded',$1::jsonb,$2::jsonb)`,
					params: [JSON.stringify({ opaque: returned }), JSON.stringify(starter)]
				});
				const download = (as: keyof typeof who, id: string) =>
					route.handle(who[as], new Request(`http://cell/__bolt/files/${id}`));
				for (const as of ['starter', 'controller', 'admin'] as const)
					expect((yield* download(as, returned.id)).status).toBe(200);
				const response = yield* download('starter', returned.id);
				expect(response.headers.get('content-disposition')).toContain('handover.bin');
				expect(
					new Uint8Array(
						yield* Effect.tryPromise({
							try: () => response.arrayBuffer(),
							catch: (error) => new KitInvalid({ message: String(error) })
						})
					)
				).toEqual(new Uint8Array([1, 2, 3]));
				expect((yield* download('stranger', returned.id)).status).toBe(404);
				expect((yield* download('stranger', actorOnly.id)).status).toBe(404);
				expect((yield* download('controller', actorOnly.id)).status).toBe(200);
				for (const file of [intermediate, opaque, lookalike, wrongOwner])
					for (const as of ['starter', 'controller'] as const)
						expect((yield* download(as, file.id)).status).toBe(404);
				expect((yield* download('admin', intermediate.id)).status).toBe(200);
				for (const forged of [
					{ ...returned, path: '/private/secret' },
					{ ...returned, mime: 7 }
				]) {
					yield* t.db.write({
						text: `UPDATE sys_run SET output = $1::jsonb WHERE id = 'handover-run'`,
						params: [JSON.stringify({ files: [forged] })]
					});
					expect((yield* download('starter', returned.id)).status).toBe(404);
					expect((yield* download('controller', returned.id)).status).toBe(404);
				}
			})
		)
);
