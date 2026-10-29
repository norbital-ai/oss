// A small workspace for the query engine's tests: accounts ← orders ← lines, an arc on notes, and a narrower `brief`
// read output of accounts and orders (no `secret`, no `total`).
import type { Authority, Bindings, ModelAuthority } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { searchFunctions } from '@norbital-ai/store';
import type { Pred } from '@norbital-ai/store';

const sys = { description: 'x', label: 'name' } as const;
export const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'Asia/Kuala_Lumpur', locale: 'en' },
	models: {
		accounts: {
			...sys,
			fields: {
				name: { kind: 'text' },
				region: { kind: 'text', optional: true },
				secret: { kind: 'text', optional: true }
			},
			computed: { shout: { kind: 'text', expr: { upper: { field: 'name' } } } },
			search: { text: ['name'] }
		},
		orders: {
			...sys,
			label: 'status',
			fields: {
				status: { kind: 'enum', values: ['open', 'closed', 'held'] },
				total: { kind: 'decimal', scale: 2 },
				qty: { kind: 'int' },
				email: { kind: 'text', format: 'email', optional: true },
				placed: { kind: 'date' },
				at: { kind: 'instant' },
				tags: { kind: 'text', many: true },
				note: { kind: 'text', optional: true },
				span: { kind: 'period', of: 'date', optional: true },
				doc: { kind: 'json', optional: true },
				color: { kind: 'vector', dim: 3, metric: 'l2', optional: true },
				spot: { kind: 'point', optional: true }
			},
			search: {
				text: [],
				indexes: {
					hue: {
						description: 'Nearest colour',
						dim: 3,
						metric: 'l2',
						field: 'color',
						input: {},
						candidates: 3,
						rerank: true
					}
				}
			}
		},
		lines: {
			...sys,
			label: 'sku',
			fields: { sku: { kind: 'text' }, amount: { kind: 'decimal', scale: 2 } }
		},
		notes: { ...sys, label: 'body', fields: { body: { kind: 'text' } } }
	},
	relationships: {
		'orders.account': { to: 'accounts', inverse: 'orders' },
		'lines.order': { to: 'orders', inverse: 'lines', owned: true },
		'notes.about': { to: ['accounts', 'orders'], inverse: 'notes' }
	},
	exposures: {
		accounts: {
			read: {
				accounts: { fields: 'all' },
				'accounts.orders': { fields: 'all' },
				'accounts.orders.lines': { fields: 'all' }
			},
			outputs: { brief: { accounts: { fields: ['name', 'region'] } } }
		},
		orders: {
			read: {
				orders: { fields: 'all' },
				'orders.account': { fields: 'all' },
				'orders.lines': { fields: 'all' }
			},
			outputs: {
				brief: {
					orders: { fields: ['status', 'qty', 'placed', 'account'] },
					'orders.account': { fields: ['name', 'region'] }
				}
			}
		},
		lines: { read: { lines: { fields: 'all' }, 'lines.order': { fields: 'all' } } },
		notes: { read: { notes: { fields: ['body', 'about'] } } }
	},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};

/** The DDL the schema area emits for this manifest, reduced to what reads touch. */
export const DDL = `
create extension if not exists vector;
${searchFunctions()
	.map((f) => `${f.sql};`)
	.join('\n')}
create table accounts (id uuid primary key, revision int not null default 1, created_at timestamptz not null default now(),
	created_by text, updated_at timestamptz not null default now(), updated_by text,
	name text not null, region text, secret text, shout text generated always as (upper(name)) stored,
	bolt_search tsvector generated always as (bolt_search_document(coalesce(name::text, ''))) stored);
create table orders (id uuid primary key, revision int not null default 1, created_at timestamptz not null default now(),
	created_by text, updated_at timestamptz not null default now(), updated_by text,
	account uuid not null references accounts, status text not null, total numeric not null, qty int not null, email text, placed date not null,
	at timestamptz not null, tags text[] not null default '{}', note text, span daterange, doc jsonb, color vector(3), spot point);
create table lines (id uuid primary key, revision int not null default 1, created_at timestamptz not null default now(),
	created_by text, updated_at timestamptz not null default now(), updated_by text,
	"order" uuid not null references orders, sku text not null, amount numeric not null);
create table notes (id uuid primary key, revision int not null default 1, created_at timestamptz not null default now(),
	created_by text, updated_at timestamptz not null default now(), updated_by text,
	about__accounts uuid references accounts, about__orders uuid references orders, body text not null);
`;

export const bindings: Bindings = {
	now: '2026-09-25T04:00:00.000Z',
	today: '2026-09-25',
	tz: 'Asia/Kuala_Lumpur'
};

const eq = (field: string, value: string): Pred => ({
	t: 'cmp',
	field,
	op: 'eq',
	arg: { _tag: 'Lit', value }
});
const TRUE: Pred = { t: 'const', value: true };
/** Read-only access points of policy `rep`: per output, one arm per read path (its `where`). */
const arm = (
	read: { readonly [path: string]: Pred },
	output = 'default',
	policy = 'rep'
): ModelAuthority => ({
	read: {
		[output]: Object.fromEntries(
			Object.entries(read).map(([path, where]) => [path, [{ policy, where }]])
		)
	},
	history: [],
	create: [],
	update: [],
	delete: [],
	moves: {}
});
const north = eq('region', 'north');
/**
 * A rep: reads the `default` output of the northern accounts and their orders. Each root's own arms scope its layers
 * (decision 3): `orders.account` repeats the northern scope.
 */
export const rep: Authority = {
	key: 'rep',
	admin: false,
	policies: ['rep'],
	actor: {
		kind: 'member',
		id: 'u1',
		email: 'A@X.io',
		phone: null,
		external: false,
		teams: ['t1'],
		teamPath: ['t1'],
		admin: false,
		party: null
	},
	models: {
		accounts: arm({ accounts: north, 'accounts.orders': TRUE, 'accounts.orders.lines': TRUE }),
		orders: arm({
			orders: { t: 'one', rel: 'account', target: 'accounts', pred: north },
			'orders.account': north,
			'orders.lines': TRUE
		}),
		lines: arm({ lines: TRUE, 'lines.order': TRUE }),
		notes: arm({ notes: TRUE })
	},
	automations: [],
	capabilities: { apps: [], tools: [], mcp: [], skills: [] },
	limits: [],
	teamTree: ['t1', 't2'],
	scopes: {}
};
/** A clerk: reads only the `brief` output of the northern accounts and their orders, never `default`. */
export const clerk: Authority = {
	...rep,
	key: 'clerk',
	policies: ['clerk'],
	models: {
		accounts: arm({ accounts: north }, 'brief', 'clerk'),
		orders: arm(
			{
				orders: { t: 'one', rel: 'account', target: 'accounts', pred: north },
				'orders.account': north
			},
			'brief',
			'clerk'
		)
	}
};
