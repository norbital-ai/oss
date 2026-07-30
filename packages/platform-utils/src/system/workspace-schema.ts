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
	norbital_sys_period: text()
		.notNull()
		.default(sql`tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text)`),
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
		role: text().default('member'),
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

const _agent_run_step = systemTable(
	'agent_run_step',
	{
		owner_user_id: uuid()
			.references(() => _user.norbital_id)
			.notNull(),
		automation_run_id: uuid()
			.references(() => _automation_run.norbital_id)
			.notNull(),
		sequence: integer().notNull(),
		kind: text().notNull(),
		role: text(),
		content: text(),
		tool_call_id: text(),
		tool_name: text(),
		tool_input: jsonbColumn(JsonObjectSchema),
		tool_output: jsonbColumn(JsonObjectSchema),
		usage: jsonbColumn(JsonObjectSchema)
	},
	{
		description: 'Insert-only workspace agent transcript steps',
		record_label: 'kind',
		system: true
	}
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
		policy_id: uuid()
			.references(() => _policy.norbital_id)
			.notNull()
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

export const approval_request = _approval_request;
export const requestor = _requestor;
export const automation_run = _automation_run;
export const agent_run_step = _agent_run_step;
export const user = _user;
export const team = _team;
export const policy = _policy;
export const audit_event = _audit_event;
export const integration_outbox = _integration_outbox;
export const notification_outbox = _notification_outbox;
export const notification = _notification;
export const document_asset = _document_asset;
export const team_members = _team_members;

export const platformTables = {
	approval_request,
	requestor,
	automation_run,
	agent_run_step,
	user,
	team,
	policy,
	audit_event,
	integration_outbox,
	notification_outbox,
	notification,
	document_asset,
	team_members
} as const;

export const systemTables = {
	approval_request: { table: approval_request },
	requestor: { table: requestor },
	automation_run: { table: automation_run },
	agent_run_step: { table: agent_run_step },
	user: { table: user },
	team: { table: team },
	policy: { table: policy },
	audit_event: { table: audit_event },
	integration_outbox: { table: integration_outbox },
	notification_outbox: { table: notification_outbox },
	notification: { table: notification },
	document_asset: { table: document_asset },
	team_members: { table: team_members }
} satisfies Record<SystemCollectionName, { table: PgTable }>;

export const platformRelations = defineRelations(platformTables, (r) => ({
	approval_request: {
		requestor: r.many.requestor({
			from: r.approval_request.norbital_id,
			to: r.requestor.approval_request_id
		})
	}
}));
