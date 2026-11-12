// The engine's private objects (X-18): bookkeeping no author position, catalogue entry or page names, so none of it is
// a model. Every table the engine reads as a record is a system model (`src/system/**`), planned like a workspace's.
// This is the ONE registry of the rest, each with why it is not a model. Idempotent (`if not exists`, `or replace`),
// re-asserted on every apply (`apply_migrations`) and never dropped; a private table may reference a system table, so they
// render after the models (`schemaObjects`).
import { MINOR_FN, type SchemaObject } from '@norbital-ai/store';
import { AUDIT_FUNCTIONS } from './audit.ts';
import {
	HISTORY_SCHEMA_TABLES,
	HISTORY_SCHEMA_REGISTER,
	HISTORY_SCHEMA_MATCH,
	HISTORY_SCHEMA_PURGE
} from './history.ts';

type Private = {
	name: string;
	rank: 'table' | 'function';
	why: string;
	sql: readonly string[];
	tables?: readonly string[];
	functions?: readonly string[];
	/** Native source migrations carry these definitions and must prove them independently of the host registry. */
	source?: true;
};

const REGISTRY = (): readonly Private[] => [
	{
		name: 'bolt_history_register',
		rank: 'function',
		source: true,
		functions: [
			'bolt_history_register(model_name text, definition jsonb)',
			'bolt_history_matches(history_model text, metadata jsonb, model_name text)',
			'bolt_history_purge_fields(version_id text, model_name text, columns text[])'
		],
		why: 'Schema application registers definitions and preserves identities through declared renames.',
		sql: [HISTORY_SCHEMA_REGISTER, HISTORY_SCHEMA_MATCH, HISTORY_SCHEMA_PURGE]
	},
	{
		name: 'bolt_audit',
		source: true,
		rank: 'function',
		functions: [
			'store_anonymise_fields(table_name text, record_id text)',
			'bolt_audit()'
		],
		why: 'raw SQL row history and held-record guards; an engine statement writes its own history',
		sql: AUDIT_FUNCTIONS
	},
	{
		name: 'bolt_minor_units',
		rank: 'function',
		functions: ['bolt_minor_units(c text)'],
		why: 'the money minor-unit CHECK helper (rule 68): SQL, not a record',
		sql: [MINOR_FN]
	},
	{
		name: 'bolt_assert',
		rank: 'function',
		functions: ['bolt_assert(ok boolean, code text, detail text)'],
		why: "the one write statement's guard (rule 20): raises BA001 inside the WITH chain",
		sql: [
			`create or replace function bolt_assert(ok boolean, code text, detail text) returns boolean language plpgsql as $$
	begin
		if not coalesce(ok, false) then raise exception using errcode = 'BA001', message = code || coalesce(' ' || detail, ''); end if;
		return true;
	end $$`
		]
	},
	{
		name: 'bolt_schema',
		rank: 'table',
		why: "the plan's own state (rule 69): the applied slice and its fingerprint, one row",
		sql: [
			'create table if not exists bolt_schema (one bool primary key default true check (one), fingerprint text not null, slice jsonb not null, applied_at timestamptz not null default now())'
		]
	},
	{
		name: 'bolt_history',
		source: true,
		rank: 'table',
		why: "every model's row history (rule 17), keyed by model and record: a log over all models, not one; a per-record restore is a `restored` revision naming its source in `restored_from`",
		sql: [
			`create table if not exists bolt_history (collection text not null, record uuid not null, revision int not null, at timestamptz not null default now(), actor text, op text not null check (op in ('create', 'update', 'delete')), cause text not null check (cause in ('direct', 'cascade', 'derived', 'seed', 'erased', 'restored')), changes jsonb not null default '{}', restored_from int check ((cause = 'restored') = (restored_from is not null)), request uuid, operation text, meta jsonb not null default '{}'::jsonb)`,
			'create index if not exists bolt_history__operation on bolt_history(operation) where operation is not null',
			'create index if not exists bolt_history__record on bolt_history (collection, record, revision)'
		]
	},
	{
		name: 'bolt_history_schemas',
		rank: 'table',
		source: true,
		tables: ['bolt_history_schema', 'bolt_history_current'],
		why: 'Immutable schema definitions and field identities let old revisions survive schema changes.',
		sql: HISTORY_SCHEMA_TABLES
	},
	{
		name: 'bolt_audit_receipt',
		rank: 'table',
		why: 'Small commit correlation for the host-owned durable audit intent; payloads remain in the separate audit store.',
		sql: [
			'create table if not exists bolt_audit_receipt (operation text primary key, at timestamptz not null, outcome_key text, digest text, run text, approval uuid, acknowledged_at timestamptz, expires_at timestamptz not null, expired_at timestamptz, constraint bolt_audit_receipt__expiry_finite check (isfinite(expires_at) and (expired_at is null or isfinite(expired_at))))',
			'create index if not exists bolt_audit_receipt__at on bolt_audit_receipt(at)',
			'create index if not exists bolt_audit_receipt__pending on bolt_audit_receipt(operation) where acknowledged_at is null',
			'create index if not exists bolt_audit_receipt__pending_outcome on bolt_audit_receipt(outcome_key) where acknowledged_at is null'
		]
	},
	{
		name: 'bolt_audit_erase',
		rank: 'table',
		why: 'Deferred history erasure retains only operation, record, revision and field names until external audit acknowledgement; never row payloads.',
		sql: [
			`create table if not exists bolt_audit_erase (operation text not null references bolt_audit_receipt(operation) on delete restrict deferrable initially deferred, collection text not null, record uuid not null, revision int not null, mode text not null check (mode in ('remove','anonymise')), purge text[] not null default '{}', keep_marker boolean not null, primary key(operation,collection,record,mode))`,
			'create index if not exists bolt_audit_erase__record on bolt_audit_erase(collection,record)'
		]
	},
	{
		name: 'bolt_seq',
		rank: 'table',
		why: '`seq` counters per model, field and scope: a composite key, no id',
		sql: [
			'create table if not exists bolt_seq (model text not null, field text not null, scope text not null, value int not null, primary key (model, field, scope))'
		]
	},
	{
		name: 'bolt_idem',
		rank: 'table',
		tables: ['bolt_idem', 'bolt_idem_outcome'],
		why: "the idempotency gate (rules 20, 31, 55): request keys and each one's recorded outcome",
		sql: [
			'create table if not exists bolt_idem (key text primary key, digest text not null, issued_at timestamptz not null, run text)',
			'create index if not exists bolt_idem_run on bolt_idem (run) where run is not null',
			'create table if not exists bolt_idem_outcome (key text primary key references bolt_idem(key) on delete cascade, outcome jsonb not null)'
		]
	},
	{
		name: 'bolt_rate',
		rank: 'table',
		why: 'rate-limit windows (rule 38): a composite key, counted in the write statement',
		sql: [
			'create table if not exists bolt_rate (rule text not null, bucket text not null, window_start timestamptz not null, n int not null, primary key (rule, bucket, window_start))'
		]
	},
	{
		name: 'bolt_push_subscriptions',
		rank: 'table',
		why: "a device's push endpoint and keys (a browser's web push, an iOS app's APNs token): device credentials no reader may see",
		sql: [
			`create table if not exists bolt_push_subscriptions (id text primary key, "user" text not null references sys_user(id) on delete cascade, endpoint text not null, keys jsonb not null, kind text not null default 'web' check (kind in ('web', 'apns')))`
		]
	},
	{
		name: 'bolt_host_nonce',
		rank: 'table',
		why: 'host-operation replay nonces (§5.11.6): a pruned key set',
		sql: [
			'create table if not exists bolt_host_nonce (key text primary key, at timestamptz not null)'
		]
	},
	{
		name: 'bolt_credential',
		rank: 'table',
		why: "an instance's sealed credentials (provider choice, secret, tokens, driver state, keys): host-only, never readable",
		sql: [
			'create table if not exists bolt_credential (instance text not null references sys_integration (id) on delete cascade, name text not null, sealed text not null, primary key (instance, name))'
		]
	},
	{
		name: 'bolt_approvals',
		source: true,
		tables: ['bolt_approvals', 'bolt_approval_effect'],
		rank: 'table',
		why: 'the approval state machine, held-record checkpoints and frozen pending effects; approval_request is its readable face',
		sql: [
			`create table if not exists bolt_approvals (id uuid primary key, state text not null check (state in ('Pending', 'ChangesRequested', 'Approved', 'Rejected', 'Superseded')), step int not null, collection text not null, record text not null, action text not null, requestor text not null, requestor_user text, route jsonb not null, records jsonb not null, log jsonb not null default '[]', at timestamptz not null, closed_at timestamptz, seq bigint generated always as identity)`,
			`create index if not exists bolt_approvals__open on bolt_approvals (state) where state in ('Pending', 'ChangesRequested')`,
			`create table if not exists bolt_approval_effect (
			request uuid not null references bolt_approvals(id) on delete cascade,
			operation text not null, automation text not null, input jsonb not null,
			due_at timestamptz not null, actor text not null, starter jsonb not null, depth int not null,
			state text not null check (state in ('queued','failed')), error jsonb, finished_at timestamptz,
			primary key (request, operation, automation))`
		]
	}
];

let objects: readonly SchemaObject[] | undefined;
/** Every private object as a never-dropped schema object `engine:<name>`. Lazy: the areas named above import the schema area. */
export function engineObjects(): readonly SchemaObject[] {
	objects ??= REGISTRY().map((o) => ({
		id: `engine:${o.name}`,
		rank: o.rank,
		table: '',
		deps: [],
		create: o.sql,
		drop: null
	}));
	return objects;
}

/** Definitions emitted into source-native migration files, not host-only objects that their proof may omit. */
export function source_objects(): readonly SchemaObject[] {
	const names = new Set(
		REGISTRY()
			.filter((object) => object.source === true)
			.map((object) => `engine:${object.name}`)
	);
	return engineObjects().filter((object) => names.has(object.id));
}

/** Every `(kind, owner)` pair `engineOwns` covers, whatever the inspected database holds at the time. */
export function engineOwned(sourceNative = false): readonly (readonly [string, string])[] {
	const pairs: [string, string][] = [];
	const registry = REGISTRY().filter((object) => !sourceNative || object.source !== true);
	for (const object of registry)
		if (object.rank === 'table')
			for (const owner of object.tables ?? [object.name])
				for (const kind of ['table', 'column', 'constraint', 'index', 'sequence'])
					pairs.push([kind, owner]);
		else for (const fn of object.functions ?? [`${object.name}()`]) pairs.push(['function', fn]);
	return pairs;
}

/** The only host-owned definitions omitted from source migration proofs. Unknown objects always remain drift. */
export function engineOwns(kind: string, owner: string, sourceNative = false): boolean {
	return REGISTRY()
		.filter((object) => !sourceNative || object.source !== true)
		.some((object) =>
			object.rank === 'table'
				? ['table', 'column', 'constraint', 'index', 'sequence'].includes(kind) &&
					(object.tables ?? [object.name]).includes(owner)
				: kind === 'function' && (object.functions ?? [`${object.name}()`]).includes(owner)
		);
}
