import { collectionSearchTrigramIndexName } from '@norbital-ai/std/collection';
import type { ModelExclusion } from '../authoring/models-schema.js';
import { searchableColumns } from '../authoring/model-introspection.js';
import type {
	CollectionDefinition,
	FieldDefinition,
	WorkspaceDefinition
} from '../authoring/workspace-schema.js';
import {
	IDENTITY_COLLECTIONS,
	SYSTEM_COLLECTION_NAMES,
	withSystemCollections
} from '../runtime/schema/system-collections.js';

export type SchemaStep = Readonly<{
	readonly id: string;
	readonly sql: string;
}>;

export type SchemaPlan = Readonly<{
	readonly fingerprint: string;
	readonly steps: ReadonlyArray<SchemaStep>;
}>;

/** Quotes a PostgreSQL identifier. Shared so plan DDL and migration DDL cannot quote differently. */
export const quoteIdentifier = (identifier: string): string =>
	`"${identifier.replaceAll('"', '""')}"`;

/**
 * The tables the plan's steps create, read back out of the DDL this module rendered.
 *
 * It lives here rather than in `verify` because this module is the only writer of that DDL: every
 * table step below is `create table if not exists <name>`, bare for the `bolt_*` tables and quoted
 * for collections, so reading the name back is reading this module's own output rather than parsing
 * arbitrary SQL. Steps that create extensions, functions or indexes match nothing and are skipped.
 *
 * `verify` needs this because it only ever compared authored collections. A `bolt_*` table the plan
 * declares could therefore be missing while `migrate` still reported success — which is exactly how
 * `agents.*` answered `relation "bolt_conversations" does not exist` against a database whose
 * migration had just answered `migrated: true`. A plan step that did not take effect is a failed
 * migration, and nothing was asking.
 */
export const planTableNames = (plan: SchemaPlan): ReadonlyArray<string> => {
	const pattern = /create table if not exists\s+(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))/giu;
	return [
		...new Set(
			plan.steps.flatMap((step) =>
				[...step.sql.matchAll(pattern)].flatMap((match) => {
					const quoted = match[1];
					const bare = match[2];
					if (quoted !== undefined) return [quoted.replaceAll('""', '"')];
					return bare === undefined ? [] : [bare];
				})
			)
		)
	].toSorted((left, right) => left.localeCompare(right));
};

/** Owns PostgreSQL type mapping, identifier quoting, and deterministic plan fingerprints. */
const SchemaPlanValues = {
	/**
	 * The SQL type a column is created as: what its builder declares, or the scalar mapping below
	 * when the field was hand-written rather than recovered from one.
	 *
	 * The mapping is a fallback and not the answer, because a scalar is a lossy summary of a column.
	 * `number` covers `integer`, `numeric` and `double precision`, and rendering all three as
	 * `double precision` put payroll money into binary floating point while the migration lineage
	 * created the same column `numeric` from the same declaration. It survived because `verify`
	 * compares column *names*, and both sides did have a column called `amount`.
	 *
	 * The fallback still serves the runtime-owned collections in `system-collections.ts` and every
	 * definition assembled in tests, which are `field.*` calls with no builder behind them.
	 */
	columnType: (field: FieldDefinition): string =>
		field.sqlType ?? SchemaPlanValues.sqlType(field.type),
	sqlType: (type: string): string => {
		switch (type) {
			// The same type `norbital_id` is, because that is what these columns reference. Planning a
			// foreign key as `text` left the plan unable to render the join its own where compiler
			// emits, so every relation filter against a Bolt-provisioned database failed on
			// `operator does not exist: text = uuid`.
			case 'uuid':
				return 'uuid';
			case 'number':
				return 'double precision';
			case 'boolean':
				return 'boolean';
			case 'datetime':
				return 'timestamptz';
			case 'json':
				return 'jsonb';
			default:
				return 'text';
		}
	},
	quoteIdentifier,
	fingerprint: (steps: ReadonlyArray<SchemaStep>): string => {
		const source = JSON.stringify(steps);
		let hash = 2_166_136_261;
		for (let index = 0; index < source.length; index += 1) {
			hash ^= source.charCodeAt(index);
			hash = Math.imul(hash, 16_777_619);
		}
		return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
	}
};

/**
 * The columns the platform owns on every collection row, exactly as the migration lineage defines
 * them.
 *
 * Bolt previously invented its own shape — `id text primary key` with `norbital_id` generated from
 * it, and no `norbital_sys_period` at all. That made a Bolt-provisioned database structurally
 * incompatible with every existing one: `collections.ts` inserts into `id`, a column deployed tables
 * do not have, so the runtime could not write to a real workspace. Nothing caught it, because local
 * development provisions from this very plan — Bolt only ever met the schema it invented.
 *
 * The lineage wins because it is what deployed workspaces already hold, and rebasing them onto a new
 * shape would mean restructuring live payroll data.
 */
const SYSTEM_COLUMN_DEFINITIONS = {
	norbital_id: 'uuid primary key default gen_random_uuid()',
	norbital_created_at: 'timestamptz default now()',
	norbital_updated_at: 'timestamptz default now()',
	// Half-open, so the current row's period is open-ended and successive versions abut without
	// overlapping — the same `[)` convention `norbital_daterange` uses for authored ranges.
	norbital_sys_period: "tstzrange not null default tstzrange(current_timestamp, null, '[)')",
	norbital_row_version: 'integer default 1',
	norbital_approval_id: 'uuid'
} as const;

/**
 * The names alone, for the callers that police the columns rather than create them.
 *
 * Keyed off the DDL above rather than restated, because a guard that names five of six columns
 * fails open on the sixth and nothing says so — the guard stays green while the rule it enforces
 * has a hole in it.
 */
export const SYSTEM_COLUMN_NAMES: ReadonlyArray<string> = Object.keys(SYSTEM_COLUMN_DEFINITIONS);

/**
 * The same names as a type, for `SystemRow` — the shape authored code sees on every row.
 *
 * `SystemRow` used to restate the list and named five of the six, so authored row types denied that
 * `norbital_sys_period` exists at all while every table has it. Keying the type off this map instead
 * means the row type cannot fall behind the DDL: adding a seventh column here is a compile error
 * until its value type is declared, rather than a column the authoring surface silently omits.
 */
export type SystemColumnName = keyof typeof SYSTEM_COLUMN_DEFINITIONS;

const SYSTEM_COLUMNS = Object.entries(SYSTEM_COLUMN_DEFINITIONS)
	.map(([name, definition]) => `${name} ${definition}`)
	.join(', ');

/**
 * Dollar-quote tag for the guarded EXCLUDE blocks. Nothing interpolated into one may contain it, or
 * the block would terminate early and the rest of the constraint would be parsed as statements.
 */
const EXCLUSION_TAG = '$bolt_exclusion$';

/** Identifiers Bolt is willing to inline into generated DDL unquoted, inside a dollar-quoted body. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The name of the index a column authored `indexed: true` is served by.
 *
 * Exported because the migration generator creates the same index as a Drizzle entity and has to
 * name it identically: a workspace that got the index from its lineage must meet a
 * `create index if not exists` that is already satisfied, rather than a second index over the same
 * column under a different name. This is the same arrangement `collectionSearchTrigramIndexName`
 * gives the trigram indexes, kept here because the declared index is Bolt's own naming and nothing
 * outside the compiler needs to say it.
 */
export const collectionIndexName = (collectionName: string, columnName: string): string =>
	`${collectionName}_${columnName}_idx`;

/**
 * A collection's declared index steps, one per column authored `indexed: true`.
 *
 * `FieldDefinition.indexed` was read by nothing that emits DDL, so `field.string({ indexed: true })`
 * was accepted and dropped — including on Bolt's own `approval_request` and `requestor`, whose
 * `collection_name`, `record_id` and `status` lookups ran as sequential scans over every approval
 * the workspace had ever raised.
 *
 * `if not exists` rather than a bare `create index` because the plan runs in full on every provision
 * and the migration lineage creates the same index under the same name; whichever runs first
 * satisfies the other, and a second run is a no-op instead of a duplicate-name failure.
 */
const declaredIndexSteps = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): ReadonlyArray<SchemaStep> =>
	Object.entries(collection.fields)
		.filter(([, field]) => field.indexed)
		.map(([column, field]) => ({ column, unique: field.unique === true }))
		.toSorted((left, right) => left.column.localeCompare(right.column))
		.map(({ column, unique }) => ({
			// Sorts after `collection:<name>` (its table), so the column exists by the time this runs.
			id: `collection:${collection.name}:index:${column}`,
			sql: `create ${unique ? 'unique ' : ''}index if not exists ${quoteIdentifier(collectionIndexName(collection.name, column))} on ${quoteIdentifier(collection.name)} (${quoteIdentifier(column)})`
		}));

/**
 * A collection's trigram index steps, one per column the author opted into free-text search.
 *
 * Free-text search compiles to `ilike '%term%'`, which no btree index can answer, so every search was
 * a sequential scan over the whole collection. `gin_trgm_ops` indexes character trigrams rather than
 * words, so one index serves substring search in any script without a dictionary or a tokenizer.
 *
 * The name comes from `@norbital-ai/std/collection` rather than being formatted here: the migration
 * generator creates the same index as a Drizzle entity under that same name, so a workspace that got
 * the index from its lineage meets a `create index if not exists` that is already satisfied instead of
 * a second index over the same column.
 */
const searchIndexSteps = (
	collection: CollectionDefinition<Readonly<Record<string, FieldDefinition>>>
): ReadonlyArray<SchemaStep> =>
	searchableColumns(collection.fields).map((column) => ({
		// Sorts after `collection:<name>` (its table) and after every `bolt:` id, so `pg_trgm` is
		// installed and the column exists by the time this runs.
		id: `collection:${collection.name}:search:${column}`,
		sql: `create index if not exists ${quoteIdentifier(collectionSearchTrigramIndexName(collection.name, column))} on ${quoteIdentifier(collection.name)} using gin (${quoteIdentifier(column)} gin_trgm_ops)`
	}));

/**
 * One authored EXCLUDE constraint, guarded so re-running the plan is a no-op.
 *
 * Postgres has no `add constraint if not exists`, and the plan runs in full inside one transaction on
 * every provision — so a drop/add pair would rebuild and revalidate a GiST index over the whole table,
 * holding an ACCESS EXCLUSIVE lock, every single time. The guard reads `pg_constraint` instead.
 *
 * `gist` is not a choice: these mix equality members with range `&&`, which only gist can index, and
 * only with `btree_gist` installed for the equality halves — hence the `bolt:extension-btree-gist`
 * step this sorts after.
 */
const exclusionStep = (collectionName: string, exclusion: ModelExclusion): SchemaStep => {
	// Both are inlined as string literals inside the guard's `pg_constraint` lookup, where quoting an
	// identifier would make it a column reference rather than a name.
	if (!SAFE_IDENTIFIER.test(collectionName)) {
		throw new TypeError(
			`Collection "${collectionName}" declares an exclusion but is not a lower_snake_case identifier.`
		);
	}
	if (!SAFE_IDENTIFIER.test(exclusion.name)) {
		throw new TypeError(
			`Exclusion constraint name "${exclusion.name}" must be a lower_snake_case identifier.`
		);
	}
	if (exclusion.elements.length === 0) {
		throw new TypeError(`Exclusion ${exclusion.name} must declare at least one element.`);
	}
	const elements = exclusion.elements.map(({ expr, with: operator }) => {
		if (expr.includes(EXCLUSION_TAG) || operator.includes(EXCLUSION_TAG)) {
			throw new TypeError(`Exclusion ${exclusion.name} may not contain "${EXCLUSION_TAG}".`);
		}
		return `${expr} with ${operator}`;
	});
	return {
		id: `collection:${collectionName}:exclusion:${exclusion.name}`,
		sql: `do ${EXCLUSION_TAG} begin if not exists (select 1 from pg_constraint where conname = '${exclusion.name}' and conrelid = '${collectionName}'::regclass) then alter table ${quoteIdentifier(collectionName)} add constraint ${quoteIdentifier(exclusion.name)} exclude using gist (${elements.join(', ')}); end if; end ${EXCLUSION_TAG}`
	};
};

/** Owns build schema plan behavior at the compiler boundary so validation and typed semantics stay consistent for every caller. */
export const buildSchemaPlan = (authored: WorkspaceDefinition): SchemaPlan => {
	// Runtime-owned collections are planned exactly like authored ones: authored queries read them,
	// so they need the same row columns rather than a private hand-written table shape.
	const workspace = withSystemCollections(authored);
	// Step ids are sorted, and every `bolt:` id sorts before every `collection:` id, so these
	// projections exist before the generated columns that call them are created.
	const foundation: ReadonlyArray<SchemaStep> = [
		// `bolt:extension-*` sorts before every function, table and index that needs one.
		//
		// These were absent entirely, which cost more than it looked: `ilike '%term%'` is unanswerable
		// by btree, so free-text search scanned every row, and the effective-dating EXCLUDE constraints
		// could not be created — leaving the database willing to hold overlapping temporal rows the
		// application assumes are impossible.
		//
		// No `pgcrypto`: `gen_random_uuid()`, the default on every primary key, has been core since
		// Postgres 13. Requesting the extension only fails on a build that does not ship it.
		{ id: 'bolt:extension-btree-gist', sql: 'create extension if not exists btree_gist' },
		{ id: 'bolt:extension-pg-trgm', sql: 'create extension if not exists pg_trgm' },
		// `vector`, for the embedding columns two templates declare. Unconditional, like the two above:
		// the plan runs before the lineage that creates the columns, so deciding from the declarations
		// would mean deciding from a workspace this step cannot see — and a tenant provisioned before a
		// template gained its first embedding column would have no step to add it later. A workspace
		// that never embeds anything pays for an unused extension; one that does, without this, fails
		// its very first migration on `type "vector" does not exist`.
		{ id: 'bolt:extension-vector', sql: 'create extension if not exists vector' },
		{
			// A STORED generated column refuses a STABLE expression, and `text::date` is only STABLE
			// because it reads DateStyle. Authored values are canonical ISO dates, whose parse does not,
			// so this wrapper is honestly immutable. Empty or absent projects NULL, which is what a
			// union arm that does not carry the field needs.
			id: 'bolt:function-date',
			sql: "create or replace function norbital_date(value text) returns date language sql immutable parallel safe as $norbital_date$ select nullif(value, '')::date $norbital_date$"
		},
		{
			// Half-open [start, end): adjacent periods touch without overlapping, and a missing bound
			// is unbounded.
			id: 'bolt:function-daterange',
			sql: "create or replace function norbital_daterange(payload jsonb) returns daterange language sql immutable parallel safe as $norbital_daterange$ select daterange(nullif(payload->>'start', '')::date, nullif(payload->>'end', '')::date, '[)') $norbital_daterange$"
		},
		{
			id: 'bolt:approvals',
			sql: 'create table if not exists bolt_approvals (request_id text primary key, tenant_id text not null, state jsonb not null, created_at timestamptz not null default now())'
		},
		{
			id: 'bolt:automation-runs',
			sql: 'create table if not exists bolt_automation_runs (effect_id text primary key, automation_name text not null, task_id text, state text not null, input jsonb not null, created_at timestamptz not null default now())'
		},
		{
			id: 'bolt:audit',
			sql: 'create table if not exists bolt_audit (sequence bigint generated always as identity primary key, kind text not null, subject_id text not null, payload jsonb not null, created_at timestamptz not null default now())'
		},
		// The two tables `channels.ts` reads and writes. They were absent from this plan entirely and
		// no DDL for either existed anywhere in the repo, so `channels.status` — the only reader —
		// failed on a missing relation the moment any workspace declared a channel. It stayed
		// invisible because the one template exercised end to end, `hr-payroll`, declares none.
		//
		// Columns are exactly the ones `register`, `receive`, `reply` and `status` name, and nothing
		// else. In particular there is deliberately no `tenant_id`: every statement in `channels.ts` is
		// tenant-blind, so a `not null` tenant column would fail every insert rather than scope
		// anything. That is a real multi-tenancy gap, but it is a gap in the runtime's statements —
		// inventing the column here would only hide it behind a table that no longer matches its only
		// caller.
		//
		// `channel_name` is the primary key rather than a plain column because `register` relies on
		// `on conflict do nothing` for idempotency: with no unique constraint that clause has nothing
		// to conflict against, so re-registering a channel would append a duplicate row forever.
		{
			id: 'bolt:channel-registrations',
			sql: 'create table if not exists bolt_channel_registrations (channel_name text primary key, created_at timestamptz not null default now())'
		},
		// An append-only ledger, so it takes the same identity primary key `bolt_audit` and
		// `bolt_collection_history` use: `receive` and `reply` only ever insert, and `status` aggregates
		// with `count(*) filter (...)`, so a receipt row is never addressed individually.
		{
			id: 'bolt:channel-receipts',
			sql: 'create table if not exists bolt_channel_receipts (sequence bigint generated always as identity primary key, channel_name text not null, conversation_id text not null, direction text not null, created_at timestamptz not null default now())'
		},
		// Who sent an inbound message, which is what `rateLimits.perSenderPerMinute` counts. A
		// conversation id cannot answer it: the host chooses one, and nothing makes it per-sender, so a
		// per-sender cap measured over conversations would throttle a busy thread and let a flood in
		// over fresh ones. Nullable, because an outbound receipt has no sender and a row written before
		// this column existed has no answer to give.
		{
			id: 'bolt:channel-receipts-sender',
			sql: 'alter table bolt_channel_receipts add column if not exists sender_id text'
		},
		// The window the limiter reads is always `(channel_name, direction, created_at)` over the last
		// minute, so a channel with a long ledger does not scan all of it to admit one message.
		{
			id: 'bolt:channel-receipts-window',
			sql: 'create index if not exists bolt_channel_receipts_window on bolt_channel_receipts (channel_name, direction, created_at desc)'
		},
		// The integrations tables, in the same condition the channels ones were: `integrations.ts` has
		// always read and written all three and the plan created none of them, so every command on the
		// service failed on a missing relation the moment anything called one. Nothing did, which is why
		// it went unnoticed — until `+integrations.ts` started reaching the runtime.
		//
		// `cursor` is a jsonb object keyed by binding name rather than a single value, because one
		// integration declares several receive bindings and they advance independently: a vendors feed
		// that stalls must not drag the customers feed back with it.
		//
		// `lease_until` is what makes a *scheduled* pull safe. A cron fires on its own clock, so a run
		// that outlives its interval and the next tick exist at the same time; both would read the same
		// cursor and the second would persist one computed from a window the first had already passed.
		// A run claims the row by writing a future `lease_until` and only proceeds if the claim took, so
		// the overlap becomes a skipped tick instead of a cursor that walks backwards. It is a timestamp
		// rather than a boolean so a run that dies without releasing costs one cycle, not the schedule.
		{
			id: 'bolt:integrations',
			sql: 'create table if not exists bolt_integrations (name text primary key, enabled boolean not null default true, cursor jsonb, lease_until timestamptz, updated_at timestamptz not null default now())'
		},
		// Separately, for a database provisioned before the column existed: `create table if not exists`
		// is a no-op against a table that is already there, so it can never add one.
		{
			id: 'bolt:integrations-lease',
			sql: 'alter table bolt_integrations add column if not exists lease_until timestamptz'
		},
		// `(integration_name, receipt_id)` is the key rather than a surrogate, because `receive` leans on
		// `on conflict do nothing` to make a re-delivered webhook a no-op — with nothing unique to
		// conflict against, the same delivery would append a row every time the sender retried.
		{
			id: 'bolt:integration-inbox',
			sql: 'create table if not exists bolt_integration_inbox (integration_name text not null, receipt_id text not null, payload jsonb not null, received_at timestamptz not null default now(), primary key (integration_name, receipt_id))'
		},
		// The ledger only became a ledger when something read it. It had one writer and no reader: a
		// delivery was inserted and nothing ever looked, so `on conflict do nothing` deduplicated rows
		// in a table whose rows decided nothing.
		//
		// `status` is what a webhook delivery now consults before it absorbs anything, and it has to be
		// three-valued rather than a boolean. `absorbed` is a delivery whose rows are down, and a
		// redelivery of it is skipped. `pending` is a delivery that was recorded and then did not
		// finish — the process died between the insert and the writes — and a redelivery of *that* must
		// be absorbed, not skipped, or a crash halfway through a batch becomes permanent loss. A boolean
		// cannot tell those apart from outside the transaction that was running.
		//
		// Added as separate statements because the `create table if not exists` above does nothing to a
		// database that already has the table, so a column appended to that string would exist only on
		// installations provisioned after this change — the same divergence between a plan-provisioned
		// and a lineage-provisioned database that the `numeric`/`uuid` faults came from.
		{
			id: 'bolt:integration-inbox-binding',
			sql: 'alter table bolt_integration_inbox add column if not exists binding_name text'
		},
		{
			id: 'bolt:integration-inbox-status',
			sql: "alter table bolt_integration_inbox add column if not exists status text not null default 'pending'"
		},
		{
			id: 'bolt:integration-inbox-processed',
			sql: 'alter table bolt_integration_inbox add column if not exists processed_at timestamptz'
		},
		// The outbound ledger, which is the inbox's mirror image and exists for the same reason: a
		// delivery nobody can find is a delivery that did not happen and nobody knows it.
		//
		// It is a queue and a record at once, and the columns divide along that line. `payload` and
		// `idempotency_key` are what gets sent — the payload is built at the moment of the event and
		// stored, so a row updated twice sends two bodies rather than the same current state twice, and
		// the key is derived from `sequence` so every retry of one delivery carries the identical key
		// for a receiver to collapse on. `status`, `attempts` and `next_attempt_at` are what decides
		// when: `pending` is due at `next_attempt_at`, `inflight` is claimed by a drain, `delivered` is
		// done, and `failed` is the dead letter. `last_status` and `last_error` are why, and they are
		// deliberately a status code and a short reason — never a body and never a header, because a
		// request header is where the credential is and a response body is where a partner's data is.
		//
		// `sequence` being an identity column is the ordering guarantee: deliveries for one record are
		// drained in the order the writes happened, because the drain only ever claims the lowest
		// pending sequence per record.
		{
			id: 'bolt:integration-outbox',
			sql: "create table if not exists bolt_integration_outbox (sequence bigint generated always as identity primary key, integration_name text not null, binding_name text not null, collection_name text not null, record_id text not null, operation text not null, path text, payload jsonb, status text not null default 'pending', attempts integer not null default 0, next_attempt_at timestamptz not null default now(), last_status integer, last_error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), delivered_at timestamptz)"
		},
		// The drain reads by status and due time and by nothing else, so that is the index. Without it
		// every tick of the outbox cron is a sequential scan of every delivery ever made.
		{
			id: 'bolt:integration-outbox-due',
			sql: 'create index if not exists bolt_integration_outbox_due on bolt_integration_outbox (integration_name, status, next_attempt_at)'
		},
		// And the per-record ordering read: the lowest pending sequence for each record.
		{
			id: 'bolt:integration-outbox-record',
			sql: 'create index if not exists bolt_integration_outbox_record on bolt_integration_outbox (collection_name, record_id, sequence)'
		},
		// The agent's own tables, which the plan did not create — so every `agents.*` command answered
		// `relation "bolt_conversations" does not exist` against a workspace provisioned from it. Their
		// only DDL lived in Colony's dev launcher, which is why local development worked and nothing
		// else did: the dev script created them out of band and the plan never learned to.
		{
			id: 'bolt:agent-conversations',
			sql: 'create table if not exists bolt_conversations (id text primary key, agent_name text not null, user_id text not null, title text, verifier jsonb)'
		},
		/**
		 * What a session delegated to, and what the whole tree beneath it has spent.
		 *
		 * `parent_id` is what makes the accounting depth-agnostic: a subagent session is a session, so
		 * its spend has to reach the conversation the person is actually looking at without the roll-up
		 * knowing how many levels lie between. Added as an `alter` rather than folded into the `create`
		 * above because `create table if not exists` is a no-op against every database that already has
		 * the table — the columns would exist only on workspaces provisioned after this line.
		 *
		 * The counters are cumulative and never recomputed from the transcript: they have to survive
		 * the messages that produced them being compacted away, which is the whole reason they are
		 * columns rather than a sum taken at read time. `usage_turns_unreported` counts the turns whose
		 * host reported no cost, so a total can say it is a floor instead of quietly reading as exact.
		 */
		{
			id: 'bolt:agent-conversations-usage',
			sql: 'alter table bolt_conversations add column if not exists parent_id text, add column if not exists usage_cost_usd double precision not null default 0, add column if not exists usage_cost_micro_units bigint not null default 0, add column if not exists usage_cost_currency text, add column if not exists usage_total_tokens bigint not null default 0, add column if not exists usage_turns_counted integer not null default 0, add column if not exists usage_turns_unreported integer not null default 0'
		},
		// The lineage walk `history` and the usage roll-up both make: children of one session.
		{
			id: 'bolt:agent-conversations-usage-parent',
			sql: 'create index if not exists bolt_conversations_parent on bolt_conversations (parent_id)'
		},
		// `sequence` is the read order — `history` and the panel projection both rely on it — and it is
		// an identity column because a turn appends rows without knowing how many precede it.
		{
			id: 'bolt:agent-messages',
			sql: 'create table if not exists bolt_agent_messages (sequence bigint generated always as identity primary key, conversation_id text not null, role text not null, content jsonb not null)'
		},
		/**
		 * Which turn a row belongs to.
		 *
		 * The panel groups a delegated session's rows under the call that started it, and a row alone
		 * cannot say which turn produced it — the join used to be guessed from ordering, which is why a
		 * subagent's messages interleaved into its parent by sequence and its task prompt rendered as
		 * something the person had typed.
		 */
		{
			id: 'bolt:agent-messages-turn',
			sql: 'alter table bolt_agent_messages add column if not exists turn_id text'
		},
		{
			id: 'bolt:collection-history',
			sql: 'create table if not exists bolt_collection_history (sequence bigint generated always as identity primary key, collection_name text not null, record_id text not null, operation text not null, subject_id text not null, snapshot jsonb, created_at timestamptz not null default now())'
		},
		{
			id: 'bolt:external-subjects',
			sql: 'create table if not exists bolt_external_subjects (provider text not null, external_id text not null, user_id text not null, tenant_id text not null, team_id uuid, email text, primary key (provider, external_id, tenant_id))'
		},
		{
			id: 'bolt:invitations',
			sql: 'create table if not exists bolt_invitations (invitation_id text primary key, tenant_id text not null, email text not null, invited_by text not null, accepted_by text, status text not null, created_at timestamptz not null default now())'
		},
		{
			id: 'bolt:notifications',
			sql: 'create table if not exists bolt_notifications (id text primary key, recipient text not null, payload jsonb not null, read boolean not null default false, delivered_at timestamptz, created_at timestamptz not null default now())'
		},
		/**
		 * What should happen, and when next — the whole of cron, as six columns.
		 *
		 * There is deliberately no `active` flag. Activation upserts the keys the release declares and
		 * deletes the ones it does not, so "not declared" and "not active" have no way to disagree.
		 */
		{
			id: 'bolt:schedule',
			sql: 'create table if not exists bolt_schedule (key text primary key, command text not null, crontab text not null, input jsonb not null, next_run_at timestamptz not null, last_fired_at timestamptz)'
		},
		{
			id: 'bolt:schedule-due',
			sql: 'create index if not exists bolt_schedule_due on bolt_schedule (next_run_at)'
		},
		{
			id: 'bolt:schema-state',
			sql: 'create table if not exists bolt_schema_state (fingerprint text not null, applied_at timestamptz not null default now())'
		},
		// The migration ledger: which lineage entries this database has been brought through.
		//
		// Named for the lineage format rather than for Bolt, because that is what it indexes — the
		// `<tag>/migration.sql` + `snapshot.json` entries this compiler generates through
		// `drizzle-kit/api-postgres`. It is the one table here without a `bolt_` prefix, which is a
		// real inconsistency and the reason to leave it alone: renaming it is a boot-path change that
		// buys a naming convention, and a database carrying the old table would meet an empty new one
		// and replay its whole lineage.
		//
		// `tag` carries the UNIQUE that makes exactly-once a database guarantee rather than a
		// read-then-write race between two hosts booting at the same time. It once also carried a
		// `sql_hash` column, which Bolt never wrote and only Pod's applier read.
		{
			id: 'bolt:schema-migrations',
			sql: 'create table if not exists __drizzle_migrations (id serial primary key, tag text not null unique, created_at timestamptz not null default now())'
		},
		// Identity's own tables, declared where identity declares them rather than restated here.
		// Bolt owns its schema; the plan only has to apply it.
		/**
		 * The sync log every replica reads.
		 *
		 * `xid` is `pg_current_xact_id()` widened to `bigint`, not `txid_current() % 2147483647`. The
		 * modulo wrapped: past 2.1 billion transactions the column restarts near zero, every stored
		 * cursor is permanently ahead of every new row, and sync stops with no error. `pg_current_xact_id`
		 * is the non-wrapping 64-bit counter, and `bigint` keeps the cursor an ordinary JSON number and
		 * the `(xid, sequence)` comparison an ordinary index range scan.
		 *
		 * Ordering by `(xid, sequence)` is insert order. Commit order is what a reader needs, and the two
		 * differ: a transaction that starts earlier and commits later carries a *lower* xid than rows a
		 * client has already read. `Sync.diff` closes that with a watermark rather than the schema — see
		 * the `pg_snapshot_xmin` horizon there — but the index below is what makes serving under a
		 * horizon cheap.
		 */
		/**
		 * One thing that should happen once — the other half of scheduled work, and the only queue.
		 *
		 * `run_at` does double duty, which is the simplification the whole design rests on: it says
		 * when a task is due, and taking a task pushes it into the future, which is what "hidden while
		 * it runs" means. So there is no lease column, no `locked_by`, and no `running` status — a task
		 * that was taken and never finished simply becomes due again when the hide expires, and crash
		 * recovery needs no reaper.
		 *
		 * `effect_id` carries the UNIQUE that makes it the one idempotency mechanism. An ordinary
		 * enqueue keys off the caller's `EffectId`; a cron occurrence keys off `schedule:<key>@<slot>`,
		 * so exactly-once cron falls out of the constraint rather than out of leader election — two
		 * hosts that both notice the 06:00 slot both insert, and the loser's insert is a no-op. It is a
		 * named constraint rather than an inline `unique` so the object has the same name here as in
		 * the Drizzle declaration the runner composes against.
		 */
		{
			id: 'bolt:task',
			sql: "create table if not exists bolt_task (id uuid primary key default gen_random_uuid(), command text not null, input jsonb not null, status text not null default 'pending', run_at timestamptz not null default now(), attempts integer not null default 0, max_attempts integer not null default 12, effect_id text not null constraint bolt_task_effect_id unique, result jsonb, error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now())"
		},
		/**
		 * The only read `take` makes, and the only one it should be able to make.
		 *
		 * Partial on purpose: a table that has drained a year of work is almost entirely `done` and
		 * `failed`, and a full index over `run_at` would have every tick walking that history to find
		 * the handful of rows that are actually pending.
		 */
		{
			id: 'bolt:task-due',
			sql: "create index if not exists bolt_task_due on bolt_task (run_at) where status = 'pending'"
		},
		{
			id: 'bolt:sync-outbox',
			sql: 'create table if not exists bolt_sync_outbox (xid bigint not null default (pg_current_xact_id()::text::bigint), sequence bigint generated always as identity, collection_name text not null, record_id text not null, operation text not null, record jsonb, created_at timestamptz not null default now(), primary key (xid, sequence))'
		},
		/**
		 * Widens an outbox created before the wraparound was found. `create table if not exists` above
		 * cannot change a column, so a database provisioned by an earlier plan keeps `integer` and the
		 * `pg_current_xact_id` default never fits. Guarded on the current type so it is a no-op on every
		 * run after the first.
		 */
		{
			id: 'bolt:sync-outbox-widen',
			sql: "do $$ begin if exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'bolt_sync_outbox' and column_name = 'xid' and data_type <> 'bigint') then alter table bolt_sync_outbox alter column xid type bigint, alter column xid set default (pg_current_xact_id()::text::bigint); end if; end $$"
		},
		/** Compaction reads by record identity; the primary key orders by cursor and cannot serve that. */
		{
			id: 'bolt:sync-outbox-record',
			sql: 'create index if not exists bolt_sync_outbox_record_idx on bolt_sync_outbox (collection_name, record_id, xid, sequence)'
		},
		/**
		 * The point below which the log is no longer complete.
		 *
		 * Reset used to be inferred from the oldest surviving outbox row, which could never fire: nothing
		 * pruned the outbox, so no cursor could ever be older than its first row and the one safety valve
		 * in the design was unreachable. Retention is the only thing that may strand a client — dropping a
		 * record's newest row means a replica below that point can never learn the record exists — so
		 * retention records where it cut, and `diff` answers a cursor below the mark with a rebuild.
		 *
		 * Compaction deliberately does not move this. Collapsing superseded versions of a record leaves
		 * its final state in the log, which is all a replica needs to converge, so it is safe at any cursor.
		 */
		{
			id: 'bolt:sync-horizon',
			sql: 'create table if not exists bolt_sync_horizon (id boolean primary key default true check (id), xid bigint not null default 0, sequence bigint not null default 0)'
		},
		{
			id: 'bolt:sync-horizon-seed',
			sql: 'insert into bolt_sync_horizon (id) values (true) on conflict (id) do nothing'
		},
		// The Secrets vault. Values are rows in the system database, never in the artifact and never in
		// the client bundle: a secret that ships with the code is a secret in everyone's browser cache.
		//
		// `value` stays `text` and holds a `v1.<nonce>.<ciphertext>.<tag>` AES-256-GCM envelope, not the
		// credential — see `@norbital-ai/std/secret` for the encoding and why it is one column.
		// The key is the host's and is never a row in this database; a key stored beside its own
		// ciphertext protects against nothing. Both vaults below share that envelope and that key.
		{
			id: 'bolt:secrets',
			sql: 'create table if not exists bolt_secrets (tenant_id text not null, name text not null, value text not null, updated_at timestamptz not null default now(), updated_by text, primary key (tenant_id, name))'
		},
		// Personal secrets: the same idea keyed by a person instead of a workspace, and a separate table
		// rather than a `user_id` column on the one above because the *access rule* is what differs.
		// A `bolt_secrets` row is workspace configuration, reachable by anyone with `manage secrets`; a
		// row here is somebody's own signed-in session, reachable only by them — an admin reading a
		// colleague's LinkedIn cookie is not workspace administration. One table cannot hold both rules
		// without every reader remembering which kind of row it is looking at, so there are two.
		//
		// `user_id` is part of the key, so a personal entry and a workspace entry may share a name
		// without colliding, and no `updated_by`: the only person who can write a row is the person the
		// row is keyed by, so the column would only ever repeat `user_id`.
		//
		// The same encrypted envelope as above, additionally bound to `(tenant_id, user_id, name)`, so
		// an envelope lifted out of one row and pasted into another fails to decrypt instead of turning
		// one person's session into somebody else's.
		{
			id: 'bolt:personal-secrets',
			sql: 'create table if not exists bolt_personal_secrets (tenant_id text not null, user_id text not null, name text not null, value text not null, updated_at timestamptz not null default now(), primary key (tenant_id, user_id, name))'
		},
		{
			id: 'bolt:workspace-settings',
			sql: "create table if not exists bolt_workspace_identity_settings (tenant_id text primary key, settings jsonb not null default '{}')"
		}
	];
	/**
	 * Collection DDL the plan still owns, which is now only what Drizzle cannot express.
	 *
	 * Two renderings of the same table used to exist — this module's `create table if not exists` and
	 * the lineage's `CREATE TABLE` — and they were not obliged to agree. They didn't: the scalar
	 * fallback below renders `number` as `double precision`, so a `numeric` money column created from
	 * the plan held binary floating point while the same declaration created from the lineage held
	 * `numeric`. `verify` compares column *names* and both sides had an `amount`, so nothing caught it.
	 *
	 * The lineage is now the only writer of workspace collection tables, their columns, and their
	 * indexes. What stays here is what has no Drizzle entity to be rendered from:
	 *
	 *   - EXCLUDE constraints (`CollectionDefinition.exclusions`), which drizzle-kit cannot emit.
	 *   - Bolt's own system collections, which belong to no workspace and appear in no workspace
	 *     lineage, so only the plan can create them.
	 */
	const collections = workspace.collections
		.flatMap((collection) => {
			const exclusions = (collection.exclusions ?? []).map((exclusion) =>
				exclusionStep(collection.name, exclusion)
			);
			if (!SYSTEM_COLLECTION_NAMES.has(collection.name)) return exclusions;
			const fields = Object.entries(collection.fields)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([name, field]) => {
					const column = `${SchemaPlanValues.quoteIdentifier(name)} ${SchemaPlanValues.columnType(field)}`;
					if (field.generated !== undefined)
						return `${column} generated always as (${field.generated}) stored`;
					// DEFAULT before NOT NULL, the order the lineage's DDL uses, so the two renderings of the
					// same column are the same text and not merely equivalent.
					const defaulted =
						field.sqlDefault === undefined ? column : `${column} default ${field.sqlDefault}`;
					return `${defaulted}${field.required ? ' not null' : ''}`;
				});
			const sql = `create table if not exists ${SchemaPlanValues.quoteIdentifier(collection.name)} (${SYSTEM_COLUMNS}${fields.length === 0 ? '' : `, ${fields.join(', ')}`})`;
			return [
				{ id: `collection:${collection.name}`, sql },
				...declaredIndexSteps(collection),
				...searchIndexSteps(collection),
				...exclusions
			];
		})
		.sort((left, right) => left.id.localeCompare(right.id));
	const steps = [...foundation, ...collections].toSorted((left, right) =>
		left.id.localeCompare(right.id)
	);
	return { fingerprint: SchemaPlanValues.fingerprint(steps), steps };
};

/**
 * The steps a host applies before anything can authenticate.
 *
 * A freshly provisioned database is empty, and `schema.migrate` — the command that would fill it —
 * authenticates through a session row like every other command. So a host has to create identity's
 * tables before it can migrate, and this is what it applies: the same steps the plan would emit for
 * those collections, generated from the same declaration, rather than a copy of the DDL kept
 * somewhere a host could let drift. `schema.migrate` remains the authority and re-applies them.
 */
/** The identity collections' names, so the filter below reads the declaration and not a convention. */
const IDENTITY_COLLECTION_NAMES: ReadonlyArray<string> = IDENTITY_COLLECTIONS.map(
	({ name }) => name
);

export const identitySchemaSteps = (): ReadonlyArray<SchemaStep> =>
	buildSchemaPlan({
		name: 'identity',
		collections: IDENTITY_COLLECTIONS,
		customTypes: {},
		policies: [],
		relations: []
	} as unknown as WorkspaceDefinition).steps.filter((step) =>
		// Derived from the declaration rather than from a name prefix. `bolt_team` is an identity
		// collection — resolving a subject joins it — and it does not begin with `bolt_auth_`, so a
		// prefix test would have silently left every host that applies these steps unable to
		// authenticate anybody.
		IDENTITY_COLLECTION_NAMES.some(
			(name) => step.id === `collection:${name}` || step.id.startsWith(`collection:${name}:`)
		)
	);
