import { defineRelations, sql } from 'drizzle-orm';
import {
	boolean,
	customType,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
	type AnyPgColumnBuilder,
	type ExtraConfigColumn,
	type PgTable
} from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { SYSTEM_COLLECTION_NAMES, type SystemCollectionName } from './collections.js';
import { collectionSearchTrigramIndexName } from '../collection/types.js';

export interface SystemTableMeta {
	readonly description?: string;
	readonly record_label?: string | null;
	readonly icon?: string | null;
	readonly semanticSearch?: boolean;
	readonly system: true;
}

const JsonObjectSchema = z.record(z.string(), z.unknown());
const JsonArraySchema = z.array(z.unknown());
const StringArraySchema = z.array(z.string());

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

function jsonbColumn<T>(schema: z.ZodType<T>) {
	return customType<{ data: T | null; driverData: string | null }>({
		dataType() {
			return 'jsonb';
		},
		toDriver(value: T | null): string | null {
			return value == null ? null : JSON.stringify(schema.parse(value));
		},
		fromDriver(value: string | null): T | null {
			if (value == null) return null;
			return typeof value === 'string' ? schema.parse(JSON.parse(value)) : schema.parse(value);
		}
	})();
}

function systemTable<
	const TName extends string,
	const TColumns extends Record<string, AnyPgColumnBuilder>
>(name: TName, columns: TColumns, meta: SystemTableMeta) {
	const table = pgTable(name, { ...systemColumns, ...columns }, (self) =>
		Object.entries(columns)
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
			})
	);
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
		avatar_url: text(),
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
		collection_name: text().notNull(),
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
	{ description: 'Access policies', record_label: 'name', system: true }
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
	{ description: 'Audit events', record_label: 'event_type', system: true }
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
		/** The provider's own event id, or a digest of the body when it sends none. */
		event_id: text().notNull(),
		receipt_key: text().notNull().unique(),
		/** `received`, `imported`, or `failed`. */
		status: text().notNull().default('received'),
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
 * Ported from Core's `chat_session`, minus `organization_id`: a pod database *is* one tenant, so a
 * tenancy column here would be a constant on every row and a filter every query had to remember.
 *
 * `platform` and `external_thread_id` carry the transport and the conversation a channel session
 * answers; `channel_conversation` holds the same pair under a unique key and is what the lookup goes
 * through. The remaining `*_id` columns are Core's shape for rows Pod deliberately does not have —
 * a channel is *declared*, so there is no `channel_config` or `agent_profile` table to reference.
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
		external_thread_id: text(),
		agent_profile_id: uuid(),
		channel_config_id: uuid(),
		assigned_channel_id: uuid()
	},
	{ description: 'Agent conversations', record_label: 'title', system: true }
);

/**
 * One request/response cycle within a session, possibly nested for a subagent.
 *
 * `parent_turn_id` is self-referential: a subagent turn hangs off the turn that spawned it, which is
 * what lets a transcript be reassembled without a separate subagent table.
 */
const _chat_turn = systemTable(
	'chat_turn',
	{
		chat_id: uuid()
			.references(() => _chat_session.norbital_id, { onDelete: 'cascade' })
			.notNull(),
		prompt_message_id: uuid(),
		/** `running`, `succeeded`, `aborted`, or `failed`. */
		status: text().notNull().default('running'),
		model: text().notNull(),
		parent_turn_id: uuid(),
		subagent_id: text(),
		error: text(),
		started_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		/** Refreshed while a turn runs, so an abandoned turn can be told from a slow one. */
		heartbeat_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		ended_at: timestamp({ withTimezone: true })
	},
	{ description: 'Agent turns', record_label: 'model', system: true }
);

/**
 * One message in a session.
 *
 * `parts` holds the `UIMessage['parts']` array from `@tanstack/ai` verbatim — the agent transcript
 * carries the library's own message types rather than a parallel set of ours, so nothing has to be
 * translated on the way to the client.
 */
const _chat_message = systemTable(
	'chat_message',
	{
		chat_id: uuid()
			.references(() => _chat_session.norbital_id, { onDelete: 'cascade' })
			.notNull(),
		turn_id: uuid().references(() => _chat_turn.norbital_id, { onDelete: 'cascade' }),
		/** `system`, `user`, or `assistant`. */
		role: text().notNull(),
		seq: integer().notNull(),
		parts: jsonbColumn(JsonArraySchema),
		model: text(),
		/** Provider token accounting for the message that produced it, when the provider reported any. */
		usage: jsonbColumn(JsonObjectSchema),
		plan_mode: boolean().default(false).notNull(),
		/** `normal` or `summary`. */
		kind: text().notNull().default('normal'),
		/** `streaming`, `complete`, or `aborted`. */
		status: text().notNull().default('complete'),
		/** `live`, `queued`, `released`, or `removed`. */
		queue_status: text().notNull().default('live'),
		/** `step` or `turn`. */
		release_mode: text(),
		author_user_id: uuid().references(() => _user.norbital_id),
		author_display_name: text(),
		source_provider: text(),
		source_conversation_id: text(),
		source_message_id: text(),
		source_deleted_at: timestamp({ withTimezone: true })
	},
	{ description: 'Agent messages', record_label: 'role', system: true }
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
		chat_message_id: uuid().references(() => _chat_message.norbital_id, { onDelete: 'set null' }),
		answered_at: timestamp({ withTimezone: true })
	},
	{
		description: 'Channel inbound messages',
		record_label: 'external_message_id',
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
		system: true
	}
);

/**
 * Lifecycle events pod publishes to whichever host is driving it.
 *
 * Drained by the `queue` facility with the same claim/ack/fail protocol as the integration and
 * notification outboxes, so a host restart cannot silently lose one. `subject_hmac` carries a keyed
 * digest of the email rather than the address, and `seats` carries the resulting census rather than a
 * delta — at-least-once delivery plus delta counting would double-bill.
 */
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
		system: true
	}
);

export const approval_request = _approval_request;
export const requestor = _requestor;
export const chat_session = _chat_session;
export const chat_turn = _chat_turn;
export const chat_message = _chat_message;
export const channel_conversation = _channel_conversation;
export const channel_inbound_message = _channel_inbound_message;
export const invitation = _invitation;
export const host_event_outbox = _host_event_outbox;
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
	chat_turn: { table: chat_turn },
	chat_message: { table: chat_message },
	channel_conversation: { table: channel_conversation },
	channel_inbound_message: { table: channel_inbound_message }
} satisfies Record<SystemCollectionName, { table: PgTable }>;

export const platformRelations = defineRelations(platformTables, (r) => ({
	approval_request: {
		requestor: r.many.requestor({
			from: r.approval_request.norbital_id,
			to: r.requestor.approval_request_id
		})
	}
}));
