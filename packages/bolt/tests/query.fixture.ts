// A small workspace for the query engine's tests: accounts ← orders ← lines, an arc on notes, a masked field.
import type { Authority, Bindings, CollectionAuthority, EngineManifest, Pred } from '../src/engine/contracts.ts';
import { SEARCH_FUNCTIONS } from '../src/engine/schema/search.ts';

const sys = { description: 'x', label: 'name' } as const;
export const manifest: EngineManifest = {
	workspace: { tz: 'Asia/Kuala_Lumpur', locale: 'en' },
	models: {
		accounts: { ...sys, fields: { name: { kind: 'text' }, region: { kind: 'text', optional: true }, secret: { kind: 'text', optional: true } },
			computed: { shout: { kind: 'text', expr: { upper: { field: 'name' } } } }, search: { text: ['name'] } },
		orders: { ...sys, label: 'status', fields: {
			status: { kind: 'enum', values: ['open', 'closed', 'held'] }, total: { kind: 'decimal', scale: 2 }, qty: { kind: 'int' },
			email: { kind: 'text', format: 'email', optional: true }, placed: { kind: 'date' }, at: { kind: 'instant' },
			tags: { kind: 'text', many: true }, note: { kind: 'text', optional: true }, span: { kind: 'period', of: 'date', optional: true },
			doc: { kind: 'json', optional: true }, color: { kind: 'vector', dim: 3, metric: 'l2', optional: true },
			spot: { kind: 'point', optional: true } } },
		lines: { ...sys, label: 'sku', fields: { sku: { kind: 'text' }, amount: { kind: 'decimal', scale: 2 } } },
		notes: { ...sys, label: 'body', fields: { body: { kind: 'text' } } },
	},
	relationships: {
		'orders.account': { to: 'accounts', inverse: 'orders' },
		'lines.order': { to: 'orders', inverse: 'lines', owned: true },
		'notes.about': { to: ['accounts', 'orders'], inverse: 'notes' },
	},
	collections: {
		accounts: { read: { fields: 'all' } },
		orders: { read: { fields: 'all' }, similarity: { hue: { description: 'nearest colour', input: {}, candidates: 3 } } },
		lines: { read: { fields: 'all' } },
		notes: { read: { fields: ['body', 'about'], relations: ['about'] } },
	},
	integrations: {}, pipelines: {}, policies: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {},
	customFields: {}, agent: { skills: {} },
};

/** The DDL the schema area emits for this manifest, reduced to what reads touch. */
export const DDL = `
create extension if not exists vector;
${SEARCH_FUNCTIONS.map((f) => `${f.sql};`).join('\n')}
create table accounts (id uuid primary key, revision int not null default 1, approval_id uuid, created_at timestamptz not null default now(),
	created_by text, updated_at timestamptz not null default now(), updated_by text,
	name text not null, region text, secret text, shout text generated always as (upper(name)) stored,
	bolt_search tsvector generated always as (bolt_search_document(coalesce(name::text, ''))) stored);
create table orders (id uuid primary key, revision int not null default 1, approval_id uuid, created_at timestamptz not null default now(),
	created_by text, updated_at timestamptz not null default now(), updated_by text,
	account uuid not null references accounts, status text not null, total numeric not null, qty int not null, email text, placed date not null,
	at timestamptz not null, tags text[] not null default '{}', note text, span daterange, doc jsonb, color vector(3), spot point);
create table lines (id uuid primary key, revision int not null default 1, approval_id uuid, created_at timestamptz not null default now(),
	created_by text, updated_at timestamptz not null default now(), updated_by text,
	"order" uuid not null references orders, sku text not null, amount numeric not null);
create table notes (id uuid primary key, revision int not null default 1, approval_id uuid, created_at timestamptz not null default now(),
	created_by text, updated_at timestamptz not null default now(), updated_by text,
	about__accounts uuid references accounts, about__orders uuid references orders, body text not null);
`;

export const bindings: Bindings = { now: '2026-09-25T04:00:00.000Z', today: '2026-09-25', tz: 'Asia/Kuala_Lumpur', params: { min: '100', who: 'a@x.io' } };

const eq = (field: string, lit: string): Pred => ({ t: 'cmp', field, op: 'eq', arg: { lit } });
const arm = (where: Pred, masks: CollectionAuthority['masks'] = {}): CollectionAuthority => ({
	read: [{ policy: 'rep', where, fields: 'all' }], history: [], create: [], update: [], delete: [], queries: [], actions: [], moves: {}, masks,
});
/** A rep: sees northern accounts and their orders; an order's `total` only while it is open; never an account's `secret`. */
export const rep: Authority = {
	key: 'rep', admin: false, policies: ['rep'],
	actor: { kind: 'member', id: 'u1', email: 'A@X.io', external: false, teams: ['t1'], teamPath: ['t1'], admin: false, party: null },
	collections: {
		accounts: arm(eq('region', 'north'), { secret: { t: 'const', value: false } }),
		orders: arm({ t: 'one', rel: 'account', target: 'accounts', pred: eq('region', 'north') }, { total: eq('status', 'open') }),
		lines: arm({ t: 'const', value: true }),
		notes: arm({ t: 'const', value: true }),
	},
	automations: [], capabilities: { apps: [], tools: [], mcp: [], skills: [] }, limits: [], teamTree: ['t1', 't2'], scopes: {},
};
