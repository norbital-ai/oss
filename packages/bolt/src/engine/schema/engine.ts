// The engine's private objects (X-18): bookkeeping no author position, catalogue entry or page names, so none of it is
// a model. Every table the engine reads as a record is a system model (`src/system/**`), planned like a workspace's.
// This is the ONE registry of the rest, each with why it is not a model. Idempotent (`if not exists`, `or replace`),
// re-asserted on every apply (`applyPlan`) and never dropped; a private table may reference a system table, so they
// render after the models (`schemaObjects`).
import { NOTIFY } from '../conversations/store.ts';
import { NOTICE_PUSH } from '../runs/push.ts';
import { MINOR_FN, type SchemaObject } from '@norbital-ai/store';
import { AUDIT_FUNCTIONS } from './audit.ts';

type Private = {
	name: string;
	rank: SchemaObject['rank'];
	why: string;
	sql: readonly string[];
	tables?: readonly string[];
	functions?: readonly string[];
	/** Native source migrations carry these definitions and must prove them independently of the host registry. */
	source?: true;
};

/** A statement-level trigger on inserted notices that queues one platform run (rules 47, 48). */
const noticeTrigger = (
	name: string,
	automation: string,
	inbox: '=' | '<>',
	extra = ''
): Private => ({
	name,
	rank: 'index',
	why: 'a trigger, so every writer of sys_notification queues its delivery run in the same statement; the model language has no triggers',
	sql: [
		`create or replace function ${name}() returns trigger language plpgsql as $$
	begin
		insert into sys_run (id, automation, input, due_at, cause, depth)
		select gen_random_uuid()::text, '${automation}', jsonb_build_object('ids', jsonb_agg(f.id)), min(f.at), 'schedule', 0
		from fresh f where coalesce(f.recipient->>'channel', 'inbox') ${inbox} 'inbox'${extra} having count(*) > 0;
		return null;
	end $$`,
		`drop trigger if exists ${name} on sys_notification`,
		`create trigger ${name} after insert on sys_notification referencing new table as fresh for each statement execute function ${name}()`
	]
});

const REGISTRY = (): readonly Private[] => [
	{
		name: 'bolt_audit',
		source: true,
		rank: 'function',
		functions: [
			'bolt_write_context()',
			'store_anonymise_fields(table_name text, record_id text)',
			'bolt_audit_mark()',
			'bolt_audit()'
		],
		why: 'native row history and raw held-record guards include database FK effects; captures stay in the native operation',
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
			`create table if not exists bolt_history (collection text not null, record uuid not null, revision int not null, at timestamptz not null default now(), actor text, op text not null check (op in ('create', 'update', 'delete')), cause text not null check (cause in ('direct', 'cascade', 'derived', 'seed', 'erased', 'restored')), changes jsonb not null default '{}', restored_from int check ((cause = 'restored') = (restored_from is not null)), request uuid, operation text)`,
			'alter table bolt_history add column if not exists operation text',
			"alter table bolt_history add column if not exists meta jsonb not null default '{}'::jsonb",
			'create index if not exists bolt_history__operation on bolt_history(operation) where operation is not null',
			'create index if not exists bolt_history__record on bolt_history (collection, record, revision)'
		]
	},
	{
		name: 'bolt_audit_receipt',
		rank: 'table',
		why: 'Small commit correlation for the host-owned durable audit intent; payloads remain in the separate audit store.',
		sql: [
			'create table if not exists bolt_audit_receipt (operation text primary key, at timestamptz not null, outcome_key text, digest text, run text, approval uuid)',
			'alter table bolt_audit_receipt add column if not exists acknowledged_at timestamptz',
			'alter table bolt_audit_receipt add column if not exists expires_at timestamptz',
			'alter table bolt_audit_receipt add column if not exists expired_at timestamptz',
			`do $$ begin
				if not exists(select 1 from pg_constraint where conrelid='bolt_audit_receipt'::regclass and conname='bolt_audit_receipt__expiry_finite') then
					alter table bolt_audit_receipt add constraint bolt_audit_receipt__expiry_finite check (
						(expires_at is null or isfinite(expires_at)) and (expired_at is null or isfinite(expired_at))) not valid;
				end if;
			end $$`,
			'create index if not exists bolt_audit_receipt__at on bolt_audit_receipt(at)',
			'create index if not exists bolt_audit_receipt__pending on bolt_audit_receipt(operation) where acknowledged_at is null',
			'create index if not exists bolt_audit_receipt__pending_outcome on bolt_audit_receipt(outcome_key) where acknowledged_at is null'
		]
	},
	{
		name: 'bolt_audit_retention',
		rank: 'table',
		why: 'One native upgrade deadline gives legacy audit receipts a finite grace period without rewriting them.',
		sql: [
			'create table if not exists bolt_audit_retention (one boolean primary key check (one), expires_at timestamptz not null check (isfinite(expires_at)))',
			"insert into bolt_audit_retention(one,expires_at) values(true,clock_timestamp()+interval '30 days') on conflict(one) do nothing"
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
			'create table if not exists bolt_push_subscriptions (id text primary key, "user" text not null references sys_user(id) on delete cascade, endpoint text not null, keys jsonb not null)',
			"alter table bolt_push_subscriptions add column if not exists kind text not null default 'web' check (kind in ('web', 'apns'))"
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
		rank: 'table',
		why: 'the approval state machine row (X-18, rules 44–46, machine.ts): state, step, snapshotted route, the checkpoint of every record the provisional change touched, and the log of every interaction; approval_request is its readable face',
		sql: [
			`create table if not exists bolt_approvals (id uuid primary key, state text not null check (state in ('Pending', 'ChangesRequested', 'Approved', 'Rejected', 'Superseded')), step int not null, collection text not null, record text not null, action text not null, requestor text not null, requestor_user text, route jsonb not null, records jsonb not null, log jsonb not null default '[]', at timestamptz not null, closed_at timestamptz, seq bigint generated always as identity)`,
			`create index if not exists bolt_approvals__open on bolt_approvals (state) where state in ('Pending', 'ChangesRequested')`
		]
	},
	{
		name: 'bolt_run_admitted',
		rank: 'table',
		why: 'retired first-admission marker: a pack load queues its `start` runs; kept so existing databases plan unchanged',
		sql: ['create table if not exists bolt_run_admitted (at timestamptz not null)']
	},
	noticeTrigger('bolt_notice_deliver', NOTIFY, '<>', ' and f.member is null'),
	noticeTrigger(
		'bolt_notice_push',
		NOTICE_PUSH,
		'=',
		' and exists (select 1 from bolt_push_subscriptions)'
	)
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
export function sourceObjects(): readonly SchemaObject[] {
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
		else if (object.rank === 'index')
			for (const fn of object.functions ?? [`${object.name}()`]) pairs.push(['function', fn]);
		else for (const fn of object.functions ?? [`${object.name}()`]) pairs.push(['function', fn]);
	for (const object of registry)
		if (object.rank === 'index') pairs.push(['trigger', `sys_notification.${object.name}`]);
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
				: (kind === 'function' && (object.functions ?? [`${object.name}()`]).includes(owner)) ||
					(kind === 'trigger' &&
						object.rank === 'index' &&
						owner === `sys_notification.${object.name}`)
		);
}
