import { describe, expect, it } from 'vitest';
import {
	admitMove,
	compileAuthority,
	readScope,
	type Holder
} from '../src/engine/access/authority.ts';
import {
	addressBucket,
	chargesFor,
	clientAddress,
	parseRate,
	RateWindows
} from '../src/engine/access/rate.ts';
import type { EngineActor } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { approvalFlow, snapshotOf } from '../src/decl/access/policy.ts';

const state = {
	kind: 'state',
	initial: 'draft',
	states: {
		draft: { to: ['submitted'] },
		submitted: { to: ['ordered', 'draft'] },
		ordered: { edit: 'none' }
	}
} as const;
const m: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: {
			description: '',
			label: 'region',
			fields: {
				status: state,
				region: { kind: 'text' },
				amount: { kind: 'money' },
				note: { kind: 'text', optional: true }
			}
		},
		lines: { description: '', label: 'qty', fields: { qty: { kind: 'int' } } },
		employees: {
			description: '',
			label: 'face',
			fields: {
				face: { kind: 'enum', values: ['NONE', 'PENDING', 'APPROVED'] },
				checked_at: { kind: 'instant', optional: true }
			}
		}
	},
	relationships: { 'lines.order': { to: 'orders', inverse: 'lines', owned: true } },
	exposures: {
		orders: {
			read: { orders: { fields: 'all' }, 'orders.lines': { fields: 'all' } },
			update: { columns: { orders: ['note', 'status'], 'orders.lines': ['qty'] } }
		},
		lines: { read: { lines: { fields: 'all' } } },
		employees: {
			read: { employees: { fields: 'all' } },
			update: { columns: { employees: ['face', 'checked_at'] } }
		}
	},
	integrations: {},
	policies: {
		qty: { description: '', grants: { lines: { read: { lines: { fields: ['qty'] } } } } },
		rep: {
			description: '',
			limits: { act: '10/min' },
			grants: {
				orders: {
					read: {
						orders: { where: { region: { eq: 'north' } }, fields: ['status', 'region', 'amount'] },
						'orders.lines': { where: { qty: { gt: 0 } } }
					},
					update: { columns: { orders: ['note', 'status'] }, check: true },
					moves: { status: ['draft->submitted'] }
				}
			}
		},
		auditor: { description: '', grants: { orders: { read: true } } },
		root_only: { description: '', grants: { orders: { read: { orders: {} } } } },
		kiosk: {
			description: '',
			grants: {
				employees: { update: { columns: { employees: ['face'] }, check: true } }
			}
		},
		stamp: {
			description: '',
			grants: {
				employees: { update: { check: true } }
			}
		},
		desk: {
			description: '',
			grants: {},
			limits: {
				'envoys.receive': [
					{ rate: '30/min', per: 'sender' },
					{ rate: '300/min', per: 'subject' }
				]
			}
		}
	},
	teams: { Finance: [] },
	automations: {
		nightly: { description: '', runAs: ['auditor'] },
		relay: { description: '', runAs: 'trigger' }
	},
	connections: {},
	envoys: {},
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
	customFields: {},
	agent: { skills: {} }
};

const member = (over: Partial<Extract<EngineActor, { kind: 'member' }>> = {}): EngineActor => ({
	kind: 'member',
	id: 'u1',
	email: 'a@x.io',
	phone: null,
	external: false,
	teams: [],
	teamPath: [],
	admin: false,
	party: null,
	...over
});
const auth = (policies: string[], over: Partial<Holder> = {}) =>
	compileAuthority(m, { actor: member(), admin: false, policies, ...over }, 'k');

describe('engine/access: Authority (rules 33–37)', () => {
	it('held grants union per path; a field no arm narrows is unmasked, a narrowed one shows where an admitting arm holds (rule 14)', () => {
		const rep = auth(['rep']).models.orders!;
		expect(rep.masks.orders?.note).toEqual({ t: 'const', value: false });
		expect(rep.masks.orders?.amount).toBeUndefined();
		expect(rep.masks['orders.lines']).toEqual({});
		const both = auth(['rep', 'auditor']);
		expect(both.models.orders!.masks.orders).toEqual({});
		expect(readScope(both, 'orders')).toEqual({ t: 'const', value: true });
		expect(readScope(auth(['kiosk']), 'orders')).toBeUndefined();
		// a relationship's foreign key is a field: a `fields` list that omits it masks it (the kiosk read the owner's id)
		expect(auth(['qty']).models.lines!.masks.lines).toEqual({
			order: { t: 'const', value: false }
		});
	});

	it("write arms hold their columns and the check flag; a bare check admits every declared column; an administrator holds every write arm but identity's", () => {
		const rep = auth(['rep']).models.orders!;
		expect(rep.update).toEqual([
			{ policy: 'rep', columns: { orders: ['note', 'status'] }, check: true }
		]);
		expect(rep.create).toEqual([]);
		expect(auth(['kiosk']).models.employees!.update).toEqual([
			{ policy: 'kiosk', columns: { employees: ['face'] }, check: true }
		]);
		expect(auth(['stamp']).models.employees!.update).toEqual([
			{ policy: 'stamp', columns: { employees: ['face', 'checked_at'] }, check: true }
		]);
		const admin = auth([], { admin: true, actor: member({ admin: true }) });
		expect(admin.models.orders!.create).toHaveLength(1);
		expect(admin.models.orders!.update).toEqual([
			{
				policy: '$admin',
				columns: { orders: ['note', 'status'], 'orders.lines': ['qty'] },
				check: false
			}
		]);
		expect(admin.models.sys_user!.update).toHaveLength(0); // identity is written by admin verbs only (38c)
	});

	it('moves: only listed edges; `all` and admins every declared one (rule 34)', () => {
		expect(admitMove(auth(['rep']), 'orders', 'status', 'draft', 'submitted')).toBe(true);
		expect(admitMove(auth(['rep']), 'orders', 'status', 'submitted', 'ordered')).toBe(false);
		expect(admitMove(auth([], { admin: true }), 'orders', 'status', 'submitted', 'ordered')).toBe(
			true
		);
	});

	it("a layer's arms come from its root's policy alone; the layer's own model gains no access point", () => {
		const rep = auth(['rep']);
		const orders = rep.models.orders!;
		expect(orders.read.orders).toMatchObject([
			{ policy: 'rep', fields: ['status', 'region', 'amount'] }
		]);
		expect(orders.read['orders.lines']).toEqual([
			{
				policy: 'rep',
				where: { t: 'cmp', field: 'qty', op: 'gt', arg: { _tag: 'Lit', value: 0 } },
				fields: 'all'
			}
		]);
		// reading `lines` directly is a different access point: `rep` grants none
		expect(rep.models.lines).toBeUndefined();
		expect(readScope(rep, 'lines')).toBeUndefined();
	});

	it('a declared layer a grant does not name is read in full; `read: true` opens every declared layer', () => {
		const open = { where: { t: 'const', value: true }, fields: 'all' };
		expect(auth(['root_only']).models.orders!.read['orders.lines']).toEqual([
			{ policy: 'root_only', ...open }
		]);
		expect(auth(['auditor']).models.orders!.read).toEqual({
			orders: [{ policy: 'auditor', ...open }],
			'orders.lines': [{ policy: 'auditor', ...open }]
		});
	});

	it('an unknown policy confers nothing', () => {
		const a = auth(['nope']);
		expect(a.policies).toEqual([]);
		expect(Object.keys(a.models).filter((c) => !c.startsWith('sys_'))).toEqual([]);
	});

	it('a check-only grant grants only its write verb, with every declared column; an empty flow is invalid', () => {
		const empty: EngineManifest = {
			...m,
			policies: {
				...m.policies,
				open: {
					description: '',
					grants: { orders: { read: true, update: { check: true } } }
				}
			}
		};
		const granted = compileAuthority(
			empty,
			{ actor: member(), admin: false, policies: ['open'] },
			'k'
		).models.orders!;
		expect(granted.update).toEqual([
			{
				policy: 'open',
				columns: { orders: ['note', 'status'], 'orders.lines': ['qty'] },
				check: true
			}
		]);
		expect(granted.create).toEqual([]);
		expect(granted.delete).toEqual([]);
		expect(() => snapshotOf(approvalFlow())).toThrow('add a step');
	});

	it('the kernel directory: staff read staff (id, name); externals themselves and their party (rule 35a)', () => {
		expect(auth([]).models.sys_user!.read.sys_user).toEqual([
			{
				policy: '$directory',
				where: { t: 'cmp', field: 'kind', op: 'eq', arg: { _tag: 'Lit', value: 'staff' } },
				fields: ['id', 'name']
			}
		]);
		const ext = compileAuthority(
			m,
			{ actor: member({ external: true }), admin: false, policies: [] },
			'k'
		);
		expect(ext.models.sys_user!.read.sys_user?.[0]?.where).toMatchObject({ t: 'or' });
		expect(Object.keys(ext.models)).toEqual(['sys_user']);
		const visitor = compileAuthority(
			m,
			{ actor: { kind: 'visitor', app: 'careers', visitor: 'v' }, admin: false, policies: [] },
			'k'
		);
		expect(visitor.models.sys_user).toBeUndefined();
	});

	it('limits: declared buckets replace the default of their key; visitors default per IP (rule 38, 72)', () => {
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
			chargesFor(auth(['desk']), ['envoys.receive'], { sender: 's', subject: 'e' }).map(
				(c) => c.limit
			)
		).toEqual([30, 300]);
		const v = compileAuthority(
			m,
			{ actor: { kind: 'visitor', app: 'careers', visitor: 'v' }, admin: false, policies: [] },
			'k'
		);
		expect(chargesFor(v, ['register'], { ip: 'mac' })).toEqual([
			{ rule: 'register:20/h:ip', bucket: 'mac', limit: 20, windowMs: 3_600_000 }
		]);
	});

	it('compiled once per key (rule 37); `runAs: trigger` runs as the trigger', () => {
		const as = new Authorities(m, 'r1');
		const h: Holder = { actor: member(), admin: false, policies: ['rep'] };
		expect(as.compile(h, 'x')).toBe(as.compile(h, 'x'));
		expect(as.compile(h, 'y')).not.toBe(as.compile(h, 'x'));
		const trigger = as.compile(h, 'x');
		expect(as.system('run1', { automation: 'relay' }, trigger)).toBe(trigger);
		expect(as.system('run1', { automation: 'nightly' }).policies).toEqual(['auditor']);
		expect(as.visitor('careers', 'v1').policies).toEqual(['auditor']);
	});
});

describe('engine/access: rate windows (rule 38)', () => {
	it('the second request over a 1/min limit is refused, refusals count, and the window rolls', () => {
		const w = new RateWindows();
		const c = [{ rule: 'act', bucket: 'u1', ...parseRate('1/min') }];
		expect(w.charge(c, 0)).toEqual({ ok: true });
		expect(w.charge(c, 1_000)).toEqual({ ok: false, retryAfter: 59 });
		expect(w.charge(c, 60_000)).toEqual({ ok: true });
		expect(parseRate('1/15min')).toEqual({ limit: 1, windowMs: 900_000 });
	});

	it('evicts the least recently used bucket, which restarts from its persisted count', () => {
		const w = new RateWindows(2);
		const c = (bucket: string) => [{ rule: 'act', bucket, limit: 1, windowMs: 60_000 }];
		w.charge(c('a'), 0);
		w.charge(c('b'), 0);
		w.charge(c('c'), 0);
		expect(w.charge(c('a'), 0).ok).toBe(true); // evicted: memory forgot it
		w.load([{ rule: 'act', bucket: 'b', window_start: new Date(0).toISOString(), n: 1 }]);
		expect(w.charge(c('b'), 0).ok).toBe(false);
	});

	it('peers behind a declared two-hop proxy chain count apart; behind an undeclared one, together; one IPv6 /64 is one bucket', () => {
		const trusted = ['10.0.0.0/8'];
		expect(clientAddress('10.0.0.1', '1.1.1.1, 10.0.0.2', trusted)).toBe('1.1.1.1');
		expect(clientAddress('10.0.0.1', '2.2.2.2, 10.0.0.2', trusted)).toBe('2.2.2.2');
		expect(clientAddress('10.0.0.1', '1.1.1.1, 10.0.0.2', [])).toBe('10.0.0.1');
		expect(clientAddress('10.0.0.1', '6.6.6.6, 1.1.1.1', trusted)).toBe('1.1.1.1'); // a forged left hop is never reached
		expect(addressBucket('2001:db8:1:2:aaaa::1')).toBe(
			addressBucket('2001:db8:1:2:bbbb:cccc:dddd:eeee')
		);
		expect(addressBucket('2001:db8:1:3::1')).not.toBe(addressBucket('2001:db8:1:2::1'));
		expect(addressBucket('::ffff:1.2.3.4')).toBe('1.2.3.4');
	});
});
