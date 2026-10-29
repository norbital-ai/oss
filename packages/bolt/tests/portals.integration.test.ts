// Portals carry their policies (§3.3.1, rule 38d): a kiosk with `auth: 'none'` runs a signed-out visitor as exactly
// its policies; one with `auth: 'external'` sends a signed-out caller to sign in (or sign up), and every external who
// signs in holds exactly its policies there — and nothing of it anywhere else. A visitor is an anonymous user (a
// `sys_user` its cookie holds) that owns its rows, is limited by itself, and links to the account it signs in to.
// Over HTTP on PGlite.
import { describe, expect, it, layer } from '@effect/vitest';
import { Effect, Result, Schema } from 'effect';
import { checkRules } from '../../bolt-cli/src/compiler/check/rules.ts';
import { decodeProjectedManifest, type EngineManifest } from '../src/engine/manifest.ts';
import { KitInvalid, TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const page = { title: 'Home' };
const card = { title: 'T', description: 'd', icon: 'i' };
const source = {
	workspace: { tz: 'UTC', locale: 'en', signup: { via: ['email'], policies: ['customer'] } },
	models: {
		services: {
			description: 'Services',
			label: 'name',
			fields: { name: { kind: 'text' }, cost: { kind: 'text' } }
		},
		enquiries: { description: 'Enquiries', label: 'name', fields: { name: { kind: 'text' } } },
		bookings: {
			description: 'Bookings',
			label: 'note',
			fields: { note: { kind: 'text' }, customer: { kind: 'text' } }
		},
		orders: { description: 'Orders', label: 'note', fields: { note: { kind: 'text' } } }
	},
	relationships: {
		'orders.owner': { to: 'sys_user', optional: true, default: { var: 'requestor.id' } }
	},
	exposures: {
		services: {
			read: { services: { fields: 'all' } },
			// what a portal reads: a service's name, never its cost
			outputs: { listing: { services: { fields: ['name'] } } },
			create: { columns: { services: ['name', 'cost'] } }
		},
		enquiries: {
			read: { enquiries: { fields: 'all' } },
			create: { columns: { enquiries: ['name'] } }
		},
		bookings: {
			read: { bookings: { fields: 'all' } },
			outputs: { own: { bookings: { fields: ['note', 'customer'] } } },
			create: { columns: { bookings: ['note', 'customer'] } }
		},
		orders: {
			read: { orders: { fields: 'all' } },
			outputs: { own: { orders: { fields: ['note'] } } },
			create: { columns: { orders: ['note', 'owner'] } }
		}
	},
	integrations: {},
	policies: {
		site_visitor: {
			description: 'The public site: service names, and an enquiry',
			grants: {
				services: { outputs: { listing: true } },
				enquiries: { create: { columns: { enquiries: ['name'] } } }
			}
		},
		account_holder: {
			description: 'The customer portal: service names, and their own bookings',
			grants: {
				services: { outputs: { listing: true } },
				bookings: {
					outputs: { own: { bookings: { where: { customer: { eq: { var: 'requestor.id' } } } } } },
					create: { columns: { bookings: ['note', 'customer'] } }
				}
			}
		},
		shopper: {
			description: 'The shop: an anonymous visitor reads and adds its own orders',
			grants: {
				orders: {
					outputs: { own: { orders: { where: { owner: { eq: { var: 'requestor.id' } } } } } },
					create: { columns: { orders: ['note'] } }
				}
			},
			limits: { act: { rate: '3/h', per: 'actor' } }
		},
		stall_visitor: {
			description: 'The stall: its own orders, at most two anonymous users per IP an hour',
			grants: {
				orders: {
					outputs: { own: { orders: { where: { owner: { eq: { var: 'requestor.id' } } } } } }
				}
			},
			limits: { register: { rate: '2/h', per: 'ip' } }
		},
		customer: { description: 'Signed up: nothing outside the portal', grants: {} },
		staff: {
			description: 'Staff',
			capabilities: { apps: ['desk'] },
			grants: { services: { read: true }, bookings: { read: true } }
		}
	},
	apps: { desk: { ...card, pages: { home: page } } },
	kiosks: {
		site: { ...card, auth: 'none', policies: ['site_visitor'], pages: { home: page } },
		account: { ...card, auth: 'external', policies: ['account_holder'], pages: { home: page } },
		shop: { ...card, auth: 'none', policies: ['shopper'], pages: { home: page } },
		stall: { ...card, auth: 'none', policies: ['stall_visitor'], pages: { home: page } }
	},
	teams: { Staff: ['staff'] },
	automations: {},
	connections: { mail: { integration: 'email' } },
	envoys: {},
	mcp: {},
	customFields: {},
	agent: { skills: {} }
};
const manifest = Result.getOrThrow(decodeProjectedManifest(source));

const ORIGIN = 'https://acme.example';
const OTHER = 'someone-else';
type Jar = Map<string, string>;
const cookieOf = (j: Jar) => [...j].map(([k, v]) => `${k}=${v}`).join('; ');
const Reply = Schema.Struct({
	value: Schema.optionalKey(Schema.Unknown),
	outcome: Schema.optionalKey(Schema.Struct({ kind: Schema.String })),
	answers: Schema.optionalKey(Schema.Array(Schema.Unknown))
});
const call = (
	j: Jar,
	method: string,
	path: string,
	body?: unknown,
	kiosk?: string,
	address = '203.0.113.9'
) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace;
		const cookie = cookieOf(j);
		const res = yield* t.handle(
			new Request(`${ORIGIN}${path}`, {
				method,
				redirect: 'manual',
				headers: {
					'content-type': 'application/json',
					'idempotency-key': crypto.randomUUID(),
					...(cookie ? { cookie } : {}),
					...(kiosk === undefined ? {} : { 'Bolt-Kiosk': kiosk })
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			}),
			{ address }
		);
		for (const c of res.headers.getSetCookie()) {
			const [k = '', v = ''] = (c.split(';')[0] ?? '').split('=');
			if (/Max-Age=0/.test(c)) j.delete(k);
			else j.set(k, v);
		}
		const text = yield* Effect.tryPromise({
			try: () => res.text(),
			catch: (error) => new KitInvalid({ message: String(error) })
		});
		return {
			status: res.status,
			body:
				text === '' ? null : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Reply))(text)
		};
	});
const boot = (j: Jar, kiosk?: string) =>
	call(j, 'GET', `/__bolt/shell${kiosk === undefined ? '' : `?kiosk=${kiosk}`}`);
const Rows = Schema.Array(
	Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })
);
const read = (j: Jar, model: string, kiosk?: string, output?: string) =>
	call(
		j,
		'POST',
		'/__bolt/q',
		{ reads: [{ m: 'query', a: [{ [model]: output === undefined ? {} : { output } }] }] },
		kiosk
	);
const rows = (j: Jar, model: string, kiosk?: string, output?: string) =>
	read(j, model, kiosk, output).pipe(
		Effect.flatMap((r) =>
			Schema.decodeUnknownEffect(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))(
				r.body?.answers
			)
		),
		Effect.flatMap((answers) => Schema.decodeUnknownEffect(Rows)(answers.map((a) => a[model]))),
		Effect.map((answers) => answers[0]?.rows ?? [])
	);
const act = (j: Jar, callable: string, input: unknown, kiosk?: string, address?: string) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace;
		return yield* call(
			j,
			'POST',
			'/__bolt/act',
			{ callable, input, issuedAt: t.clock.now() },
			kiosk,
			address
		);
	});
const signIn = (address: string, j: Jar = new Map()) =>
	Effect.gen(function* () {
		expect((yield* call(j, 'POST', '/__bolt/session/code', { address })).status).toBe(200);
		expect(
			(yield* call(j, 'POST', '/__bolt/session/verify', { address, code: '123456' })).status
		).toBe(200);
		return j;
	});
const BootActor = Schema.Struct({
	actor: Schema.Struct({
		kind: Schema.String,
		id: Schema.optionalKey(Schema.String),
		visitor: Schema.optionalKey(Schema.String),
		anonymous: Schema.optionalKey(Schema.Boolean)
	}),
	nav: Schema.Array(Schema.Struct({ name: Schema.String }))
});
const bootOf = (j: Jar, kiosk?: string) =>
	boot(j, kiosk).pipe(Effect.flatMap((r) => Schema.decodeUnknownEffect(BootActor)(r.body?.value)));

describe('portal declarations', () => {
	const findings = (m: EngineManifest) =>
		checkRules(m, { automations: [] }, (_r, n) => n).map((f) => `${f.code} ${f.message}`);
	it.effect(
		'the build checks a portal names policies that exist and holds no member authority',
		() =>
			Effect.sync(() => {
				expect(findings(manifest)).toEqual([]);
				const broken = Result.getOrThrow(
					decodeProjectedManifest({
						...source,
						policies: {
							...source.policies,
							account_holder: {
								...source.policies.account_holder,
								capabilities: { apps: ['desk'] }
							}
						},
						apps: {
							...source.apps,
							careers: { ...card, audience: { public: ['nobody'] }, pages: { home: page } }
						}
					})
				);
				expect(findings(broken)).toEqual([
					"app/public-policy careers: audience.public: there is no policy 'nobody'",
					"access/kiosk-grant account_holder: kiosk 'account' (auth 'external'): a portal policy holds no capabilities"
				]);
			})
	);
});

layer(
	TestWorkspace.layer({
		manifest,
		seed: {
			bookings: [
				{ id: '0199a000-0000-4000-8000-0000000000b1', note: 'not yours', customer: OTHER }
			],
			services: [{ id: '0199a000-0000-4000-8000-0000000000c1', name: 'Wash', cost: '9' }]
		},
		host: { publicUrl: ORIGIN }
	})
)('portals', (it) => {
	it.effect('a no-sign-in portal: the visitor holds exactly its policies', () =>
		Effect.gen(function* () {
			const v: Jar = new Map();
			expect(yield* bootOf(v, 'site')).toMatchObject({ actor: { kind: 'visitor' }, nav: [] });
			const services = yield* rows(v, 'services', 'site', 'listing');
			expect(services).toEqual([expect.objectContaining({ name: 'Wash' })]);
			expect(services[0]).not.toHaveProperty('cost');
			// the default output is not the portal's
			expect((yield* read(v, 'services', 'site')).status).toBe(403);
			expect((yield* act(v, 'enquiries.create', [{ name: 'Ada' }], 'site')).body?.outcome).toEqual(
				expect.objectContaining({ kind: 'committed' })
			);
			// nothing beyond the grant: no read of what it creates, no other write, no other model
			expect((yield* read(v, 'enquiries', 'site')).status).toBe(403);
			expect((yield* read(v, 'bookings', 'site')).status).toBe(403);
			expect((yield* act(v, 'services.create', [{ name: 'X', cost: '1' }], 'site')).status).toBe(
				403
			);
			// and without the portal, a signed-out caller holds nothing
			expect((yield* read(v, 'services')).status).toBe(401);
			expect((yield* boot(v)).status).toBe(401);
		})
	);

	it.effect(
		'a sign-in portal: signed out is sent to sign in; whoever signs up holds its policies there and nowhere else',
		() =>
			Effect.gen(function* () {
				const out: Jar = new Map();
				expect((yield* boot(out, 'account')).status).toBe(401);
				expect((yield* read(out, 'bookings', 'account')).status).toBe(403);
				// a newcomer signs up by email and becomes an external member
				const ada = yield* signIn('ada@example.com');
				const me = yield* bootOf(ada, 'account');
				expect(me.actor.kind).toBe('member');
				expect(yield* rows(ada, 'bookings', 'account', 'own')).toEqual([]);
				expect(
					(yield* act(ada, 'bookings.create', [{ note: 'Tue', customer: me.actor.id }], 'account'))
						.body?.outcome
				).toEqual(expect.objectContaining({ kind: 'committed' }));
				expect(yield* rows(ada, 'bookings', 'account', 'own')).toEqual([
					expect.objectContaining({ note: 'Tue', customer: me.actor.id })
				]);
				expect(
					(yield* act(ada, 'services.create', [{ name: 'X', cost: '1' }], 'account')).status
				).toBe(403);
				// outside the portal they hold only their sign-up policy: no bookings, no members app
				expect((yield* read(ada, 'bookings')).status).toBe(403);
				expect((yield* bootOf(ada)).nav).toEqual([]);
				// staff open it only by a capability naming it; an administrator runs inside as the portal too
				const t = yield* TestWorkspace;
				t.member(['staff'], { email: 'sam@acme.example', teams: ['Staff'] });
				const sam = yield* signIn('sam@acme.example');
				expect((yield* bootOf(sam)).nav.map((n) => n.name)).toEqual(['desk']);
				expect((yield* boot(sam, 'account')).status).toBe(403);
				expect((yield* rows(sam, 'bookings')).length).toBe(2);
			})
	);

	const VISITOR = '__Secure-bolt-visitor';
	const anonymous = (j: Jar, kiosk = 'shop', address?: string) =>
		call(j, 'GET', `/__bolt/shell?kiosk=${kiosk}`, undefined, undefined, address).pipe(
			Effect.flatMap((r) => Schema.decodeUnknownEffect(BootActor)(r.body?.value)),
			Effect.map((b) => b.actor)
		);
	const notes = (j: Jar) =>
		rows(j, 'orders', 'shop', 'own').pipe(Effect.map((r) => r.map((x) => x['note'])));
	const order = (j: Jar, note: string, address?: string) =>
		act(j, 'orders.create', [{ note }], 'shop', address).pipe(
			Effect.map((r) => (r.status === 200 ? r.body?.outcome?.kind : r.status))
		);
	const user = (id: string) =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			return yield* t.db.rows(
				Schema.Struct({ kind: Schema.String, active: Schema.Boolean, sessions: Schema.Number }),
				{
					text: `SELECT kind, active, (SELECT count(*)::int FROM sys_session s WHERE s."user" = u.id) AS sessions FROM sys_user u WHERE id = $1`,
					params: [id]
				}
			);
		});
	const owners = (note: string) =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			return (yield* t.db.rows(Schema.Struct({ owner: Schema.NullOr(Schema.String) }), {
				text: `SELECT owner::text AS owner FROM orders WHERE note = $1`,
				params: [note]
			})).map((r) => r.owner);
		});

	it.effect(
		'an anonymous visitor keeps one id across requests, owns its rows, and two visitors are two people',
		() =>
			Effect.gen(function* () {
				const a: Jar = new Map(),
					b: Jar = new Map();
				const me = yield* anonymous(a);
				expect(me).toMatchObject({ kind: 'visitor', anonymous: true });
				expect(a.has(VISITOR)).toBe(true);
				expect(yield* anonymous(a)).toEqual(me);
				expect(yield* user(me.visitor ?? '')).toEqual([
					{ kind: 'anonymous', active: true, sessions: 1 }
				]);
				expect(yield* order(a, 'a1')).toBe('committed');
				expect(yield* owners('a1')).toEqual([me.visitor]);
				const other = yield* anonymous(b);
				expect(other.visitor).not.toBe(me.visitor);
				expect(yield* notes(b)).toEqual([]);
				expect(yield* order(b, 'b1')).toBe('committed');
				expect(yield* notes(a)).toEqual(['a1']);
				expect(yield* notes(b)).toEqual(['b1']);
				// never a member: no workspace boot, no People row
				expect((yield* boot(a)).status).toBe(401);
			})
	);

	it.effect('limits count per IP: anonymous users on one IP share it', () =>
		Effect.gen(function* () {
			const a: Jar = new Map(),
				b: Jar = new Map();
			// an IP of its own: the limit it exhausts would refuse the later tests' default address
			const ip = '198.51.100.20';
			yield* anonymous(a, 'shop', ip);
			yield* anonymous(b, 'shop', ip);
			for (const n of [1, 2, 3]) expect(yield* order(a, `limit-a${n}`, ip)).toBe('committed');
			expect(yield* order(a, 'limit-a4', ip)).toBe(429);
			// a second identity minted on the same IP gains nothing
			expect(yield* order(b, 'limit-b1', ip)).toBe(429);
		})
	);

	it.effect(
		'minting is limited per IP: past the ceiling a visitor opens the page with no identity',
		() =>
			Effect.gen(function* () {
				const ip = '198.51.100.7';
				const opened = [];
				for (let i = 0; i < 3; i++) {
					const j: Jar = new Map();
					opened.push({ actor: yield* anonymous(j, 'stall', ip), cookie: j.has(VISITOR) });
				}
				expect(opened.map((o) => [o.actor.anonymous ?? false, o.cookie])).toEqual([
					[true, true],
					[true, true],
					[false, false]
				]);
				// another IP still mints
				expect((yield* anonymous(new Map(), 'stall', '198.51.100.8')).anonymous).toBe(true);
			})
	);

	it.effect(
		'signing up links the anonymous user: the same id becomes the account, its rows with it',
		() =>
			Effect.gen(function* () {
				const j: Jar = new Map(),
					ip = '198.51.100.21';
				const me = yield* anonymous(j, 'shop', ip);
				expect(yield* order(j, 'cart', ip)).toBe('committed');
				yield* signIn('neo@example.com', j);
				expect(j.has(VISITOR)).toBe(false);
				const account = yield* bootOf(j, 'shop');
				expect(account.actor).toMatchObject({ kind: 'member', id: me.visitor });
				expect(yield* user(me.visitor ?? '')).toEqual([
					{ kind: 'external', active: true, sessions: 1 }
				]);
				expect(yield* notes(j)).toEqual(['cart']);
			})
	);

	it.effect(
		'signing in to an existing account merges: its refs move to the account, the anonymous user retires and is pruned',
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				const existing = (yield* bootOf(yield* signIn('old@example.com'), 'shop')).actor.id;
				const j: Jar = new Map(),
					ip = '198.51.100.22';
				const me = yield* anonymous(j, 'shop', ip);
				expect(yield* order(j, 'guest order', ip)).toBe('committed');
				yield* signIn('old@example.com', j);
				expect(j.has(VISITOR)).toBe(false);
				expect((yield* bootOf(j, 'shop')).actor.id).toBe(existing);
				expect(yield* owners('guest order')).toEqual([existing]);
				expect(yield* notes(j)).toEqual(['guest order']);
				expect(yield* user(me.visitor ?? '')).toEqual([
					{ kind: 'anonymous', active: false, sessions: 0 }
				]);
				// the daily prune: the retired user goes now; an unused one after 30 days, unless a record references it
				const idle = (yield* anonymous(new Map())).visitor ?? '';
				const kept: Jar = new Map();
				const owner = (yield* anonymous(kept)).visitor ?? '';
				expect(yield* order(kept, 'kept')).toBe('committed');
				t.clock.advance('31d');
				yield* t.runDue();
				expect(yield* user(me.visitor ?? '')).toEqual([]);
				expect(yield* user(idle)).toEqual([]);
				expect(yield* user(owner)).toEqual([{ kind: 'anonymous', active: true, sessions: 1 }]);
			})
	);
});
