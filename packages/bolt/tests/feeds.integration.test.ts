// Feeds on PGlite (§4.1): one page is one statement (rows, cursor and markers together), a run killed between pages
// leaves every row exactly once and the cursor at the last committed page, the feed owns its fields against every other
// writer (administrators included) while local fields stay the members', an unchanged page bumps no revision, a lost
// retention starts a fresh snapshot whose end reconciles what it no longer saw (resumably), a pushing driver's
// partitions drain when the configuration drops them, and an instance's messages feed its rows. One guarantee per test.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { Port } from '../src/engine/port.ts';
import { Drivers } from '../src/engine/ports.ts';
import { DbError } from '../src/engine/errors.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Feeds } from '../src/engine/services.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import { messageFeedRuns, PAGES } from '../src/engine/integrations/feeds.ts';
import { TestWorkspace, type TestOptions } from '../src/test/index.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		catalogues: { description: 'A catalogue', label: 'title', fields: { title: { kind: 'text' } } },
		products: {
			description: 'An ERP product',
			label: 'name',
			key: ['source', 'code'],
			fields: {
				code: { kind: 'text' },
				name: { kind: 'text' },
				active: { kind: 'bool', default: true },
				commission: { kind: 'text', optional: true }
			}
		},
		calendar_entries: {
			description: 'A calendar event',
			label: 'title',
			key: ['account', 'calendar', 'external'],
			fields: {
				calendar: { kind: 'text' },
				external: { kind: 'text' },
				title: { kind: 'text' },
				status: { kind: 'text', default: 'confirmed' }
			}
		},
		supplier_mail: {
			description: 'A supplier mail',
			label: 'subject',
			key: ['inbox', 'message_id'],
			fields: {
				message_id: { kind: 'text' },
				subject: { kind: 'text' },
				from_address: { kind: 'text' }
			}
		}
	},
	relationships: {
		'products.source': { to: 'sys_integration', where: { integration: { eq: 'erp' } } },
		'products.catalogue': { to: 'catalogues', optional: true, inverse: 'products' },
		'calendar_entries.account': {
			to: 'sys_integration',
			where: { integration: { eq: 'calendar' } }
		},
		'supplier_mail.inbox': { to: 'sys_integration', where: { integration: { eq: 'mail_import' } } }
	},
	collections: {
		catalogues: {
			read: { fields: 'all' },
			create: { input: { columns: ['title'] } },
			update: {
				input: { columns: ['title'], with: { products: { create: { columns: ['code', 'name'] } } } }
			}
		},
		// a feed target exposes no create, delete or action; its update columns are its local fields
		products: { read: { fields: 'all' }, update: { input: { columns: ['commission'] } } },
		calendar_entries: { read: { fields: 'all' } },
		supplier_mail: { read: { fields: 'all' } }
	},
	integrations: {
		erp: {
			description: 'An ERP database',
			driver: 'sqlserver',
			credential: { connection: { kind: 'text' } },
			feeds: {
				products: {
					into: 'products',
					key: ['code'],
					cron: '*/15 * * * *',
					removed: { active: false }
				}
			}
		},
		calendar: {
			description: 'A calendar account',
			driver: 'calendar',
			configuration: { calendars: { kind: 'text', many: true, default: [] } },
			feeds: {
				entries: {
					into: 'calendar_entries',
					key: ['calendar', 'external'],
					from: 'driver',
					partitions: 'calendars',
					removed: { status: 'cancelled' }
				}
			}
		},
		mail_import: {
			description: 'The supplier inbox',
			driver: 'email',
			feeds: { supplier_mail: { into: 'supplier_mail', key: ['message_id'], from: 'messages' } }
		}
	},
	pipelines: {},
	policies: {
		sales: {
			description: 'Sales',
			grants: {
				products: { read: true, update: { fields: ['commission'] } },
				catalogues: { read: true, create: true, update: true }
			}
		}
	},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;

/** `guest.mjs`: the ERP's `read` asks its database for the page at the cursor; the calendar and inbox `map` their items. */
const guestSource = `export default { integration_definition: {
	erp: { bodies: { feeds: { products: { read: function* (cursor, ctx) {
		return (yield* ctx.request({ statement: 'page', parameters: { cursor: JSON.stringify(cursor), instance: ctx.instance } })).rows[0].page; } } }, outbound: {} } },
	calendar: { bodies: { feeds: { entries: { map: function* (events, ctx) { return events.map((e) => e.status === 'cancelled'
		? { delete: { calendar: ctx.partition, external: e.id } } : { upsert: { calendar: ctx.partition, external: e.id, title: e.summary } }); } } }, outbound: {} } },
	mail_import: { bodies: { feeds: { supplier_mail: { map: function* (mails) { return mails.map((m) => m.deleted ? { delete: { message_id: m.id } }
		: { upsert: { message_id: m.id, subject: m.subject, from_address: m.from.address } }); } } }, outbound: {} } },
} };`;

const NOW = '2026-10-14T08:00:00.000Z';
type Page = {
	changes: Json[];
	cursor: Json;
	more: boolean;
	snapshot?: 'begin' | 'end';
	retained?: false;
	health?: Json;
};
const guest = program(guestSource);
const setup = Effect.gen(function* () {
	/** The ERP's pages by cursor (`null` is the first); `down` makes the next request at that cursor fail once. */
	const pages = new Map<string, Page>(),
		down = new Set<string>(),
		requests: string[] = [];
	let failReconcile = false;
	const db = Layer.effect(
		TenantDb,
		Effect.gen(function* () {
			const inner = yield* TenantDb;
			return TenantDb.typed({
				...inner,
				write: (statement, lock) =>
					Effect.suspend(() => {
						if (
							failReconcile &&
							statement.text.includes('feed_gone') &&
							statement.text.includes('UPDATE')
						) {
							failReconcile = false;
							return Effect.fail(
								new DbError({ message: 'the host died mid-reconcile', sqlstate: '08006' })
							);
						}
						return inner.write(statement, lock);
					})
			});
		})
	).pipe(Layer.provide(PgliteDb.layer()));
	let context = yield* Layer.build(
		TestWorkspace.layer({
			manifest,
			guest: yield* guest,
			now: NOW,
			db,
			seed: {
				sys_integration: [
					{ id: 'erp1', integration: 'erp', name: 'ERP one' },
					{ id: 'erp2', integration: 'erp', name: 'ERP two' },
					{
						id: 'cal1',
						integration: 'calendar',
						name: 'Calendar',
						configuration: { calendars: ['work', 'home'] }
					},
					{ id: 'inbox1', integration: 'mail_import', name: 'Supplier inbox' }
				]
			}
		})
	);
	let t = Context.get(context, TestWorkspace),
		feeds = Context.get(context, Feeds),
		route = yield* routeFixture(context);
	const answer = (instance: string, op: Json) =>
		Effect.try({
			try: () => {
				const parameters = Schema.decodeUnknownSync(
						Schema.Struct({ parameters: Schema.Struct({ cursor: Schema.String }) })
					)(op).parameters,
					at = `${instance}:${parameters.cursor}`;
				requests.push(at);
				if (down.delete(at)) throw new Error('the database went away');
				const page = pages.get(at);
				if (page === undefined) throw new Error(`no page at ${at}`);
				return { rows: [{ page: Schema.decodeUnknownSync(Schema.Json)(page) }] };
			},
			catch: Port.failure('link')
		});
	t.fakes.links.answer = answer;
	const reopen = (
		options: Pick<TestOptions<Drivers>, 'db' | 'guest' | 'transforms' | 'seed' | 'ports'>
	) =>
		Effect.gen(function* () {
			context = yield* Layer.build(
				TestWorkspace.layer({ manifest, guest: yield* guest, now: NOW, ...options })
			);
			t = Context.get(context, TestWorkspace);
			feeds = Context.get(context, Feeds);
			route = yield* routeFixture(context);
			t.fakes.links.answer = answer;
			return t;
		});
	const page = (instance: string, cursor: Json, p: Page) =>
		pages.set(`${instance}:${JSON.stringify(cursor)}`, p);
	const upsert = (code: string, name: string): Json => ({ upsert: { code, name } });
	const sql = (text: string, params: Json[] = []) =>
		t.db.read([{ text, params }]).pipe(
			Effect.map(([result]) => {
				if (result === undefined) throw new Error('Missing feed SQL result');
				return result.rows;
			})
		);
	const run = (feed: string, input: Json = {}) =>
		Effect.suspend(() => {
			const handler = feeds.handlers[feed];
			if (handler === undefined) throw new Error(`Missing feed ${feed}`);
			return handler(input, { id: randomUUID(), starter: null }).pipe(Effect.provide(context));
		});
	const products = () =>
		sql(
			`SELECT source, code, name, active, commission, revision FROM products ORDER BY source, code`
		);
	const cursor = (instance: string, partition = '') =>
		sql(
			`SELECT cursor, cycle, phase FROM bolt_feed WHERE feed = 'erp.products' AND instance = $1 AND partition = $2`,
			[instance, partition]
		).pipe(Effect.map((rows) => rows[0]));
	const ok = (o: Outcome) => {
		if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
		return o;
	};

	const act = (authority: Authority, callable: string, input: Json) =>
		actReply(route, authority, { callable, input, issuedAt: t.clock.now() }).pipe(
			Effect.map((reply) => reply.outcome)
		);
	return {
		t,
		context,
		get feeds() {
			return feeds;
		},
		pages,
		down,
		requests,
		reopen,
		page,
		upsert,
		sql,
		run,
		products,
		cursor,
		ok,
		act,
		crashReconcile: () => {
			failReconcile = true;
		}
	};
});

describe('a read feed', () => {
	it.live('commits each page as one statement: its rows, its cursor and its markers', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { t, pages, page, upsert, sql, run, products, cursor } = yield* setup;
				page('erp1', null, {
					changes: [upsert('A', 'Alpha'), upsert('B', 'Beta')],
					cursor: 1,
					more: true
				});
				page('erp1', 1, { changes: [upsert('C', 'Gamma')], cursor: 2, more: false });
				t.count.reset();
				expect(yield* run('erp.products', { instance: 'erp1' })).toEqual({ pages: 2 });
				expect(t.count.writes).toBe(2);
				expect(yield* products()).toEqual(
					['A', 'B', 'C'].map((code, i) => ({
						source: 'erp1',
						code,
						name: ['Alpha', 'Beta', 'Gamma'][i],
						active: true,
						commission: null,
						revision: 1
					}))
				);
				expect(yield* cursor('erp1')).toEqual({ cursor: 2, cycle: 1, phase: 'read' });
				expect(
					yield* sql(`SELECT key FROM bolt_feed_row WHERE feed = 'erp.products' ORDER BY key`)
				).toEqual([{ key: '["A"]' }, { key: '["B"]' }, { key: '["C"]' }]);
			})
		)
	);

	it.live(
		'killed between pages, it keeps every committed row once and resumes at the last committed cursor',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { down, requests, page, upsert, sql, run, products, cursor } = yield* setup;
					page('erp1', null, {
						changes: [upsert('A', 'Alpha'), upsert('B', 'Beta')],
						cursor: 1,
						more: true
					});
					page('erp1', 1, { changes: [upsert('C', 'Gamma')], cursor: 2, more: false });
					down.add('erp1:1');
					expect(yield* run('erp.products', { instance: 'erp1' }).pipe(Effect.flip)).toBeInstanceOf(
						Error
					);
					expect((yield* products()).map((r) => r['code'])).toEqual(['A', 'B']);
					expect(yield* cursor('erp1')).toMatchObject({ cursor: 1 });
					expect(
						yield* sql(
							`SELECT status -> 'health' ->> 'state' AS state FROM sys_integration WHERE id = 'erp1'`
						)
					).toEqual([{ state: 'attention' }]);
					yield* run('erp.products', { instance: 'erp1' });
					expect(requests).toEqual(['erp1:null', 'erp1:1', 'erp1:1']);
					expect((yield* products()).map((r) => [r['code'], r['revision']])).toEqual([
						['A', 1],
						['B', 1],
						['C', 1]
					]);
					expect(yield* cursor('erp1')).toMatchObject({ cursor: 2 });
					// a successful page clears the failure's attention on the instance
					expect(
						yield* sql(
							`SELECT status -> 'health' ->> 'state' AS state FROM sys_integration WHERE id = 'erp1'`
						)
					).toEqual([{ state: 'ready' }]);
				})
			)
	);

	it.live(
		'a page whose statement fails commits nothing, and is read again from the same cursor',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { page, upsert, run, products, cursor } = yield* setup;
					page('erp1', null, {
						changes: [upsert('A', 'Alpha'), { upsert: { code: 'B', name: 7 } }],
						cursor: 1,
						more: false
					});
					expect(yield* run('erp.products', { instance: 'erp1' }).pipe(Effect.flip)).toMatchObject({
						code: 'invalidInput'
					});
					expect(yield* products()).toEqual([]);
					expect(yield* cursor('erp1')).toMatchObject({ cursor: null });
					page('erp1', null, {
						changes: [upsert('A', 'Alpha'), upsert('B', 'Beta')],
						cursor: 1,
						more: false
					});
					yield* run('erp.products', { instance: 'erp1' });
					expect((yield* products()).map((r) => r['code'])).toEqual(['A', 'B']);
				})
			)
	);

	it.live('replaying an unchanged row bumps no revision and writes no history', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { page, upsert, sql, run, products, cursor } = yield* setup;
				page('erp1', null, { changes: [upsert('A', 'Alpha')], cursor: 1, more: false });
				page('erp1', 1, { changes: [upsert('A', 'Alpha')], cursor: 2, more: false });
				yield* run('erp.products', { instance: 'erp1' });
				const history = yield* sql(
					`SELECT count(*)::int AS n FROM bolt_history WHERE collection = 'products'`
				);
				yield* run('erp.products', { instance: 'erp1' });
				expect((yield* products()).map((r) => r['revision'])).toEqual([1]);
				expect(
					yield* sql(`SELECT count(*)::int AS n FROM bolt_history WHERE collection = 'products'`)
				).toEqual(history);
				expect(yield* cursor('erp1')).toMatchObject({ cursor: 2 });
			})
		)
	);

	it.live(
		'each instance keeps its own rows and cursor; one failing database never holds another back',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { down, page, upsert, run, products, cursor } = yield* setup;
					page('erp1', null, { changes: [upsert('A', 'One')], cursor: 1, more: false });
					page('erp2', null, { changes: [upsert('A', 'Two')], cursor: 9, more: false });
					page('erp2', 9, { changes: [], cursor: 9, more: false });
					down.add('erp1:null');
					expect(yield* run('erp.products').pipe(Effect.flip)).toBeInstanceOf(Error);
					expect(yield* products()).toEqual([
						expect.objectContaining({ source: 'erp2', code: 'A', name: 'Two' })
					]);
					yield* run('erp.products');
					expect((yield* products()).map((r) => [r['source'], r['name']])).toEqual([
						['erp1', 'One'],
						['erp2', 'Two']
					]);
					expect([
						(yield* cursor('erp1'))?.['cursor'],
						(yield* cursor('erp2'))?.['cursor']
					]).toEqual([1, 9]);
				})
			)
	);

	it.live("one instance's failed health write never holds the next instance back", () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { t, down, reopen, page, upsert, run, products, cursor } = yield* setup;
				const flaky = Layer.effect(
					TenantDb,
					Effect.gen(function* () {
						const inner = yield* TenantDb;
						return TenantDb.typed({
							...inner,
							write: (statement, lock) =>
								statement.text.includes(
									'INSERT INTO bolt_feed (feed, instance, partition, health,'
								) && statement.params[1] === 'erp1'
									? Effect.fail(
											new DbError({ message: 'the database went away', sqlstate: '08006' })
										)
									: inner.write(statement, lock)
						});
					})
				).pipe(Layer.provide(PgliteDb.layer()));
				t = yield* reopen({
					db: flaky,
					seed: {
						sys_integration: [
							{ id: 'erp1', integration: 'erp', name: 'ERP one' },
							{ id: 'erp2', integration: 'erp', name: 'ERP two' }
						]
					}
				});
				page('erp2', null, { changes: [upsert('A', 'Two')], cursor: 9, more: false });
				down.add('erp1:null');
				expect(yield* run('erp.products').pipe(Effect.flip)).toBeInstanceOf(Error);
				expect(yield* products()).toEqual([
					expect.objectContaining({ source: 'erp2', code: 'A', name: 'Two' })
				]);
				expect(yield* cursor('erp2')).toMatchObject({ cursor: 9 });
			})
		)
	);

	it.live(
		'stops at PAGES pages in one run; its continuation run, from the queue, resumes the instance at the cursor it reached',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { t, pages, requests, page, upsert, sql, run, products, cursor } = yield* setup;
					for (let i = 0; i <= PAGES; i++)
						page('erp1', i === 0 ? null : i, {
							changes: i === PAGES ? [upsert('Z', 'Last')] : [],
							cursor: i + 1,
							more: i < PAGES
						});
					expect(yield* run('erp.products', { instance: 'erp1' })).toEqual({ pages: PAGES });
					expect(yield* cursor('erp1')).toMatchObject({ cursor: PAGES });
					expect(yield* products()).toEqual([]);
					const queued = yield* sql(
						`SELECT automation, input, state FROM sys_run WHERE cause = 'continue'`
					);
					expect(queued).toEqual([
						{
							automation: 'erp.products',
							input: { instance: 'erp1', partition: '' },
							state: 'queued'
						}
					]);
					yield* t.runDue();
					expect(yield* sql(`SELECT state FROM sys_run WHERE cause = 'continue'`)).toEqual([
						{ state: 'succeeded' }
					]);
					expect(requests.slice(-2)).toEqual([`erp1:${PAGES - 1}`, `erp1:${PAGES}`]);
					expect((yield* products()).map((r) => r['code'])).toEqual(['Z']);
					expect(yield* cursor('erp1')).toMatchObject({ cursor: PAGES + 1 });
				})
			),
		180_000
	);

	it.live('runs on its cron slot as `<def>.<feed>`', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { sql, products } = yield* setup;
				expect(
					yield* sql(`SELECT automation, cause FROM sys_run WHERE automation = 'erp.products'`)
				).toEqual([{ automation: 'erp.products', cause: 'cron' }]);
			})
		)
	);

	it.live(
		'a removed key deletes nothing local: its `removed` patch archives the row and its marker goes',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { page, upsert, sql, run, products, cursor } = yield* setup;
					page('erp1', null, {
						changes: [upsert('A', 'Alpha'), upsert('B', 'Beta')],
						cursor: 1,
						more: false
					});
					page('erp1', 1, {
						changes: [{ delete: { code: 'B' } }, { delete: { code: 'Z' } }],
						cursor: 2,
						more: false
					});
					yield* run('erp.products', { instance: 'erp1' });
					yield* run('erp.products', { instance: 'erp1' });
					expect((yield* products()).map((r) => [r['code'], r['active']])).toEqual([
						['A', true],
						['B', false]
					]);
					expect(yield* sql(`SELECT key FROM bolt_feed_row ORDER BY key`)).toEqual([
						{ key: '["A"]' }
					]);
				})
			)
	);

	it.live(
		"a page's `removed` patches reach the collection's one transform, with their stored rows; a page of removals alone too",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { t, reopen, page, upsert, run, products, cursor } = yield* setup;
					const answer = t.fakes.links.answer;
					const source = guestSource.replace(
						'export default { integration_definition: {',
						`export default { collection: { products: { bodies: {
			transform: function* (inputs, ctx) { return inputs.map((x, i) => x.active === false ? { ...x, name: ctx.existing[i].name + ' (retired)' } : x); } } } }, integration_definition: {`
					);
					t = yield* reopen({
						guest: yield* program(source),
						transforms: ['products'],
						seed: { sys_integration: [{ id: 'erp1', integration: 'erp', name: 'ERP one' }] }
					});
					t.fakes.links.answer = answer;
					page('erp1', null, {
						changes: [upsert('A', 'Alpha'), upsert('B', 'Beta')],
						cursor: 1,
						more: false
					});
					page('erp1', 1, { changes: [{ delete: { code: 'B' } }], cursor: 2, more: false });
					yield* run('erp.products', { instance: 'erp1' });
					yield* run('erp.products', { instance: 'erp1' });
					expect((yield* products()).map((r) => [r['code'], r['name'], r['active']])).toEqual([
						['A', 'Alpha', true],
						['B', 'Beta (retired)', false]
					]);
				})
			)
	);
});

describe('feed ownership', () => {
	it.live(
		'an administrator cannot write a feed-owned field or create a fed row, but changes a local field',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { t, page, upsert, sql, run, products, cursor, ok, act } = yield* setup;
					page('erp1', null, { changes: [upsert('A', 'Alpha')], cursor: 1, more: false });
					yield* run('erp.products', { instance: 'erp1' });
					const [row] = yield* sql(`SELECT id::text AS id FROM products`);
					const admin = t.as(t.admin);
					expect(
						yield* act(admin.authority, 'products.update', {
							target: present(present(row)['id']),
							set: { name: 'Edited' }
						})
					).toMatchObject({ kind: 'refused', code: 'invalidInput' });
					expect(
						yield* act(admin.authority, 'products.create', { code: 'X', name: 'x' })
					).toMatchObject({ kind: 'refused', code: 'forbidden' });
					ok(
						yield* act(admin.authority, 'products.update', {
							target: present(present(row)['id']),
							set: { commission: '1.5' }
						})
					);
					// another collection's nested create reaches a fed collection: refused before anything is decided
					const catalogue = present(
						ok(yield* act(admin.authority, 'catalogues.create', { title: 'Main' })).records[0]
					).id;
					expect(
						yield* act(admin.authority, 'catalogues.update', {
							target: catalogue,
							set: { products: { create: [{ code: 'Y', name: 'y' }] } }
						})
					).toMatchObject({
						kind: 'refused',
						code: 'forbidden',
						message: expect.stringContaining('erp.products')
					});
					expect(yield* products()).toEqual([
						expect.objectContaining({ code: 'A', name: 'Alpha', commission: '1.5' })
					]);
				})
			)
	);

	it.live('the feed never writes a local field, and a local edit survives its next page', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { t, page, upsert, sql, run, products, cursor, ok, act } = yield* setup;
				page('erp1', null, { changes: [upsert('A', 'Alpha')], cursor: 1, more: false });
				yield* run('erp.products', { instance: 'erp1' });
				const [row] = yield* sql(`SELECT id::text AS id FROM products`);
				ok(
					yield* act(t.as(t.member(['sales'])).authority, 'products.update', {
						target: present(present(row)['id']),
						set: { commission: '2' }
					})
				);
				page('erp1', 1, { changes: [upsert('A', 'Renamed')], cursor: 2, more: false });
				yield* run('erp.products', { instance: 'erp1' });
				page('erp1', 2, {
					changes: [{ upsert: { code: 'A', name: 'x', commission: '9' } }],
					cursor: 3,
					more: false
				});
				expect(yield* run('erp.products', { instance: 'erp1' }).pipe(Effect.flip)).toMatchObject({
					code: 'invalidInput'
				});
				expect(yield* products()).toEqual([
					expect.objectContaining({ name: 'Renamed', commission: '2' })
				]);
			})
		)
	);
});

describe('snapshots and retention', () => {
	it.live(
		'a lost retention starts a fresh snapshot; its end reconciles only the rows it no longer saw, keeping local fields',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { t, requests, page, upsert, sql, run, products, cursor, ok, act } = yield* setup;
					page('erp1', null, {
						changes: [upsert('A', 'Alpha'), upsert('B', 'Beta')],
						cursor: 'c1',
						more: false
					});
					yield* run('erp.products', { instance: 'erp1' });
					const [b] = yield* sql(`SELECT id::text AS id FROM products WHERE code = 'B'`);
					ok(
						yield* act(t.as(t.admin).authority, 'products.update', {
							target: present(present(b)['id']),
							set: { commission: 'keep' }
						})
					);
					page('erp1', 'c1', { changes: [], cursor: 'c1', more: false, retained: false });
					page('erp1', null, {
						changes: [upsert('A', 'Alpha')],
						cursor: 'c2',
						more: false,
						snapshot: 'end'
					});
					yield* run('erp.products', { instance: 'erp1' });
					expect(requests).toEqual(['erp1:null', 'erp1:"c1"', 'erp1:null']);
					expect((yield* products()).map((r) => [r['code'], r['active'], r['commission']])).toEqual(
						[
							['A', true, null],
							['B', false, 'keep']
						]
					);
					expect(yield* cursor('erp1')).toEqual({ cursor: 'c2', cycle: 2, phase: 'read' });
					expect(yield* sql(`SELECT key FROM bolt_feed_row`)).toEqual([{ key: '["A"]' }]);
				})
			)
	);

	it.live(
		'an interrupted reconcile resumes without fetching the snapshot again or repeating a removal',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { requests, page, upsert, run, products, cursor, crashReconcile } = yield* setup;
					page('erp1', null, {
						changes: [upsert('A', 'Alpha'), upsert('B', 'Beta')],
						cursor: 'c1',
						more: false
					});
					yield* run('erp.products', { instance: 'erp1' });
					page('erp1', 'c1', {
						changes: [upsert('A', 'Alpha')],
						cursor: 'c2',
						more: true,
						snapshot: 'begin'
					});
					page('erp1', 'c2', { changes: [], cursor: 'c3', more: false, snapshot: 'end' });
					page('erp1', 'c3', { changes: [], cursor: 'c3', more: false });
					crashReconcile();
					expect(yield* run('erp.products', { instance: 'erp1' }).pipe(Effect.flip)).toMatchObject({
						message: expect.stringContaining('mid-reconcile')
					});
					expect(yield* cursor('erp1')).toEqual({ cursor: 'c3', cycle: 2, phase: 'reconcile' });
					const asked = requests.length;
					yield* run('erp.products', { instance: 'erp1' });
					// the snapshot is not read again: the reconcile resumes, then the changes read on from its cursor
					expect(requests.slice(asked)).toEqual(['erp1:"c3"']);
					expect((yield* products()).map((r) => [r['code'], r['active'], r['revision']])).toEqual([
						['A', true, 1],
						['B', false, 2]
					]);
					expect(yield* cursor('erp1')).toEqual({ cursor: 'c3', cycle: 2, phase: 'read' });
				})
			)
	);

	it.live('a changed feed literal starts again from no cursor', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { t, requests, page, upsert, run, products, cursor } = yield* setup;
				page('erp1', null, { changes: [upsert('A', 'Alpha')], cursor: 1, more: false });
				yield* run('erp.products', { instance: 'erp1' });
				yield* t.db.write({ text: `UPDATE bolt_feed SET digest = 'an older literal'`, params: [] });
				yield* run('erp.products', { instance: 'erp1' });
				expect(requests).toEqual(['erp1:null', 'erp1:null']);
			})
		)
	);
});

describe('a pushing driver and its partitions', () => {
	it.live(
		'reads each configured calendar through its driver; a dropped calendar releases its cursor and keeps its rows',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { t, page, sql, run, cursor, ok, act } = yield* setup;
					const items: { [p: string]: Json[] } = {
						work: [{ id: 'e1', summary: 'Standup', status: 'confirmed' }],
						home: [{ id: 'e2', summary: 'Dentist', status: 'confirmed' }]
					};
					t.fakes.links.page = (_instance, feed, partition) =>
						Effect.succeed({
							items: feed === 'entries' ? (items[partition] ?? []) : [],
							cursor: `${partition}-1`,
							more: false
						});
					yield* run('calendar.entries', { instance: 'cal1' });
					const entries = () =>
						sql(`SELECT calendar, external, title, status FROM calendar_entries ORDER BY calendar`);
					expect(yield* entries()).toEqual([
						{ calendar: 'home', external: 'e2', title: 'Dentist', status: 'confirmed' },
						{ calendar: 'work', external: 'e1', title: 'Standup', status: 'confirmed' }
					]);
					const admin = t.as(t.admin);
					ok(
						yield* act(admin.authority, 'sys_integration.update', {
							target: 'cal1',
							set: { configuration: { calendars: ['work'] } }
						})
					);
					items['work'] = [{ id: 'e1', summary: 'Standup', status: 'cancelled' }];
					yield* t.runDue(); // the configuration change queued the feed for this instance
					expect(
						yield* sql(
							`SELECT partition, cursor FROM bolt_feed WHERE instance = 'cal1' ORDER BY partition`
						)
					).toEqual([{ partition: 'work', cursor: 'work-1' }]);
					expect(yield* entries()).toEqual([
						{ calendar: 'home', external: 'e2', title: 'Dentist', status: 'confirmed' },
						{ calendar: 'work', external: 'e1', title: 'Standup', status: 'cancelled' }
					]);
				})
			)
	);

	it.live("a driver's invalidate queues one run of that feed for the instance and partition", () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { feeds, sql, products } = yield* setup;
				yield* feeds.invalidate('cal1', 'entries', 'work');
				yield* feeds.invalidate('cal1', 'entries', 'work');
				expect(
					yield* sql(
						`SELECT input FROM sys_run WHERE automation = 'calendar.entries' AND cause = 'provider'`
					)
				).toEqual([{ input: { instance: 'cal1', partition: 'work' } }]);
				expect(yield* feeds.invalidate('erp1', 'products', '').pipe(Effect.flip)).toMatchObject({
					code: 'invalidInput'
				});
			})
		)
	);
});

describe("a conversation's messages feed", () => {
	it.live('queues a recall even when the provider retains the original message version', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { t, sql } = yield* setup;
				const message = {
					id: '<unchanged@onsemi.com>',
					thread: 't1',
					version: '1',
					sentAt: NOW,
					from: { address: 'pcn@onsemi.com', name: null },
					to: [],
					cc: [],
					replyTo: null,
					subject: 'Supplier notice',
					text: 'Affected part',
					html: null,
					headers: {},
					attachments: []
				};
				yield* t.receive('inbox1', message);
				expect(yield* sql('SELECT message_id FROM supplier_mail')).toEqual([
					{ message_id: message.id }
				]);
				yield* t.receive('inbox1', { ...message, deleted: true });
				expect(yield* sql('SELECT message_id FROM supplier_mail')).toEqual([]);
				yield* t.receive('inbox1', { ...message, deleted: true });
				expect(
					(yield* sql(
						"SELECT id FROM sys_run WHERE automation = 'mail_import.supplier_mail' AND cause = 'provider'"
					)).length
				).toBe(2);
			})
		)
	);
	it.live('maps each ingested message, an edit converging and a recall deleting its row', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { t, sql, run } = yield* setup;
				yield* t.db.write({
					text: `WITH c AS (INSERT INTO sys_conversation (id, integration, thread, kind) VALUES ('conv', 'inbox1', 't1', 'dm'))
			INSERT INTO sys_message (id, conversation, integration, direction, origin, provider_id, version, sender, sent_at, text, email, created_at)
			VALUES ('m1', 'conv', 'inbox1', 'inbound', 'live', '<pcn-1@onsemi.com>', '1', 'pcn@onsemi.com', $1::timestamptz, 'Affected: NCP1117',
				$2::jsonb, $1::timestamptz)`,
					params: [
						NOW,
						{
							id: '<pcn-1@onsemi.com>',
							subject: 'PCN 1234',
							from: { address: 'pcn@onsemi.com', name: null }
						}
					]
				});
				const queued = messageFeedRuns(t.manifest, 'mail_import', 'inbox1', 'm1', '1');
				expect(queued).toEqual([
					{
						automation: 'mail_import.supplier_mail',
						key: '["feed","mail_import.supplier_mail","m1","1"]',
						input: { instance: 'inbox1', messages: ['m1'] }
					}
				]);
				yield* run('mail_import.supplier_mail', present(queued[0]).input);
				const mail = () => sql(`SELECT inbox, message_id, subject FROM supplier_mail`);
				expect(yield* mail()).toEqual([
					{ inbox: 'inbox1', message_id: '<pcn-1@onsemi.com>', subject: 'PCN 1234' }
				]);
				yield* t.db.write({
					text: `UPDATE sys_message SET version = '2', email = email || '{"subject": "PCN 1234 rev B"}'::jsonb WHERE id = 'm1'`,
					params: []
				});
				yield* run('mail_import.supplier_mail', present(queued[0]).input);
				expect(yield* mail()).toEqual([
					{ inbox: 'inbox1', message_id: '<pcn-1@onsemi.com>', subject: 'PCN 1234 rev B' }
				]);
				yield* t.db.write({
					text: `UPDATE sys_message SET version = '3', deleted_at = $1::timestamptz WHERE id = 'm1'`,
					params: [NOW]
				});
				yield* run('mail_import.supplier_mail', present(queued[0]).input);
				expect(yield* mail()).toEqual([]);
			})
		)
	);
});

describe('a preview, where the host binds no links', () => {
	it.live('reads no feed: no cron slot, no body run, no health or revision on the instance', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { t, pages, reopen, sql, run, products } = yield* setup;
				t = yield* reopen({
					ports: Drivers.unavailable,
					seed: { sys_integration: [{ id: 'erp1', integration: 'erp', name: 'ERP one' }] }
				});
				expect(yield* sql(`SELECT automation FROM sys_run`)).toEqual([]);
				expect(yield* run('erp.products', { instance: 'erp1' })).toEqual({ pages: 0 });
				expect(yield* run('erp.products')).toEqual({ pages: 0 });
				expect(yield* sql(`SELECT count(*)::int AS n FROM bolt_feed`)).toEqual([{ n: 0 }]);
				expect(
					yield* sql(
						`SELECT status -> 'health' AS health, revision FROM sys_integration WHERE id = 'erp1'`
					)
				).toEqual([{ health: null, revision: 1 }]);
			})
		)
	);
});

describe('instance health', () => {
	it.live("lands on the instance's status only when it changes", () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { t, page, sql, run, products, cursor } = yield* setup;
				page('erp1', null, {
					changes: [],
					cursor: 1,
					more: false,
					health: { state: 'attention', code: 'retentionRisk' }
				});
				page('erp1', 1, {
					changes: [],
					cursor: 1,
					more: false,
					health: { state: 'attention', code: 'retentionRisk' }
				});
				yield* run('erp.products', { instance: 'erp1' });
				const status = () =>
					sql(
						`SELECT status -> 'health' AS health, revision FROM sys_integration WHERE id = 'erp1'`
					).pipe(Effect.map((rows) => rows[0]));
				expect(yield* status()).toEqual({
					health: { state: 'attention', code: 'retentionRisk' },
					revision: 2
				});
				t.count.reset();
				yield* run('erp.products', { instance: 'erp1' });
				expect(t.count.writes).toBe(0);
				expect(yield* status()).toEqual({
					health: { state: 'attention', code: 'retentionRisk' },
					revision: 2
				});
			})
		)
	);
});
