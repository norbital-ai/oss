// At 17:30 UTC it is already the next day in Kuala Lumpur: `ctx.today` and an act's `{ today }` default use that workspace
// day. File and integration authorization use a policy with the same fixed, materialized cutoff.
import { randomBytes, randomUUID } from 'node:crypto';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { credentials } from '../src/engine/integrations/credentials.ts';
import { integrationLinks } from '../src/engine/integrations/links.ts';
import { loopbackTcpPort } from '../src/node/tcp.ts';
import { Secrets } from '../src/engine/secrets.ts';
import { bindings } from '../src/protocol/http.ts';
import { IntegrationManager, integrationRoutes } from '../src/protocol/integrations.ts';
import { KitInvalid, TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const NOW = '2026-10-14T17:30:00.000Z'; // 01:30 on 15 October in Kuala Lumpur
const TODAY = '2026-10-15';
const ORIGIN = 'http://cell';
const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'Asia/Kuala_Lumpur', locale: 'en' },
		models: {
			notes: {
				description: 'A note',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					due: { kind: 'date', optional: true, default: { var: 'today' } },
					photo: { kind: 'file', accept: ['image/png'], max: '1MiB', optional: true }
				}
			}
		},
		relationships: {},
		exposures: {
			notes: {
				read: { notes: { fields: 'all' } },
				create: { columns: { notes: ['title', 'due', 'photo'] }, transform: true }
			}
		},
		integrations: {},
		// The policy's cutoff is a concrete date; clock operands are not part of query grammar.
		policies: {
			reader: {
				description: 'Reads due notes',
				grants: { notes: { read: { notes: { where: { due: { lte: TODAY } } } } } }
			}
		},
		teams: { Readers: { name: 'Readers', policies: ['reader'] } },
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);
const guest = program(
	`export default { model: { notes: { bodies: { create: function* (rows, ctx) { return rows.map((row) => row.title === 'stamp' ? { ...row, title: ctx.today } : row); } } } } };`
);
const json = (response: Response) =>
	Effect.tryPromise({
		try: () => response.json(),
		catch: (error) => new KitInvalid({ message: String(error) })
	});

it.live(
	'binds ctx.today and defaults to the workspace day, and authorizes files and integrations at a fixed cutoff',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest,
						guest: yield* guest,
						now: NOW,
						secretsKey: Redacted.make(randomBytes(32))
					})
				);
				const t = Context.get(context, TestWorkspace);
				expect(yield* bindings.pipe(Effect.provide(context))).toEqual({
					now: NOW,
					today: TODAY,
					tz: 'Asia/Kuala_Lumpur'
				});
				const admin = t.member([], { admin: true }),
					reader = t.member(['reader'], { teams: ['Readers'] });
				const cookies = { admin: yield* t.session(admin.id), reader: yield* t.session(reader.id) };
				const post = (path: string, body: unknown) =>
					t.handle(
						new Request(`${ORIGIN}${path}`, {
							method: 'POST',
							headers: {
								cookie: cookies.admin,
								'content-type': 'application/json',
								'Idempotency-Key': randomUUID()
							},
							body: JSON.stringify(body)
						})
					);
				const due = (title: string) =>
					t.db
						.read([
							{ text: 'SELECT due::text AS due FROM notes WHERE title = $1', params: [title] }
						])
						.pipe(Effect.map((rows) => rows[0]?.rows[0]?.['due']));

				// a write callback's body sees the workspace day
				expect(
					yield* json(
						yield* post('/__bolt/act', {
							callable: 'notes.create',
							input: [{ title: 'stamp' }],
							issuedAt: NOW
						})
					)
				).toMatchObject({ outcome: { kind: 'committed' } });
				expect(yield* due(TODAY)).toBe(TODAY);

				// `/act`: a `{ today }` default lands on the workspace day
				expect(
					yield* json(
						yield* post('/__bolt/act', {
							callable: 'notes.create',
							input: [{ title: 'defaulted' }],
							issuedAt: NOW
						})
					)
				).toMatchObject({ outcome: { kind: 'committed' } });
				expect(yield* due('defaulted')).toBe(TODAY);

				// the files handler: a note due today is the reader's, and so is the file it holds
				const file = (
					as: keyof typeof cookies,
					method: string,
					rest: string,
					body: Uint8Array<ArrayBuffer> | null = null
				) =>
					t.handle(
						new Request(`${ORIGIN}/__bolt/files/${rest}`, {
							method,
							headers: {
								cookie: cookies[as],
								'content-type': 'image/png',
								'Idempotency-Key': randomUUID(),
								'content-disposition': `attachment; filename*=UTF-8''pump.png`
							},
							body
						})
					);
				const photo = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String })
				)(yield* json(yield* file('admin', 'PUT', 'notes.photo', new Uint8Array([1, 2, 3]))));
				expect(
					yield* json(
						yield* post('/__bolt/act', {
							callable: 'notes.create',
							input: [
								{
									title: 'held',
									due: TODAY,
									photo: { id: photo.id, name: photo.name, mime: photo.mime }
								}
							],
							issuedAt: NOW
						})
					)
				).toMatchObject({ outcome: { kind: 'committed' } });
				expect((yield* file('reader', 'GET', photo.id)).status).toBe(200);

				// the integrations handler: the verbs authorize on the native activation's workspace day
				const seen: string[] = [];
				const links = yield* integrationLinks({
					providers: [],
					credentials: yield* credentials(t.db, Context.get(context, Secrets)).pipe(
						Effect.provide(NodeCrypto.layer)
					),
					publicUrl: ORIGIN,
					tcp: loopbackTcpPort,
					log: () => {},
					enter: (work) =>
						Effect.gen(function* () {
							const b = yield* bindings;
							seen.push(b.today);
							return yield* work;
						}).pipe(Effect.provide(context)),
					admit: (work) => work.pipe(Effect.provide(context))
				}).pipe(Effect.provide(NodeCrypto.layer));
				const response = yield* integrationRoutes(
					HttpServerRequest.fromWeb(
						new Request(`${ORIGIN}/__bolt/integrations/none`, {
							headers: { cookie: cookies.admin }
						})
					)
				).pipe(
					Effect.provideService(IntegrationManager, Option.some(links)),
					Effect.provide(context)
				);
				expect(
					Option.isSome(response) ? HttpServerResponse.toWeb(response.value).status : 404
				).toBe(404);
				expect(seen).toEqual([TODAY]);
			})
		)
);
