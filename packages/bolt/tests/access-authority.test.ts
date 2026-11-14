import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import {
	admitMove,
	compile_authority,
	exposed,
	grantedArms,
	historyArms,
	readPredicates,
	viewOutput,
	type Holder
} from '../src/engine/access/authority.ts';
import {
	addressBucket,
	charges_for,
	parse_rate,
	RateWindows
} from '../src/engine/access/rate.ts';
import { or } from '../src/engine/access/pred.ts';
import type { EngineActor } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Authorities } from '../src/engine/identity/actor.ts';

const required = <A>(value: A | undefined): A => {
	if (value === undefined) throw new Error('Missing authority fixture value.');
	return value;
};
const state = {
	kind: 'state',
	initial: 'draft',
	states: {
		draft: { to: ['submitted'] },
		submitted: { to: ['ordered', 'draft'] },
		ordered: {}
	}
} as const;
const m: EngineManifest = {
	needs: [],
	workspace: {
		tz: 'UTC',
		locale: 'en',
		limits: {
			rep: { act: '10/min' },
			desk: {
				'envoys.receive': [
					{ rate: '30/min', per: 'sender' },
					{ rate: '300/min', per: 'subject' }
				]
			}
		}
	},
	models: {
		orders: {
			description: '',
			record_label: 'record.region',
			locks: { ordered: { where: { status: { eq: 'ordered' } } } },
			fields: {
				status: state,
				region: { kind: 'text' },
				amount: { kind: 'money' },
				note: { kind: 'text', optional: true }
			}
		},
		lines: { description: '', record_label: 'record.qty', fields: { qty: { kind: 'int' } } },
		employees: {
			description: '',
			record_label: 'record.face',
			fields: {
				face: { kind: 'enum', values: ['NONE', 'PENDING', 'APPROVED'] },
				checked_at: { kind: 'instant', optional: true }
			}
		}
	},
	relationships: { 'lines.order': { to: 'orders', inverse: 'lines', owned: true } },
	exposures: {
		orders: {
			outputs: {
				default: { orders: { fields: 'all' }, 'orders.lines': { fields: 'all' } },
				summary: { orders: { fields: ['status', 'region'] } }
			},
			update: { columns: { orders: ['note', 'status'], 'orders.lines': ['qty'] } }
		},
		lines: { outputs: { default: { lines: { fields: 'all' } } } },
		employees: {
			outputs: { default: { employees: { fields: 'all' } } },
			update: { columns: { employees: ['face', 'checked_at'] } }
		}
	},
	integrations: {},
	policies: {
		clerk: {
			description: '',
			grants: {
				orders: { outputs: { summary: { scopes: { orders: { region: { eq: 'south' } } } } } }
			}
		},
		rep: {
			description: '',
			grants: {
				orders: {
					outputs: {
						default: {
							scopes: { orders: { region: { eq: 'north' } }, 'orders.lines': { qty: { gt: 0 } } }
						}
					},
					update: {
						columns: { orders: ['note', 'status'] },
						verdict: true,
						moves: { status: ['draft->submitted'] }
					}
				}
			}
		},
		auditor: { description: '', grants: { orders: { outputs: { default: {} } } } },
		root_only: {
			description: '',
			grants: { orders: { outputs: { default: { scopes: { orders: {} } } } } }
		},
		kiosk: {
			description: '',
			grants: {
				employees: { update: { columns: { employees: ['face'] }, verdict: true } }
			}
		},
		stamp: {
			description: '',
			grants: {
				employees: { update: { verdict: true } }
			}
		},
		desk: {
			description: '',
			grants: {}
		}
	},
	teams: { Finance: { policies: [] } },
	automations: {
		nightly: { description: '', policies: ['auditor'] }
	},
	mcp: {},
	apps: {
		careers: {
			title: 'Careers',
			description: 'Public careers',
			icon: 'lucide:briefcase',
			pages: {},
			audience: { public: ['auditor'] }
		}
	},
	custom_fields: {},
	agent: { skills: {} }
};

const member = (over: Partial<Extract<EngineActor, { kind: 'member' }>> = {}): EngineActor => ({
	kind: 'member',
	id: 'u1',
	email: 'a@x.io',
	phone: null,
	external: false,
	teams: [],
	team_path: [],
	admin: false,
	party: null,
	...over
});
const auth = (policies: string[], over: Partial<Holder> = {}) =>
	Effect.runSync(compile_authority(m, { actor: member(), admin: false, policies, ...over }, 'k'));

const combined_scope = (authority: ReturnType<typeof auth>, model: string, output = 'default') => {
	const predicates = readPredicates(authority, model, output);
	return predicates === undefined || predicates.length === 0 ? undefined : or(predicates);
};

describe('engine/access: Authority', () => {
	it('grants union per output and path; an output no held grant names is not read; outputs fix their fields', () => {
		const rep = auth(['rep']);
		expect(Object.keys(required(rep.models.orders).read)).toEqual(['default']);
		expect(grantedArms(rep, 'orders', 'summary')).toBeUndefined();
		expect(viewOutput(m, rep, 'orders')).toBe('default');
		const clerk = auth(['clerk']);
		expect(grantedArms(clerk, 'orders')).toBeUndefined();
		expect(combined_scope(clerk, 'orders')).toBeUndefined();
		expect(combined_scope(clerk, 'orders', 'summary')).toEqual({
			t: 'cmp',
			field: 'region',
			op: 'eq',
			arg: { _tag: 'Lit', value: 'south' }
		});
		expect(viewOutput(m, clerk, 'orders')).toBe('summary');
		expect(viewOutput(m, auth(['kiosk']), 'orders')).toBeUndefined();
		const both = auth(['rep', 'auditor']);
		expect(
			required(required(required(both.models.orders).read.default).orders).map((a) => a.policy)
		).toEqual(['rep', 'auditor']);
		expect(combined_scope(both, 'orders')).toEqual({ t: 'const', value: true });
		expect(combined_scope(auth(['kiosk']), 'orders')).toBeUndefined();
		const admin = auth([], { admin: true, actor: member({ admin: true }) });
		expect(Object.keys(required(admin.models.orders).read)).toEqual(['default', 'summary']);
		expect(exposed(m, 'orders', 'orders', 'orders', 'summary')).toEqual(['status', 'region']);
		expect(exposed(m, 'orders', 'orders', 'orders')).toEqual([
			'status',
			'region',
			'amount',
			'note'
		]);
		// a relationship's foreign key is a field of the output that reads it
		expect(exposed(m, 'lines', 'lines', 'lines')).toEqual(['qty', 'order']);
	});

	it.effect(
		"history uses the reader's current read scope; an explicit history grant cannot widen it",
		() =>
			Effect.gen(function* () {
				const north = {
					t: 'cmp' as const,
					field: 'region',
					op: 'eq' as const,
					arg: { _tag: 'Lit' as const, value: 'north' }
				};
				const rep = auth(['rep']);
				expect(combined_scope(rep, 'orders')).toEqual(north);
				const clerk = auth(['clerk']);
				expect(combined_scope(clerk, 'orders')).toBeUndefined();
				expect(combined_scope(clerk, 'orders', 'summary')).toEqual({
					t: 'cmp',
					field: 'region',
					op: 'eq',
					arg: { _tag: 'Lit', value: 'south' }
				});
				expect(combined_scope(auth(['auditor']), 'orders')).toEqual({ t: 'const', value: true });
				expect(combined_scope(auth(['kiosk']), 'orders')).toBeUndefined();
				const wider: EngineManifest = {
					...m,
					policies: {
						...m.policies,
						over: {
							description: '',
							grants: {
								orders: {
									outputs: {
										default: { history: true, scopes: { orders: { region: { eq: 'north' } } } }
									}
								}
							}
						},
						lurker: { description: '', grants: { orders: {} } }
					}
				};
				const over = yield* compile_authority(
					wider,
					{ actor: member(), admin: false, policies: ['over'] },
					'k'
				);
				expect(combined_scope(over, 'orders')).toEqual(north);
				expect(historyArms(over, 'orders', 'default')).toEqual([
					{ policy: 'over', where: north, history: true }
				]);
				const combined = yield* compile_authority(
					wider,
					{ actor: member(), admin: false, policies: ['over', 'auditor'] },
					'combined'
				);
				expect(combined_scope(combined, 'orders')).toEqual({ t: 'const', value: true });
				expect(historyArms(combined, 'orders', 'default')).toEqual([
					{ policy: 'over', where: north, history: true }
				]);
				const lurker = yield* compile_authority(
					wider,
					{ actor: member(), admin: false, policies: ['lurker'] },
					'k'
				);
				expect(combined_scope(lurker, 'orders')).toBeUndefined();
			})
	);

	it("write arms hold their columns and the check flag; a bare check admits every declared column; an administrator holds every write arm but identity's", () => {
		const rep = required(auth(['rep']).models.orders);
		expect(rep.update).toEqual([
			{ policy: 'rep', columns: { orders: ['note', 'status'] }, check: true }
		]);
		expect(rep.create).toEqual([]);
		expect(required(auth(['kiosk']).models.employees).update).toEqual([
			{ policy: 'kiosk', columns: { employees: ['face'] }, check: true }
		]);
		expect(required(auth(['stamp']).models.employees).update).toEqual([
			{ policy: 'stamp', columns: { employees: ['face', 'checked_at'] }, check: true }
		]);
		const admin = auth([], { admin: true, actor: member({ admin: true }) });
		expect(required(admin.models.orders).create).toHaveLength(1);
		expect(required(admin.models.orders).update).toEqual([
			{
				policy: '$admin',
				columns: { orders: ['note', 'status'], 'orders.lines': ['qty'] },
				check: false
			}
		]);
		expect(required(admin.models.sys_user).update).toHaveLength(0); // identity is written by admin verbs only (38c)
	});

	it('moves: only listed edges; `all` and admins every declared one', () => {
		expect(admitMove(auth(['rep']), 'orders', 'status', 'draft', 'submitted')).toBe(true);
		expect(admitMove(auth(['rep']), 'orders', 'status', 'submitted', 'ordered')).toBe(false);
		expect(admitMove(auth([], { admin: true }), 'orders', 'status', 'submitted', 'ordered')).toBe(
			true
		);
	});

	it("a layer's arms come from its root's policy alone; the layer's own model gains no access point", () => {
		const rep = auth(['rep']);
		const orders = required(required(rep.models.orders).read.default);
		expect(orders.orders).toEqual([
			{
				policy: 'rep',
				where: { t: 'cmp', field: 'region', op: 'eq', arg: { _tag: 'Lit', value: 'north' } }
			}
		]);
		expect(orders['orders.lines']).toEqual([
			{
				policy: 'rep',
				where: { t: 'cmp', field: 'qty', op: 'gt', arg: { _tag: 'Lit', value: 0 } }
			}
		]);
		// reading `lines` directly is a different access point: `rep` grants none
		expect(rep.models.lines).toBeUndefined();
		expect(combined_scope(rep, 'lines')).toBeUndefined();
	});

	it('a declared layer a grant does not name is read in full; `read: true` opens every declared layer', () => {
		const open = { where: { t: 'const', value: true } };
		expect(
			required(required(auth(['root_only']).models.orders).read.default)['orders.lines']
		).toEqual([{ policy: 'root_only', ...open }]);
		expect(required(auth(['auditor']).models.orders).read).toEqual({
			default: {
				orders: [{ policy: 'auditor', ...open }],
				'orders.lines': [{ policy: 'auditor', ...open }]
			}
		});
	});

	it('an unknown policy confers nothing', () => {
		const a = auth(['nope']);
		expect(a.policies).toEqual([]);
		expect(Object.keys(a.models).filter((c) => !c.startsWith('sys_'))).toEqual([]);
	});

	it.effect(
		'a check-only grant grants only its write verb, with every declared column; an empty flow is invalid',
		() =>
			Effect.gen(function* () {
				const empty: EngineManifest = {
					...m,
					policies: {
						...m.policies,
						open: {
							description: '',
							grants: { orders: { outputs: { default: {} }, update: { verdict: true } } }
						}
					}
				};
				const granted = required(
					(yield* compile_authority(
						empty,
						{ actor: member(), admin: false, policies: ['open'] },
						'k'
					)).models.orders
				);
				expect(granted.update).toEqual([
					{
						policy: 'open',
						columns: { orders: ['note', 'status'], 'orders.lines': ['qty'] },
						check: true
					}
				]);
				expect(granted.create).toEqual([]);
				expect(granted.delete).toEqual([]);
			})
	);

	it.effect(
		'the kernel directory: staff read staff (id, name); externals themselves and their party',
		() =>
			Effect.gen(function* () {
				expect(required(auth([]).models.sys_user).read).toEqual({
					directory: {
						sys_user: [
							{
								policy: '$directory',
								where: { t: 'cmp', field: 'kind', op: 'eq', arg: { _tag: 'Lit', value: 'staff' } }
							}
						]
					}
				});
				expect(exposed(m, 'sys_user', 'sys_user', 'sys_user', 'directory')).toEqual(['name']); // id is a system column
				const ext = yield* compile_authority(
					m,
					{ actor: member({ external: true }), admin: false, policies: [] },
					'k'
				);
				expect(required(ext.models.sys_user).read.directory?.sys_user?.[0]?.where).toMatchObject({
					t: 'or'
				});
				expect(Object.keys(ext.models)).toEqual(['sys_user']);
				const visitor = yield* compile_authority(
					m,
					{ actor: { kind: 'visitor', app: 'careers', visitor: 'v' }, admin: false, policies: [] },
					'k'
				);
				expect(visitor.models.sys_user).toBeUndefined();
			})
	);

	it.effect(
		'limits: declared buckets replace the default of their key; visitors default per IP',
		() =>
			Effect.gen(function* () {
				const rep = auth(['rep']);
				expect(rep.limits.filter((l) => l.key === 'act')).toEqual([
					{ key: 'act', rate: '10/min', per: 'actor' }
				]);
				expect(rep.limits.find((l) => l.key === 'read')).toEqual({
					key: 'read',
					rate: '3000/min',
					per: 'actor'
				});
				expect(
					charges_for(auth(['desk']), ['envoys.receive'], { sender: 's', subject: 'e' }).map(
						(c) => c.limit
					)
				).toEqual([30, 300]);
				const v = yield* compile_authority(
					m,
					{ actor: { kind: 'visitor', app: 'careers', visitor: 'v' }, admin: false, policies: [] },
					'k'
				);
				expect(charges_for(v, ['register'], { ip: 'mac' })).toEqual([
					{ rule: 'register:20/h:ip', bucket: 'mac', limit: 20, windowMs: 3_600_000 }
				]);
			})
	);

	it('a limit two of a holder’s policies both declare is one bucket, charged once', () => {
		const rep = auth(['rep']);
		const twice = { ...rep, limits: [...rep.limits, ...rep.limits] };
		expect(charges_for(twice, ['act'], { actor: 'u' })).toEqual(
			charges_for(rep, ['act'], { actor: 'u' })
		);
		expect(charges_for(twice, ['act'], { actor: 'u' })).toHaveLength(1);
	});

	it.effect('compiled once per key; a run holds exactly its policies', () =>
		Effect.gen(function* () {
			const as = new Authorities(m, 'r1');
			const h: Holder = { actor: member(), admin: false, policies: ['rep'] };
			const x = yield* as.compile(h, 'x');
			expect(yield* as.compile(h, 'x')).toBe(x);
			expect(yield* as.compile(h, 'y')).not.toBe(x);
			expect((yield* as.system('run1', { automation: 'nightly' })).policies).toEqual(['auditor']);
			expect((yield* as.visitor('careers', 'v1')).policies).toEqual(['auditor']);
		})
	);
});

describe('engine/access: rate windows', () => {
	it('the second request over a 1/min limit is refused, refusals count, and the window rolls', () => {
		const w = new RateWindows();
		const c = [{ rule: 'act', bucket: 'u1', ...parse_rate('1/min') }];
		expect(w.charge(c, 0)).toEqual({ ok: true });
		expect(w.charge(c, 1_000)).toEqual({ ok: false, retryAfter: 59 });
		expect(w.charge(c, 60_000)).toEqual({ ok: true });
		expect(parse_rate('1/15min')).toEqual({ limit: 1, windowMs: 900_000 });
	});

	it('evicts the oldest bucket when full; a bucket restarts from its persisted count', () => {
		const w = new RateWindows(2);
		const c = (bucket: string) => [{ rule: 'act', bucket, limit: 1, windowMs: 60_000 }];
		w.charge(c('a'), 0);
		w.charge(c('b'), 0);
		w.charge(c('c'), 0);
		expect(w.charge(c('a'), 0).ok).toBe(true); // evicted: memory forgot it
		const fresh = new RateWindows(2);
		fresh.load([{ rule: 'act', bucket: 'b', start: 0, n: 1 }], 0);
		expect(fresh.charge(c('b'), 0).ok).toBe(false);
	});

	it('one IPv6 /64 is one bucket', () => {
		expect(addressBucket('2001:db8:1:2:aaaa::1')).toBe(
			addressBucket('2001:db8:1:2:bbbb:cccc:dddd:eeee')
		);
		expect(addressBucket('2001:db8:1:3::1')).not.toBe(addressBucket('2001:db8:1:2::1'));
		expect(addressBucket('::ffff:1.2.3.4')).toBe('1.2.3.4');
	});
});
