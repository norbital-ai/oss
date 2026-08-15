import { defineRelations, sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	customType,
	doublePrecision,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn,
	type AnyPgColumnBuilder,
	type ExtraConfigColumn,
	type PgTable,
	type PgTableExtraConfigValue
} from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { type SystemCollectionName } from './collections.js';
import { collectionSearchTrigramIndexName } from '../collection/types.js';
import { AiMessageSchema } from '../runtime/binding.js';

export interface SystemTableMeta {
	readonly description?: string;
	readonly record_label?: string | null;
	readonly icon?: string | null;
	readonly semanticSearch?: boolean;
	/**
	 * Whether this collection keeps a typed `<table>_history` temporal relation. Defaults to true.
	 *
	 * Opt out only for a high-volume, append-only table whose rows are already ordered by their own
	 * sequence: the history row roughly doubles the write cost of every insert to buy a revision
	 * trail nothing reads. Turning it off on a collection that already has one drops that relation —
	 * and the rows in it — in the next generated migration.
	 */
	readonly history?: boolean;
	/**
	 * Whether writes must go through `collection_ops` (`norbital.via_ops`). System collections
	 * default to false — their rows are written by onboarding, outbox drainers, and other host
	 * paths that do not set that GUC. Tenant collections default to true.
	 */
	readonly opsGuard?: boolean;
	/**
	 * Whether `_approval_lock_gate` attaches. Defaults to true for any table with `norbital_id`.
	 * Opt out for append-only logs and for the lock table itself.
	 */
	readonly approvalLock?: boolean;
	/**
	 * Whether the collection is included in the client replica DDL. Defaults to true.
	 * Opt out for change-feed internals, outboxes, and anything the browser must not cache.
	 */
	readonly replica?: boolean;
	/**
	 * Whether every text column gets a GIN trigram index. System collections default to true to
	 * preserve the existing search surface; opt out for internals whose text is not queried that way.
	 * Tenant collections already opt in per column via `text({ search: true })`.
	 */
	readonly search?: boolean;
	/**
	 * Whether UPDATE/DELETE are rejected. Defaults to false. `audit_event` is the one current
	 * insert-only collection; the post-DDL trigger is attached from this flag rather than the name.
	 */
	readonly insertOnly?: boolean;
	readonly system: true;
}

/** Flags every leftover host-internal table shares: no history, no replica, no collection extras. */
const INTERNAL_SYSTEM_FLAGS = {
	history: false,
	opsGuard: false,
	approvalLock: false,
	replica: false,
	search: false,
	system: true
} as const satisfies Omit<SystemTableMeta, 'description' | 'record_label' | 'icon'>;

const JsonObjectSchema = z.record(z.string(), z.unknown());
const JsonArraySchema = z.array(z.unknown());
const StringArraySchema = z.array(z.string());

export const ChatSessionMessageSchema = z.object({
	norbital_id: z.string(),
	turn_id: z.string().nullable().default(null),
	role: z.string(),
	seq: z.number(),
	parts: z.array(AiMessageSchema),
	model: z.string().nullable().default(null),
	usage: JsonObjectSchema.nullable().default(null),
	plan_mode: z.boolean().default(false),
	goal_mode: z.boolean().default(false),
	kind: z.enum(['normal', 'reasoning', 'summary', 'usage', 'goal']).default('normal'),
	status: z.enum(['streaming', 'complete', 'aborted']).default('complete'),
	queue_status: z.enum(['live', 'queued', 'released', 'removed']).default('live'),
	release_mode: z.enum(['step', 'turn']).nullable().default(null),
	author_display_name: z.string().nullable().default(null),
	source_provider: z.string().nullable().default(null),
	source_conversation_id: z.string().nullable().default(null),
	source_message_id: z.string().nullable().default(null),
	durable_ordinal: z.number().nullable().optional()
});

export const ChatSessionTurnSchema = z.object({
	norbital_id: z.string(),
	prompt_message_id: z.string().nullable().default(null),
	status: z.enum(['running', 'succeeded', 'aborted', 'failed']),
	model: z.string().default('host-default'),
	parent_turn_id: z.string().nullable().default(null),
	subagent_id: z.string().nullable().default(null),
	error: z.string().nullable().default(null),
	started_at: z.string(),
	heartbeat_at: z.string().default(''),
	ended_at: z.string().nullable().default(null),
	usage_settled_at: z.string().nullable().default(null)
});
export const ChatSessionMessagesSchema = z.array(ChatSessionMessageSchema);
export const ChatSessionTurnsSchema = z.array(ChatSessionTurnSchema);

const EmailChannel = z.object({
	type: z.literal('email'),
	email: z.string().email(),
	verified: z.boolean().default(false),
	primary: z.boolean().default(false)
});

const PhoneChannel = z.object({
	type: z.literal('phone'),
	number: z.string().min(1),
	verified: z.boolean().default(false),
	primary: z.boolean().default(false)
});

const WechatChannel = z.object({
	type: z.literal('wechat'),
	wechat_id: z.string().min(1),
	verified: z.boolean().default(false),
	primary: z.boolean().default(false)
});

const TelegramChannel = z.object({
	type: z.literal('telegram'),
	username: z.string().min(1),
	verified: z.boolean().default(false),
	primary: z.boolean().default(false)
});

const WhatsappChannel = z.object({
	type: z.literal('whatsapp'),
	number: z.string().min(1),
	verified: z.boolean().default(false),
	primary: z.boolean().default(false)
});

const SlackChannel = z.object({
	type: z.literal('slack'),
	slack_user_id: z.string().min(1),
	team_id: z.string().optional(),
	verified: z.boolean().default(false),
	primary: z.boolean().default(false)
});

const UserChannelSchema = z.discriminatedUnion('type', [
	EmailChannel,
	PhoneChannel,
	WechatChannel,
	TelegramChannel,
	WhatsappChannel,
	SlackChannel
]);

const UserChannelsSchema = z.array(UserChannelSchema);
const tableMeta = new WeakMap<object, SystemTableMeta>();

const systemColumns = {
	norbital_id: uuid().primaryKey().defaultRandom(),
	norbital_created_at: timestamp({ withTimezone: true }).defaultNow(),
	norbital_updated_at: timestamp({ withTimezone: true }).defaultNow(),
	norbital_sys_period: customType<{ data: string; driverData: string }>({
		dataType: () => 'tstzrange'
	})()
		.notNull()
		.default(sql`tstzrange(CURRENT_TIMESTAMP, NULL, '[)')`),
	norbital_row_version: integer().default(1),
	norbital_approval_id: uuid()
};

const xid8Column = customType<{ data: string; driverData: string }>({
	dataType: () => 'xid8'
});

function jsonbColumn<T>(schema: z.ZodType<T>) {
	return customType<{ data: T; driverData: string }>({
		dataType() {
			return 'jsonb';
		},
		toDriver(value: T): string {
			return JSON.stringify(schema.parse(value));
		},
		fromDriver(value: string): T {
			return typeof value === 'string' ? schema.parse(JSON.parse(value)) : schema.parse(value);
		}
	})();
}

function systemTable<
	const TName extends string,
	const TColumns extends Record<string, AnyPgColumnBuilder>
>(
	name: TName,
	columns: TColumns,
	meta: SystemTableMeta,
	extraConfig?: (self: Record<string, ExtraConfigColumn>) => PgTableExtraConfigValue[]
) {
	const table = pgTable(name, { ...systemColumns, ...columns }, (self) => {
		const authored = extraConfig?.(self) ?? [];
		if (meta.search === false) return authored;
		const searchIndexes = Object.entries(columns)
			.filter(([, builder]) => {
				const config = Reflect.get(builder, 'config');
				return (
					config != null &&
					typeof config === 'object' &&
					Reflect.get(config, 'columnType') === 'PgText' &&
					Number(Reflect.get(config, 'dimensions') ?? 0) === 0
				);
			})
			.map(([columnName]) => {
				const column = Reflect.get(self, columnName) as ExtraConfigColumn | undefined; // stupidity: boundary-cast — generic system columns are runtime-keyed by their declaration names.
				if (!column) throw new Error(`Missing searchable system column ${name}.${columnName}`);
				return index(collectionSearchTrigramIndexName(name, columnName)).using(
					'gin',
					column.op('gin_trgm_ops')
				);
			});
		return [...authored, ...searchIndexes];
	});
	tableMeta.set(table, meta);
	return table;
}

export function getSystemTableMeta(table: object): SystemTableMeta | undefined {
	return tableMeta.get(table);
}

const _user = systemTable(
	'user',
	{
		email: text().notNull().unique(),
		name: text(),
		/**
		 * The person's avatar, as a reference to the `document_asset` they uploaded.
		 *
		 * The two tables reference each other — an asset records the user who owns it, and a user
		 * records the asset that pictures them — so the target is named through a callback with an
		 * explicit return type: the annotation is what stops the circular inference from collapsing
		 * to `any`, and the callback is what defers the lookup past `_document_asset`'s declaration.
		 *
		 * Nullable, and `set null` on delete, because the cycle would otherwise be unresolvable in
		 * both directions: a user could not be inserted before an asset that requires an owner, and
		 * deleting an avatar would fail against the row pointing at it rather than clearing it.
		 */
		avatar_asset_id: uuid().references((): AnyPgColumn => _document_asset.norbital_id, {
			onDelete: 'set null'
		}),
		status: text().default('active'),
		role: text().default('basic'),
		kind: text().default('human'),
		channels: jsonbColumn(UserChannelsSchema).default([])
	},
	{ description: 'System users', record_label: 'name', system: true }
);

const _approval_request = systemTable(
	'approval_request',
	{
		organization_id: uuid().notNull(),
		label: text().notNull(),
		approval_config_id: uuid().notNull(),
		// Nullable only for receipts written by pre-durable versions. New staged receipts always set it;
		// keeping the upgrade additive lets old terminal ledger rows survive a generated migration.
		collection_name: text(),
		status: text().notNull(),
		approval_step_nodes: jsonbColumn(JsonArraySchema).notNull().default([]),
		locked_record_refs: jsonbColumn(JsonArraySchema).notNull().default([]),
		closed_at: timestamp({ withTimezone: true })
	},
	{ description: 'Approval requests', record_label: 'label', system: true }
);

const _automation_run = systemTable(
	'automation_run',
	{
		requested_by_user_id: uuid()
			.references(() => _user.norbital_id)
			.notNull(),
		automation_name: text(),
		status: text().notNull().default('pending'),
		input: jsonbColumn(JsonObjectSchema).default({}),
		output: jsonbColumn(JsonObjectSchema),
		error: text(),
		started_at: timestamp({ withTimezone: true }),
		completed_at: timestamp({ withTimezone: true })
	},
	{ description: 'Automation runs', record_label: 'automation_name', system: true }
);

const _requestor = systemTable(
	'requestor',
	{
		approval_request_id: uuid()
			.references(() => _approval_request.norbital_id)
			.notNull(),
		user_id: uuid()
			.references(() => _user.norbital_id)
			.notNull()
	},
	{ description: 'Approval request requestor link', system: true }
);

const _policy = systemTable(
	'policy',
	{
		key: text().notNull(),
		name: text().notNull(),
		description: text(),
		is_active: boolean().notNull().default(true),
		accessible_applications: jsonbColumn(StringArraySchema).default([]),
		grants: jsonbColumn(JsonArraySchema).default([])
	},
	{ description: 'Access policies', record_label: 'name', system: true },
	(t) => [uniqueIndex('policy_key_unique').on(t.key)]
);

const _team = systemTable(
	'team',
	{
		name: text().notNull(),
		description: text(),
		parent_id: text(),
		is_active: boolean().notNull().default(true),
		kind: text().default('human'),
		/**
		 * The policy this team holds, or null while it holds none.
		 *
		 * Nullable because policies are now *declared* in source and reconciled at migrate time, while
		 * teams are runtime rows. A team therefore exists before any policy does — seeding one with
		 * `NOT NULL` forced a policy id to be invented at seed time, which is exactly the coupling that
		 * kept permission sets out of source. Assignment is an ordinary update.
		 */
		policy_id: uuid().references(() => _policy.norbital_id)
	},
	{ description: 'Teams', record_label: 'name', system: true }
);

const _audit_event = systemTable(
	'audit_event',
	{
		event_type: text().notNull().default('mutation'),
		collection_name: text(),
		record_id: uuid(),
		details: jsonbColumn(JsonObjectSchema).default({}),
		actor_id: uuid().references(() => _user.norbital_id)
	},
	// An audit trail is append-only and is itself the revision record; versioning it would store a
	// second copy of every row for a history nothing reads.
	{
		description: 'Audit events',
		record_label: 'event_type',
		history: false,
		approvalLock: false,
		insertOnly: true,
		system: true
	}
);

const _integration_outbox = systemTable(
	'integration_outbox',
	{
		integration_name: text().notNull(),
		binding_name: text().notNull(),
		collection_name: text().notNull(),
		record_id: uuid().notNull(),
		action: text().notNull(),
		payload: jsonbColumn(JsonObjectSchema).notNull(),
		status: text().notNull().default('pending'),
		attempts: integer().notNull().default(0),
		available_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		claimed_at: timestamp({ withTimezone: true }),
		delivered_at: timestamp({ withTimezone: true }),
		last_error: text()
	},
	{
		description: 'Transactional tenant integration delivery outbox',
		record_label: 'integration_name',
		replica: false,
		system: true
	}
);

/**
 * Where each `api-pull` binding got to, so a restart resumes instead of re-importing.
 *
 * A pull cursor cannot live in the job closure: `pod start` and a Core sandbox both come and go, and
 * an in-memory cursor silently re-imports the whole remote history every time one does. One row per
 * binding, keyed by the same `<integration>:<binding>` pair the manifest names it with.
 */
const _integration_cursor = systemTable(
	'integration_cursor',
	{
		integration_name: text().notNull(),
		binding_name: text().notNull(),
		binding_key: text().notNull().unique(),
		/** Opaque to Pod: whatever the remote's `nextCursorHeader` last returned. */
		cursor: text(),
		last_pulled_at: timestamp({ withTimezone: true }),
		last_error: text()
	},
	{
		description: 'Resume points for scheduled integration pulls',
		record_label: 'binding_key',
		replica: false,
		system: true
	}
);

/**
 * One inbound delivery, claimed before its import runs.
 *
 * A provider that redelivers is normal — a slow acknowledgement, a retry policy, an operator pressing
 * "resend" — and without this row every redelivery imports the same page again. `receipt_key` carries
 * the uniqueness, so the second arrival loses one insert instead of writing a second set of records.
 * It is the same ledger `channel_inbound_message` is, for the same reason and in the same order:
 * claimed first, settled after.
 */
const _integration_inbound_event = systemTable(
	'integration_inbound_event',
	{
		integration_name: text().notNull(),
		binding_name: text().notNull(),
		binding_key: text().notNull(),
		collection_name: text().notNull(),
		/** The provider's own event id, or a digest of the body when it sends none. */
		event_id: text().notNull(),
		receipt_key: text().notNull().unique(),
		/** `queued`, `processing`, `imported`, `failed`, or `refused`. */
		status: text().notNull().default('queued'),
		/** Original accepted delivery. It survives process restart until the import is terminal. */
		import_data: jsonbColumn(z.unknown()),
		/** Pipeline output is persisted once, so chunk retries never rerun an author transformation. */
		materialized_records: jsonbColumn(JsonArraySchema),
		next_offset: integer().notNull().default(0),
		attempts: integer().notNull().default(0),
		available_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		claimed_at: timestamp({ withTimezone: true }),
		imported: integer(),
		error: text(),
		completed_at: timestamp({ withTimezone: true })
	},
	{
		description: 'Inbound integration deliveries already accepted',
		record_label: 'receipt_key',
		system: true
	}
);

const _notification_outbox = systemTable(
	'notification_outbox',
	{
		channel: text().notNull(),
		recipient_user_id: uuid()
			.references(() => _user.norbital_id)
			.notNull(),
		subject: text().notNull(),
		message: text().notNull(),
		cta_label: text(),
		cta_url: text(),
		status: text().notNull().default('pending'),
		attempts: integer().notNull().default(0),
		available_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		claimed_at: timestamp({ withTimezone: true }),
		delivered_at: timestamp({ withTimezone: true }),
		last_error: text()
	},
	{
		description: 'Transactional external notification delivery outbox',
		record_label: 'subject',
		replica: false,
		system: true
	}
);

const _notification = systemTable(
	'notification',
	{
		recipient_user_id: uuid()
			.references(() => _user.norbital_id)
			.notNull(),
		subject: text().notNull(),
		message: text().notNull(),
		channels: jsonbColumn(StringArraySchema).default([]),
		cta_label: text(),
		cta_url: text(),
		notification_category: text(),
		read_at: timestamp({ withTimezone: true })
	},
	{ description: 'Notifications', record_label: 'subject', system: true }
);

const _document_asset = systemTable(
	'document_asset',
	{
		owner_user_id: uuid()
			.references(() => _user.norbital_id)
			.notNull(),
		file_name: text().notNull(),
		mime_type: text(),
		file_size: integer(),
		storage_key: text().notNull()
	},
	{ description: 'Document assets', record_label: 'file_name', system: true }
);

const _team_members = systemTable(
	'team_members',
	{
		user_id: uuid()
			.references(() => _user.norbital_id)
			.notNull(),
		team_id: uuid()
			.references(() => _team.norbital_id)
			.notNull()
	},
	{ system: true }
);

/**
 * Pending workspace invitations.
 *
 * The token is stored only as a SHA-256 hash: a leaked table gives an attacker nothing to redeem,
 * and the plaintext exists exactly once, in the email pod sends. `consumed_at` makes redemption
 * single-use, and the unique index on `(email) WHERE consumed_at IS NULL` is what makes concurrent
 * accepts settle to one user.
 */
/**
 * One agent conversation.
 *
 * Tenant-scoped agent conversation. A Pod database is one tenant, so an organization column would
 * be constant on every row and a filter every query had to remember.
 *
 * `platform` and `external_thread_id` carry the transport and the conversation a channel session
 * answers; `channel_conversation` holds the same pair under a unique key and is what the lookup goes
 * through. A channel is declared, so there is no separate `channel_config` or `agent_profile` table
 * to reference.
 */
const _chat_session = systemTable(
	'chat_session',
	{
		user_id: uuid()
			.references(() => _user.norbital_id)
			.notNull(),
		/**
		 * Set when this session is an automation's agent run rather than an interactive conversation.
		 *
		 * One transcript model serves both: an automation agent and a person talking to the agent produce
		 * the same messages, so they should not be two tables that drift.
		 */
		automation_run_id: uuid().references(() => _automation_run.norbital_id),
		title: text().notNull(),
		platform: text(),
		/** `personal`, `channel_dm`, or `channel_group`. */
		visibility: text().notNull().default('personal'),
		/** Declared profile key for a channel transcript; null for the workspace/web agent. */
		channel_key: text(),
		external_thread_id: text(),
		agent_profile_id: uuid(),
		channel_config_id: uuid(),
		assigned_channel_id: uuid(),
		/**
		 * The complete ordered transcript. Each entry carries its stable id, owning turn, role, sequence,
		 * TanStack AI message parts, delivery state, provider usage, and channel provenance.
		 *
		 * Keeping it on the session makes the conversation one sync aggregate: a subscriber cannot see a
		 * title without its messages, a terminal message without its turn, or a tool result without the
		 * call it answers because separate collection events arrived in another order.
		 */
		messages: jsonbColumn(ChatSessionMessagesSchema).notNull().default([]),
		/** Root and delegated turn lifecycle, embedded beside the messages it governs. */
		turns: jsonbColumn(ChatSessionTurnsSchema).notNull().default([]),
		/**
		 * What this conversation has spent, accumulated as each turn settles.
		 *
		 * A counter rather than a sum over embedded message usage, because a derived total falls when a
		 * message is deleted and what was spent does not. Deleting a message removes the record of a
		 * request, never the fact that it was paid for.
		 *
		 * `doublePrecision` because this is a figure a person reads, not a ledger anyone settles
		 * against: the values are ~1e-5 USD and float error at this magnitude is far below the cent.
		 */
		usage_cost_usd: doublePrecision().notNull().default(0),
		usage_total_tokens: integer().notNull().default(0),
		/** How many turns are behind the totals, and how many could not report — see below. */
		usage_turns_counted: integer().notNull().default(0),
		/**
		 * Turns whose host reported no cost.
		 *
		 * Kept separately so a total is never silently passed off as complete. A turn that reported
		 * nothing must not count as zero, or a conversation on a host that publishes no cost reads as
		 * free rather than as unmeasured.
		 */
		usage_turns_unreported: integer().notNull().default(0)
	},
	// The aggregate preserves its raw pre-compaction messages itself. A temporal copy of the complete
	// JSON document on every streamed part would double write volume for a revision trail nothing
	// reads, so the session remains explicitly non-temporal.
	{ description: 'Agent conversations', record_label: 'title', history: false, system: true }
);

/**
 * One external conversation, bound to the transcript that answers it.
 *
 * A channel is declared in source (`src/channels/+<key>.channel.ts`), so there is deliberately no
 * per-tenant channel *configuration* row here — the credential that holds the wire open belongs to the
 * host, and the policy the agent answers under belongs to the declaration. What has to be stored is
 * only the part neither of them knows: which `chat_session` a given external conversation continues,
 * so a second message from the same chat resumes the transcript instead of starting a new one.
 *
 * `binding_key` is `<channel_key>:<external_conversation_id>` and carries the uniqueness, because the
 * pair is what must be unique and a composite unique index is not expressible through `systemTable`.
 * The two parts are stored beside it so a query can read them without parsing the key.
 */
const _channel_conversation = systemTable(
	'channel_conversation',
	{
		/** The declared channel this conversation arrived on. */
		channel_key: text().notNull(),
		/** Copied from the declaration at bind time, so a transport rename is visible as drift. */
		transport: text().notNull(),
		/** Transport-native address — a Telegram chat id, a phone number, a thread id. */
		external_conversation_id: text().notNull(),
		/** `dm` or `group`, preserved from the transport instead of guessed from its address. */
		conversation_kind: text().notNull().default('dm'),
		/** Public transcripts remain administrator-only; authenticated groups may be shared with members. */
		audience: text().notNull().default('authenticated'),
		/** Policy key copied from the declaration for dynamic member transcript access. */
		policy_key: text().notNull().default(''),
		/** Linked account owning an authenticated DM; null for public DMs and groups. */
		owner_user_id: uuid().references(() => _user.norbital_id, { onDelete: 'set null' }),
		binding_key: text().notNull().unique(),
		chat_id: uuid()
			.references(() => _chat_session.norbital_id, { onDelete: 'cascade' })
			.notNull(),
		last_inbound_at: timestamp({ withTimezone: true }),
		last_outbound_at: timestamp({ withTimezone: true })
	},
	{
		description: 'Channel conversations',
		record_label: 'external_conversation_id',
		system: true
	}
);

/**
 * One inbound message from a transport, and the record that it was already handled.
 *
 * Transports redeliver. Telegram replays an update whose webhook answered non-2xx, WhatsApp replays on
 * reconnect, and a host queue that retries a failed job replays everything in it — so without a
 * ledger the same customer question runs the agent twice, bills twice, and answers twice. `receipt_key`
 * is `<channel_key>:<external_conversation_id>:<external_message_id>` and is claimed by an
 * `ON CONFLICT DO NOTHING` insert *before* the agent runs, which is what makes the duplicate cheap:
 * the second delivery loses the race for the row and returns without spending a token.
 *
 * Claiming first also means a run that crashes is not retried automatically. That is the deliberate
 * side: an agent turn has side effects, and replaying one silently is worse than leaving a `failed`
 * row for an operator to see.
 */
const _channel_inbound_message = systemTable(
	'channel_inbound_message',
	{
		channel_key: text().notNull(),
		conversation_id: uuid()
			.references(() => _channel_conversation.norbital_id, { onDelete: 'cascade' })
			.notNull(),
		external_conversation_id: text().notNull(),
		external_message_id: text().notNull(),
		receipt_key: text().notNull().unique(),
		/** Transport-native sender id. The person behind it may have no user row at all. */
		sender_external_id: text(),
		sender_display_name: text(),
		/** `received`, `answered`, or `failed`. */
		status: text().notNull().default('received'),
		error: text(),
		/** Stable id of the embedded chat_session message that records this inbound delivery. */
		session_message_id: uuid(),
		answered_at: timestamp({ withTimezone: true })
	},
	{
		description: 'Channel inbound messages',
		record_label: 'external_message_id',
		system: true
	}
);

/**
 * One durable fixed-window counter used by public-channel admission.
 *
 * The row is updated atomically with `INSERT … ON CONFLICT DO UPDATE`, so several Pod processes see
 * one budget rather than each admitting a full in-memory allowance. `bucket_key` includes the
 * channel and either `profile` or the transport sender id; the latter is never shown in the UI.
 */
const _channel_rate_limit = systemTable(
	'channel_rate_limit',
	{
		bucket_key: text().notNull().unique(),
		window_started_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		request_count: integer().notNull().default(0)
	},
	{
		description: 'Channel admission rate-limit counters',
		record_label: 'bucket_key',
		history: false,
		system: true
	}
);

const _invitation = systemTable(
	'invitation',
	{
		email: text().notNull(),
		token_hash: text().notNull().unique(),
		role: text().notNull().default('basic'),
		invited_by_user_id: uuid().references(() => _user.norbital_id),
		expires_at: timestamp({ withTimezone: true }).notNull(),
		consumed_at: timestamp({ withTimezone: true }),
		consumed_user_id: uuid().references(() => _user.norbital_id)
	},
	{
		description: 'Pending workspace invitations',
		record_label: 'email',
		replica: false,
		system: true
	},
	(t) => [
		uniqueIndex('invitation_live_email_unique')
			.on(t.email)
			.where(sql`consumed_at IS NULL`)
	]
);

/**
 * Lifecycle events pod publishes to whichever host is driving it.
 *
 * Drained by the `queue` facility with the same claim/ack/fail protocol as the integration and
 * notification outboxes, so a host restart cannot silently lose one. `subject_hmac` carries a keyed
 * digest of the email rather than the address, and `seats` carries the resulting census rather than a
 * delta — at-least-once delivery plus delta counting would double-bill.
 */
const _sync_outbox = systemTable(
	'sync_outbox',
	{
		seq: bigint({ mode: 'bigint' }).generatedByDefaultAsIdentity().notNull(),
		collection: text().notNull(),
		record_id: uuid().notNull(),
		action: text().notNull(),
		row_version: integer(),
		origin_scope: jsonbColumn(JsonObjectSchema).notNull().default({}),
		record_snapshot: jsonbColumn(JsonObjectSchema).notNull().default({}),
		occurred_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		xid: xid8Column()
			.notNull()
			.default(sql`pg_current_xact_id()`)
	},
	{
		description: 'Tenant change-feed',
		record_label: 'collection',
		history: false,
		replica: false,
		system: true
	},
	(t) => [
		index('sync_outbox_xid_seq_idx').on(t.xid, t.seq),
		index('sync_outbox_occurred_at_idx').on(t.occurred_at)
	]
);

const _norbital_automation_job = systemTable(
	'_norbital_automation_job',
	{
		automation_name: text().notNull(),
		trigger_key: text().notNull(),
		artifact_id: text().notNull(),
		checkpoint_id: text().notNull(),
		tree_hash: text().notNull(),
		runtime_version: text().notNull(),
		origin_scope: jsonbColumn(JsonObjectSchema).notNull().default({}),
		record_snapshot: jsonbColumn(JsonObjectSchema).notNull().default({}),
		source_pointer: text().notNull(),
		continuation: jsonbColumn(JsonObjectSchema).notNull().default({ effects: [] }),
		effect_id: text(),
		effect_ordinal: integer(),
		effect_request_hash: text(),
		effect_request: jsonbColumn(JsonObjectSchema),
		orchestration_status: text().notNull().default('admitted'),
		last_error: text(),
		created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		updated_at: timestamp({ withTimezone: true }).notNull().defaultNow()
	},
	{
		description: 'Durable automation receipts',
		record_label: 'automation_name',
		history: false,
		replica: false,
		system: true
	},
	(t) => [
		uniqueIndex('_norbital_automation_job_trigger_idx').on(t.automation_name, t.trigger_key),
		index('_norbital_automation_job_claim_idx').on(t.orchestration_status, t.created_at),
		check(
			'_norbital_automation_job_orchestration_status_check',
			sql`orchestration_status IN ('admitted', 'waiting_effect', 'succeeded', 'failed')`
		)
	]
);

const _host_event_outbox = systemTable(
	'host_event_outbox',
	{
		event: text().notNull(),
		reason: text().notNull(),
		subject_hmac: text(),
		seats: jsonbColumn(JsonObjectSchema),
		observed_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		status: text().notNull().default('pending'),
		attempts: integer().notNull().default(0),
		available_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
		claimed_at: timestamp({ withTimezone: true }),
		delivered_at: timestamp({ withTimezone: true }),
		last_error: text()
	},
	{
		description: 'Host-facing lifecycle and seat events',
		record_label: 'event',
		replica: false,
		system: true
	}
);

const _norbital_sync_compaction = systemTable(
	'_norbital_sync_compaction',
	{
		singleton: boolean().notNull().default(true),
		pruned_through_seq: bigint({ mode: 'bigint' })
			.notNull()
			.default(sql`0`),
		pruned_at: timestamp({ withTimezone: true }).notNull().defaultNow()
	},
	{
		...INTERNAL_SYSTEM_FLAGS,
		description: 'Change-feed compaction boundary',
		record_label: 'pruned_through_seq'
	},
	(t) => [
		uniqueIndex('_norbital_sync_compaction_singleton_key').on(t.singleton),
		check('_norbital_sync_compaction_singleton_check', sql`singleton`)
	]
);

const _norbital_automation_cursor = systemTable(
	'_norbital_automation_cursor',
	{
		singleton: boolean().notNull().default(true),
		xid: xid8Column()
			.notNull()
			.default(sql`'0'::xid8`),
		seq: bigint({ mode: 'bigint' })
			.notNull()
			.default(sql`0`)
	},
	{
		...INTERNAL_SYSTEM_FLAGS,
		description: 'Event-automation outbox cursor',
		record_label: 'seq'
	},
	(t) => [
		uniqueIndex('_norbital_automation_cursor_singleton_key').on(t.singleton),
		check('_norbital_automation_cursor_singleton_check', sql`singleton`)
	]
);

const _norbital_sync_epoch = systemTable(
	'_norbital_sync_epoch',
	{
		singleton: boolean().notNull().default(true),
		epoch: uuid()
			.notNull()
			.default(sql`uuidv7()`)
	},
	{
		...INTERNAL_SYSTEM_FLAGS,
		description: 'Physical tenant-database identity',
		record_label: 'epoch'
	},
	(t) => [
		uniqueIndex('_norbital_sync_epoch_singleton_key').on(t.singleton),
		check('_norbital_sync_epoch_singleton_check', sql`singleton`)
	]
);

const _approval_lock = systemTable(
	'_approval_lock',
	{
		approval_request_id: uuid()
			.notNull()
			.references(() => _approval_request.norbital_id, { onDelete: 'cascade' }),
		lock_type: text().notNull(),
		collection_name: text().notNull(),
		record_id: uuid().notNull()
	},
	{
		...INTERNAL_SYSTEM_FLAGS,
		description: 'Pending approval record locks',
		record_label: 'collection_name'
	},
	(t) => [
		uniqueIndex('_approval_lock_collection_record_type_key').on(
			t.collection_name,
			t.record_id,
			t.lock_type
		),
		check(
			'_approval_lock_lock_type_check',
			sql`lock_type IN ('schema', 'record_delete', 'record_mutation')`
		)
	]
);

export const approval_request = _approval_request;
export const requestor = _requestor;
export const chat_session = _chat_session;
export const channel_conversation = _channel_conversation;
export const channel_inbound_message = _channel_inbound_message;
export const channel_rate_limit = _channel_rate_limit;
export const invitation = _invitation;
export const host_event_outbox = _host_event_outbox;
export const sync_outbox = _sync_outbox;
export const norbital_automation_job = _norbital_automation_job;
export const automation_run = _automation_run;
export const user = _user;
export const team = _team;
export const policy = _policy;
export const audit_event = _audit_event;
export const integration_outbox = _integration_outbox;
export const integration_cursor = _integration_cursor;
export const integration_inbound_event = _integration_inbound_event;
export const notification_outbox = _notification_outbox;
export const notification = _notification;
export const document_asset = _document_asset;
export const team_members = _team_members;
export const norbital_sync_compaction = _norbital_sync_compaction;
export const norbital_automation_cursor = _norbital_automation_cursor;
export const norbital_sync_epoch = _norbital_sync_epoch;
export const approval_lock = _approval_lock;

export const platformTables = {
	approval_request,
	requestor,
	invitation,
	host_event_outbox,
	automation_run,
	user,
	team,
	policy,
	audit_event,
	integration_outbox,
	integration_cursor,
	integration_inbound_event,
	notification_outbox,
	notification,
	document_asset,
	team_members
} as const;

export const systemTables = {
	approval_request: { table: approval_request },
	requestor: { table: requestor },
	invitation: { table: invitation },
	host_event_outbox: { table: host_event_outbox },
	automation_run: { table: automation_run },
	user: { table: user },
	team: { table: team },
	policy: { table: policy },
	audit_event: { table: audit_event },
	integration_outbox: { table: integration_outbox },
	integration_cursor: { table: integration_cursor },
	integration_inbound_event: { table: integration_inbound_event },
	notification_outbox: { table: notification_outbox },
	notification: { table: notification },
	document_asset: { table: document_asset },
	team_members: { table: team_members },
	chat_session: { table: chat_session },
	channel_conversation: { table: channel_conversation },
	channel_inbound_message: { table: channel_inbound_message },
	channel_rate_limit: { table: channel_rate_limit },
	sync_outbox: { table: sync_outbox },
	_norbital_automation_job: { table: norbital_automation_job },
	_norbital_sync_compaction: { table: norbital_sync_compaction },
	_norbital_automation_cursor: { table: norbital_automation_cursor },
	_norbital_sync_epoch: { table: norbital_sync_epoch },
	_approval_lock: { table: approval_lock }
} satisfies Record<SystemCollectionName, { table: PgTable }>;

/**
 * System collections that keep no `<table>_history` relation.
 *
 * Derived from each collection's own `history` flag rather than restated. A second literal list is
 * how the migration generator and the runtime DDL came to disagree about `chat_*`: the generator
 * stopped mirroring column changes into history relations the lineage still declared, and nothing
 * dropped them. Both halves now read this.
 */
function systemFlag(
	meta: SystemTableMeta | undefined,
	flag: 'history' | 'opsGuard' | 'approvalLock' | 'replica' | 'search' | 'insertOnly',
	defaultValue: boolean
): boolean {
	const value = meta?.[flag];
	return typeof value === 'boolean' ? value : defaultValue;
}

function systemCollectionNamesWhere(
	predicate: (meta: SystemTableMeta | undefined) => boolean
): ReadonlySet<SystemCollectionName> {
	return new Set(
		Object.entries(systemTables)
			.filter(([, entry]) => predicate(getSystemTableMeta(entry.table)))
			.map(([name]) => name as SystemCollectionName)
	);
}

export const NON_TEMPORAL_SYSTEM_COLLECTIONS: ReadonlySet<SystemCollectionName> =
	systemCollectionNamesWhere((meta) => systemFlag(meta, 'history', true) === false);

/** System collections whose writes do not set `norbital.via_ops`. Default for system is false. */
export const SYSTEM_COLLECTIONS_WITHOUT_OPS_GUARD: ReadonlySet<SystemCollectionName> =
	systemCollectionNamesWhere((meta) => systemFlag(meta, 'opsGuard', false) === false);

/** System collections the approval-lock gate skips. Default is true (gate attaches). */
export const SYSTEM_COLLECTIONS_WITHOUT_APPROVAL_LOCK: ReadonlySet<SystemCollectionName> =
	systemCollectionNamesWhere((meta) => systemFlag(meta, 'approvalLock', true) === false);

/** System collections omitted from the client replica DDL. Default is true (included). */
export const SYSTEM_COLLECTIONS_WITHOUT_REPLICA: ReadonlySet<SystemCollectionName> =
	systemCollectionNamesWhere((meta) => systemFlag(meta, 'replica', true) === false);

/** System collections that reject UPDATE/DELETE. Default is false. */
export const SYSTEM_COLLECTIONS_INSERT_ONLY: ReadonlySet<SystemCollectionName> =
	systemCollectionNamesWhere((meta) => systemFlag(meta, 'insertOnly', false) === true);

/**
 * Relations that are not collections. Collection extras are opted on the collection itself;
 * these names are the only leftovers that still have to be listed.
 */
export const NON_COLLECTION_INTERNALS = [
	'_norbital_internal_schema',
	'__drizzle_migrations'
] as const;

/** Leftover names the replica introspector must skip that are not collections. */
export const REPLICA_INTERNAL_EXCLUSIONS = [...NON_COLLECTION_INTERNALS, 'mutation_log'] as const;

/** Tables omitted from the client replica DDL. */
export function replicaExcludedTables(collections: {
	readonly [name: string]: { readonly extensions?: { readonly replica?: boolean } };
}): string[] {
	return [
		...new Set([
			...REPLICA_INTERNAL_EXCLUSIONS,
			...SYSTEM_COLLECTIONS_WITHOUT_REPLICA,
			...Object.entries(collections)
				.filter(([, collection]) => collection.extensions?.replica === false)
				.map(([name]) => name)
		])
	].sort();
}

export const platformRelations = defineRelations(platformTables, (r) => ({
	approval_request: {
		requestor: r.many.requestor({
			from: r.approval_request.norbital_id,
			to: r.requestor.approval_request_id
		})
	}
}));
