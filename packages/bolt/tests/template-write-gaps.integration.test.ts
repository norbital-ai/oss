// Gaps the template migration found in the write area, one reproduction each: collection
// notifications on an ordinary commit (rule 47), writing an exclusive arc (polymorphic ref), json `shape` on write, a
// model check's authored message, `accept: ['*/*']` at upload, an automation calling a collection action, `revision`
// as a model field, and an FK to `sys_user` read back through its relation.
import { describe, expect, it } from '@effect/vitest';
import type { Authority, Outcome } from '../src/engine/contracts.ts';
import { load, manifestErrors } from '../src/compiler/load.ts';
import { TestWorkspace } from '../src/test/index.ts';

import { Context, Effect, Layer, Option, Result, Schema } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import type { Json } from '../src/decl/values.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { program } from './support/guest-fixture.ts';
import { actFailure } from '../src/decl/errors.ts';
import { uuidv7 } from '../src/protocol/wire.ts';

const U = '019fc6bb-7f21-76fd-8597-7de44181da68';
const empty = {
	integrations: {},
	pipelines: {},
	teams: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const manifest = Result.getOrThrow(
	decodeManifest({
		...empty,
		teams: { 't-rd': { name: 'R&D', policies: ['ops'] }, 't-qa': { name: 'QA', policies: [] } },
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			projects: {
				description: 'A project',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					profile: {
						kind: 'json',
						optional: true,
						shape: {
							kind: 'object',
							fields: {
								grade: { kind: 'enum', values: ['a', 'b'] },
								weight: { kind: 'number', optional: true }
							}
						}
					},
					stock: { kind: 'int', default: 0 },
					doc: { kind: 'file', accept: ['*/*'], max: '1MiB', optional: true }
				},
				check: {
					stock_not_negative: {
						where: { stock: { gte: 0 } },
						message: 'Stock cannot go below zero.'
					},
					bare: { stock: { lte: 1000 } }
				}
			},
			quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } },
			activities: {
				description: 'An activity',
				label: 'subject',
				fields: { subject: { kind: 'text' } }
			},
			cases: { description: 'A case', label: 'title', fields: { title: { kind: 'text' } } },
			classifications: {
				description: 'A classification',
				label: 'note',
				fields: { note: { kind: 'text' } }
			}
		},
		relationships: {
			'activities.regarding': { to: ['projects', 'quotes'], optional: true, inverse: 'activities' },
			'projects.owner': { to: 'sys_user', optional: true, default: { actor: 'id' } },
			'classifications.case': { to: 'cases', inverse: 'classifications' }
		},
		collections: {
			projects: {
				read: { fields: 'all', relations: 'all' },
				create: { input: { columns: ['title', 'profile', 'stock', 'doc', 'owner'] } },
				update: { input: { columns: ['title', 'profile', 'stock', 'owner'] } },
				notifications: {
					committed: [
						{
							channel: 'inbox',
							to: [{ team: 't-rd' }],
							on: { action: ['create'] },
							title: { one: 'New project', many: '{count} new projects' }
						},
						{
							channel: 'inbox',
							to: [{ user: 'owner' }, 'requestor'],
							on: { action: ['update'] },
							title: 'Project changed'
						}
					]
				}
			},
			quotes: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } },
			activities: {
				read: { fields: 'all', relations: 'all' },
				create: { input: { columns: ['subject', 'regarding'] } },
				update: { input: { columns: ['regarding'] } }
			},
			cases: {
				read: { fields: 'all' },
				create: { input: { columns: ['title'] } },
				notifications: {
					committed: [{ channel: 'inbox', to: [{ team: 't-qa' }], title: 'Case raised' }]
				},
				actions: {
					raise: {
						description: 'Raise a case with its classification',
						input: { title: { kind: 'text' } },
						output: { kind: 'text' }
					}
				}
			},
			classifications: { read: { fields: 'all' }, create: { input: { columns: ['note', 'case'] } } }
		},
		policies: {
			ops: {
				description: 'Ops',
				automations: ['file'],
				grants: {
					cases: { read: true, create: true, actions: ['raise'] },
					classifications: { read: true, create: true },
					projects: { read: { owner: { eq: { actor: 'id' } } }, create: true, update: 'read' }
				}
			}
		},
		automations: {
			file: { description: 'Files a scan', input: { title: { kind: 'text' } }, runAs: ['ops'] }
		}
	})
);
const guest = program(`export default {
	collection: { cases: { bodies: { queries: {}, actions: {
		raise: function* (input, ctx) {
			const c = yield* ctx.act('cases.create', { title: input.title });
			yield* ctx.act('classifications.create', { note: 'auto', case: c.records[0].id });
			return c.records[0].id;
		},
	} } } },
	automation: { file: { body: function* (input, ctx) { yield* ctx.act('cases.raise', { title: input.title }); } } },
};`);

const ok = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const recordId = (o: Outcome) => {
	const record = ok(o).records[0];
	if (record === undefined) throw new Error('create returned no record');
	return record.id;
};
const Page = Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) });
const setup = () =>
	Effect.gen(function* () {
		const context = yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest }));
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context);
		// L-BOLT-354: inbox notices fan out to members on file — Ana is R&D, Quinn is QA
		yield* t.db.write({
			text: `INSERT INTO sys_user (id, email, name, kind, admin, team) VALUES
		($1, 'a@x.test', 'Ana', 'staff', false, 't-rd'), ('u-qa', 'q@x.test', 'Quinn', 'staff', false, 't-qa')`,
			params: [U]
		});
		const rows = (sql: string) =>
			t.db.rows(Schema.Record(Schema.String, Schema.Json), { text: sql, params: [] });
		const caller = (authority: Authority) => ({
			act: (callable: string, input: Json) =>
				actReply(route, authority, { callable, input, issuedAt: t.clock.now() }).pipe(
					Effect.flatMap((reply) => {
						const failure = actFailure(reply.outcome);
						return Option.isSome(failure)
							? Effect.fail(failure.value)
							: Effect.succeed(reply.outcome);
					})
				),
			get: (collection: string, id: string, query: Json = {}) =>
				qReply(route, authority, { reads: [{ m: 'get', a: [collection, id, query] }] }).pipe(
					Effect.flatMap((reply) => Schema.decodeUnknownEffect(Schema.Json)(reply.answers[0]))
				),
			read: (collection: string, query: Json) =>
				qReply(route, authority, { reads: [{ m: 'read', a: [collection, query] }] }).pipe(
					Effect.flatMap((reply) => Schema.decodeUnknownEffect(Page)(reply.answers[0]))
				),
			upload: t.as(authority).upload
		});
		return { t, rows, route, caller, A: caller(t.as(t.admin).authority) };
	});

describe('write gaps found by the template migration', () => {
	it.live(
		"an ordinary commit writes the collection's `committed` notices in its statement (rule 47)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, rows, A } = yield* setup();
					ok(
						yield* A.act('projects.create', [
							{ title: 'a', owner: U },
							{ title: 'b', owner: U }
						])
					);
					expect(yield* rows(`SELECT recipient, title, link FROM sys_notification`)).toEqual([
						{
							recipient: { channel: 'inbox', recipients: [{ team: 't-rd' }] },
							title: '2 new projects',
							link: null
						}
					]);
					const id = recordId(yield* A.act('projects.create', { title: 'c' }));
					expect(
						(yield* rows(`SELECT title, link FROM sys_notification ORDER BY at, title`)).map(
							(r) => r['title']
						)
					).toContain('New project');
					if (t.admin.actor.kind !== 'member') throw new Error('admin actor is not a member');
					const actor = t.admin.actor.id;
					ok(yield* A.act('projects.update', { target: id, set: { title: 'c2', owner: U } }));
					expect(
						yield* rows(
							`SELECT DISTINCT recipient, link FROM sys_notification WHERE title = 'Project changed'`
						)
					).toEqual([
						{
							recipient: { channel: 'inbox', recipients: [{ user: U }, { user: actor }] },
							link: { collection: 'projects', id }
						}
					]);
				})
			)
	);

	it.live('a batch create answers its records in input order', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { rows, A } = yield* setup();
				const titles = ['A1', 'A5', 'A2', 'A3', 'A4', 'A0'];
				const out = ok(
					yield* A.act(
						'quotes.create',
						titles.map((title) => ({ title }))
					)
				);
				const byId = new Map(
					(yield* rows(`SELECT id::text, title FROM quotes`)).map((r) => [r['id'], r['title']])
				);
				expect(out.records.map((r) => byId.get(r.id))).toEqual(titles);
			})
		)
	);

	it.live("an action's recorded writes carry their notices into the action's statement", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { rows, A } = yield* setup();
				ok(yield* A.act('cases.raise', { title: 'x' }));
				expect(yield* rows(`SELECT title FROM sys_notification`)).toEqual([
					{ title: 'Case raised' }
				]);
			})
		)
	);

	it.live('writes an exclusive arc (polymorphic reference) and reads it back as a RecordRef', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { A } = yield* setup();
				const q = recordId(yield* A.act('quotes.create', { title: 'q' }));
				const p = recordId(yield* A.act('projects.create', { title: 'p' }));
				const a = recordId(
					yield* A.act('activities.create', {
						subject: 's',
						regarding: { collection: 'quotes', id: q }
					})
				);
				expect(yield* A.get('activities', a)).toMatchObject({
					regarding: { collection: 'quotes', id: q }
				});
				ok(
					yield* A.act('activities.update', {
						target: a,
						set: { regarding: { collection: 'projects', id: p } }
					})
				);
				expect(yield* A.get('activities', a)).toMatchObject({
					regarding: { collection: 'projects', id: p }
				});
				expect(
					yield* Effect.flip(
						A.act('activities.create', { subject: 's', regarding: { collection: 'cases', id: q } })
					)
				).toMatchObject({ _tag: 'ActRefused', code: 'invalidInput', field: 'regarding' });
				expect(
					yield* Effect.flip(
						A.act('activities.create', {
							subject: 's',
							regarding: { collection: 'projects', id: q }
						})
					)
				).toMatchObject({ _tag: 'ActRefused', code: 'notFound', field: 'regarding' });
			})
		)
	);

	it.live('checks a json field against its declared shape on write', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { A } = yield* setup();
				ok(yield* A.act('projects.create', { title: 'p', profile: { grade: 'a', weight: 2 } }));
				expect(
					yield* Effect.flip(A.act('projects.create', { title: 'p2', profile: { grade: 'z' } }))
				).toMatchObject({ _tag: 'ActRefused', code: 'invalidInput', field: 'profile' });
				expect(
					yield* Effect.flip(
						A.act('projects.create', { title: 'p3', profile: { grade: 'a', extra: 1 } })
					)
				).toMatchObject({ _tag: 'ActRefused', code: 'invalidInput', field: 'profile' });
			})
		)
	);

	it.live('refuses a broken model check with its authored message', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { A } = yield* setup();
				expect(
					yield* Effect.flip(A.act('projects.create', { title: 'p', stock: -1 }))
				).toMatchObject({
					_tag: 'ActRefused',
					code: 'check',
					message: 'Stock cannot go below zero.'
				});
				expect(
					yield* Effect.flip(A.act('projects.create', { title: 'p', stock: 1001 }))
				).toMatchObject({
					_tag: 'ActRefused',
					code: 'check',
					message: "the record breaks the rule 'bare'"
				});
			})
		)
	);

	it.live("accepts any type at upload to `accept: ['*/*']`", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { A } = yield* setup();
				for (const mime of ['application/x-anything', 'audio/ogg', ''])
					expect(
						yield* A.upload('projects.doc', { name: 'f', mime, bytes: new Uint8Array([1]) })
					).toMatchObject({ kind: 'committed' });
			})
		)
	);

	it.live('an automation calls a collection action through ctx.act, its writes in one act', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, rows, route } = yield* setup();
				ok(
					(yield* actReply(route, t.as(t.member(['ops'])).authority, {
						callable: 'start',
						input: {
							automation: 'file',
							input: { title: 'scan' },
							id: uuidv7(Date.parse(t.clock.now()))
						},
						issuedAt: t.clock.now()
					})).outcome
				);
				yield* t.runDue();
				expect(yield* rows(`SELECT state FROM sys_run`)).toEqual([{ state: 'succeeded' }]);
				expect(
					yield* rows(
						`SELECT c.title, k.note FROM cases c JOIN classifications k ON k."case" = c.id`
					)
				).toEqual([{ title: 'scan', note: 'auto' }]);
			})
		)
	);

	it.live('an FK to sys_user writes, defaults to the actor and reads through its relation', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, A, caller } = yield* setup();
				const M = caller(yield* t.signIn('a@x.test'));
				const id = recordId(yield* M.act('projects.create', { title: 'mine' }));
				expect(
					yield* A.get('projects', id, { select: { title: true, owner: { name: true } } })
				).toMatchObject({ title: 'mine', owner: { name: 'Ana' } });
				expect(
					yield* M.get('projects', id, { select: { title: true, owner: { name: true } } })
				).toMatchObject({ title: 'mine', owner: { name: 'Ana' } });
				expect(
					(yield* M.read('projects', {
						select: { title: true, owner: { name: true } },
						where: { owner: { eq: U } },
						all: true
					})).rows
				).toEqual([
					expect.objectContaining({
						title: 'mine',
						owner: expect.objectContaining({ name: 'Ana' })
					})
				]);
				expect(
					(yield* A.read('sys_user', {
						select: { name: true },
						where: { id: { eq: U } },
						all: true
					})).rows
				).toEqual([{ id: U, name: 'Ana' }]);
			})
		)
	);

	it.live('`revision` as a model field is a clear build error (a system column)', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { manifest: m } = yield* load('', []).pipe(
					Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
				);
				m.model['docs'] = {
					description: 'd',
					label: 'title',
					fields: { title: { kind: 'text' }, revision: { kind: 'text' } }
				};
				expect(manifestErrors(m)).toEqual([
					expect.objectContaining({
						code: 'load/reserved-field',
						path: 'src/data/model/+docs.model.ts',
						message: expect.stringContaining("'revision' is a system column")
					})
				]);
			})
		)
	);
});
