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
	collections: {
		orders: { read: { fields: 'all' } },
		lines: { read: { fields: 'all' } },
		employees: { read: { fields: 'all' } }
	},
	integrations: {},
	pipelines: {},
	policies: {
		qty: { description: '', grants: { lines: { read: { fields: ['qty'] } } } },
		rep: {
			description: '',
			limits: { act: '10/min' },
			grants: {
				orders: {
					read: { where: { region: { eq: 'north' } }, fields: ['status', 'region', 'amount'] },
					update: { where: 'read', fields: ['note', 'status'] },
					approval: { update: { steps: [['Finance']] } },
					moves: { status: ['draft->submitted'] }
				},
				lines: { via: 'order' }
			}
		},
		auditor: { description: '', grants: { orders: { read: true } } },
		kiosk: {
			description: '',
			grants: {
				employees: {
					update: {
						previous: { face: { in: ['NONE', 'APPROVED'] } },
						where: { face: { eq: 'APPROVED' } },
						fields: ['face']
					}
				}
			}
		},
		stamp: {
			description: '',
			grants: {
				employees: {
					update: {
						previous: { checked_at: { isNull: true } },
						where: { checked_at: { isNull: false } }
					}
				}
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
	it('held grants union; a field no arm narrows is unmasked, a narrowed one shows where an admitting arm holds (rule 14)', () => {
		const rep = auth(['rep']).collections.orders!;
		expect(rep.masks.note).toEqual({ t: 'const', value: false });
		expect(rep.masks.amount).toBeUndefined();
		const both = auth(['rep', 'auditor']);
		expect(both.collections.orders!.masks).toEqual({});
		expect(readScope(both, 'orders')).toEqual({ t: 'const', value: true });
		expect(readScope(auth(['kiosk']), 'orders')).toBeUndefined();
		// a relationship's foreign key is a field: a `fields` list that omits it masks it (the kiosk read the owner's id)
		expect(auth(['qty']).collections.lines!.masks).toEqual({ order: { t: 'const', value: false } });
	});

	it("`where: 'read'` is the read grant; a source approval route compiles beside the direct grant; an administrator holds every write arm but identity's", () => {
		const rep = auth(['rep']).collections.orders!;
		expect(rep.update[0]!.where).toEqual(rep.read[0]!.where);
		expect(rep.approval.update).toEqual([{ steps: [['Finance']] }]);
		const admin = auth([], { admin: true, actor: member({ admin: true }) });
		expect(admin.collections.orders!.create).toHaveLength(1);
		expect(admin.collections.sys_user!.update).toHaveLength(0); // identity is written by admin verbs only (38c)
	});

	it('moves: only listed edges; `all` and admins every declared one (rule 34)', () => {
		expect(admitMove(auth(['rep']), 'orders', 'status', 'draft', 'submitted')).toBe(true);
		expect(admitMove(auth(['rep']), 'orders', 'status', 'submitted', 'ordered')).toBe(false);
		expect(admitMove(auth([], { admin: true }), 'orders', 'status', 'submitted', 'ordered')).toBe(
			true
		);
	});

	it('via inherits the parent: reads its read, writes its update, through the one-relation', () => {
		const lines = auth(['rep']).collections.lines!;
		expect(lines.read[0]!.where).toEqual({
			t: 'one',
			rel: 'order',
			target: 'orders',
			pred: { t: 'cmp', field: 'region', op: 'eq', arg: { _tag: 'Lit', value: 'north' } }
		});
		expect(lines.create).toHaveLength(1);
		expect(lines.delete[0]!.where).toMatchObject({ t: 'one', rel: 'order' });
	});

	it('a via whose parent is itself via nests through both hops, whatever the declaration order', () => {
		const chain: EngineManifest = {
			...m,
			models: {
				...m.models,
				notes: { description: '', label: 'body', fields: { body: { kind: 'text' } } }
			},
			relationships: { ...m.relationships, 'notes.line': { to: 'lines' } },
			policies: {
				deep: {
					description: '',
					grants: {
						notes: { via: 'line' },
						lines: { via: 'order' },
						orders: { read: { where: { region: { eq: 'north' } } } }
					}
				}
			}
		};
		const notes = compileAuthority(
			chain,
			{ actor: member(), admin: false, policies: ['deep'] },
			'k'
		).collections.notes!;
		expect(notes.read[0]!.where).toEqual({
			t: 'one',
			rel: 'line',
			target: 'lines',
			pred: {
				t: 'one',
				rel: 'order',
				target: 'orders',
				pred: { t: 'cmp', field: 'region', op: 'eq', arg: { _tag: 'Lit', value: 'north' } }
			}
		});
	});

	it('an unknown policy confers nothing', () => {
		const a = auth(['nope']);
		expect(a.policies).toEqual([]);
		expect(Object.keys(a.collections).filter((c) => !c.startsWith('sys_'))).toEqual([]);
	});

	it('the kernel directory: staff read staff (id, name); externals themselves and their party (rule 35a)', () => {
		expect(auth([]).collections.sys_user!.read).toEqual([
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
		expect(ext.collections.sys_user!.read[0]!.where).toMatchObject({ t: 'or' });
		expect(ext.collections.sys_team).toBeUndefined();
		const visitor = compileAuthority(
			m,
			{ actor: { kind: 'visitor', app: 'careers', visitor: 'v' }, admin: false, policies: [] },
			'k'
		);
		expect(visitor.collections.sys_user).toBeUndefined();
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
