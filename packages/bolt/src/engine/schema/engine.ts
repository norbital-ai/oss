// The engine's private objects (X-18): bookkeeping no author position, catalogue entry or page names, so none of it is
// a model. Every table the engine reads as a record is a system model (`src/system/**`), planned like a workspace's.
// This is the ONE registry of the rest, each with why it is not a model. Idempotent (`if not exists`, `or replace`),
// re-asserted on every apply (`applyPlan`) and never dropped; a private table may reference a system table, so they
// render after the models (`schemaObjects`).
import { NOTIFY } from '../conversations/store.ts';
import { NOTICE_PUSH } from '../runs/push.ts';
import type { SchemaObject } from './ddl.ts';
import { MINOR_FN } from './ddl.ts';

type Private = { name: string; rank: SchemaObject['rank']; why: string; sql: readonly string[] };

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
		name: 'bolt_minor_units',
		rank: 'function',
		why: 'the money minor-unit CHECK helper (rule 68): SQL, not a record',
		sql: [MINOR_FN]
	},
	{
		name: 'bolt_assert',
		rank: 'function',
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
		rank: 'table',
		why: "every collection's row history (rule 17), keyed by collection and record: a log over all models, not one; a per-record restore is a `restored` revision naming its source in `restored_from`",
		sql: [
			`create table if not exists bolt_history (collection text not null, record uuid not null, revision int not null, at timestamptz not null default now(), actor text, op text not null check (op in ('create', 'update', 'delete')), cause text not null check (cause in ('direct', 'cascade', 'derived', 'seed', 'erased', 'restored')), changes jsonb not null default '{}', restored_from int check ((cause = 'restored') = (restored_from is not null)), request uuid)`,
			'create index if not exists bolt_history__record on bolt_history (collection, record, revision)'
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
		name: 'bolt_feed',
		rank: 'table',
		why: "a feed's progress per instance and partition (cursor, snapshot cycle and phase, health, literal digest, CAS version): a composite key",
		sql: [
			`create table if not exists bolt_feed (feed text not null, instance text not null references sys_integration (id) on delete cascade, partition text not null default '', cursor jsonb, cycle int not null default 0, phase text not null default 'read' check (phase in ('read', 'reconcile')), health jsonb, digest text not null, version int not null default 0, primary key (feed, instance, partition))`
		]
	},
	{
		name: 'bolt_feed_row',
		rank: 'table',
		why: 'the record each remote key of a feed wrote, and the snapshot cycle that last saw it: deletes by key, reconcile and drain',
		sql: [
			`create table if not exists bolt_feed_row (feed text not null, instance text not null, partition text not null default '', key text not null, record text not null, cycle int not null, primary key (feed, instance, partition, key), foreign key (feed, instance, partition) references bolt_feed (feed, instance, partition) on delete cascade)`,
			'create index if not exists bolt_feed_row_cycle on bolt_feed_row (feed, instance, partition, cycle)'
		]
	},
	{
		name: 'bolt_approvals',
		rank: 'table',
		why: 'the approval state machine row (X-18, rules 44–46, machine.ts): state, step, snapshotted route, the checkpoint of every record the provisional change touched, and the log of every interaction; approval_request is its readable face',
		sql: [
			`create table if not exists bolt_approvals (id uuid primary key, state text not null check (state in ('Pending', 'ChangesRequested', 'Approved', 'Rejected', 'Withdrawn', 'Superseded')), step int not null, collection text not null, record text not null, action text not null, requestor text not null, requestor_user text, route jsonb not null, records jsonb not null, log jsonb not null default '[]', at timestamptz not null, closed_at timestamptz, seq bigint generated always as identity)`,
			`create index if not exists bolt_approvals__open on bolt_approvals (state) where state in ('Pending', 'ChangesRequested')`
		]
	},
	{
		name: 'bolt_run_admitted',
		rank: 'table',
		why: 'the first-admission marker (rule 70): one timestamp row, no key',
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
