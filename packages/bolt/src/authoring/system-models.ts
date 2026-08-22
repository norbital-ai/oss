import { sql } from 'drizzle-orm';
import {
	bigint,
	bigserial,
	boolean,
	doublePrecision,
	integer,
	jsonb,
	uuid
} from 'drizzle-orm/pg-core';
import { compileModelTables } from './model-introspection.js';
import { defineModel, text, timestamp, type ModelIndex } from './models-schema.js';
import type { TransportIdentity } from '../runtime/envoys/transport-identity.js';

const systemIndex = (column: string): ModelIndex => ({ columns: [column] });

/** Better Auth's logical model names mapped to the platform collection each one uses. */
export const AUTH_MODELS = Object.freeze({
	user: 'bolt_auth_user',
	session: 'bolt_auth_session',
	account: 'bolt_auth_account',
	verification: 'bolt_auth_verification'
} as const);

/**
 * Collections the runtime owns and authored workspace code reads.
 *
 * Approval state is not private runtime bookkeeping: a workspace decides what "live" means by
 * filtering on `approval_id`, and its reports read `approval_request` directly for status,
 * timing, and which rows a request holds. Declaring them here — rather than as hand-written DDL —
 * keeps one source for the schema plan, the where compiler's column list, and lookup.
 *
 * They stay here because they are not a workspace's to redeclare. `Approvals` writes them in every
 * workspace, including one with no authored collections. `verify` checks these compiled models
 * against the database exactly as it checks tenant models.
 */

/** One open or closed approval flow over a collection mutation. */
const approvalRequestModel = defineModel(
	{
		collection_name: text().notNull(),
		record_id: text().notNull(),
		action: text().notNull(),
		status: text().notNull(),
		steps: jsonb().notNull(),
		locked_record_refs: jsonb().notNull(),
		closed_at: timestamp(),
		closed_by: text()
	},
	{
		history: false,
		indexes: [systemIndex('collection_name'), systemIndex('record_id'), systemIndex('status')]
	}
);

/** Links an approval request to the user who raised it. */
const requestorModel = defineModel(
	{
		approval_request_id: text().notNull(),
		user_id: text().notNull()
	},
	{
		history: false,
		indexes: [systemIndex('approval_request_id'), systemIndex('user_id')]
	}
);

/**
 * Identity, declared as collections rather than as DDL beside them.
 *
 * These four *are* Better Auth's tables. There is no second `user` shadowing an auth table and no
 * hand-written `create table` for them anywhere: they are ordinary runtime-owned collections, so the
 * schema plan creates them the way it creates `approval_request`, `verify` checks their columns like
 * any other, and a workspace relates to `user` with the same `id` every collection is keyed
 * by. The common model compiler builds Better Auth's Drizzle schema from these declarations too.
 *
 * They are the runtime's and not the workspace's for the reason the note above gives: identity
 * exists in every workspace, including one that authors no collections at all, so a template that
 * omitted the model — or renamed a column in it — would boot a runtime whose only writer has nowhere
 * to write.
 *
 * The prefix on the table names is deliberate. `user`, `session` and `account` are names a tenant's
 * own workspace is entitled to use, and a workspace with a `user` collection would otherwise share a
 * table with the auth system and corrupt both.
 */
const authUserModel = defineModel(
	{
		name: text({ search: true }).notNull(),
		/**
		 * One row per address, and the index is unique for two reasons that meet here.
		 *
		 * Better Auth already assumes it — it looks a person up by email and expects one answer — and
		 * admitting a workspace's first administrator depends on it: that write is an upsert on the
		 * address, made before the person exists, so `on conflict ("email")` needs something to
		 * conflict against. Without it the statement does not degrade, it fails, and the founder is
		 * left with a workspace they can sign into and cannot read. Nulls do not collide in a Postgres
		 * unique index, so the provisioner's addressless service row is unaffected.
		 */
		email: text({ search: true }).unique(),
		emailVerified: boolean().notNull().default(false),
		image: text(),
		/**
		 * Whether this person administers the workspace. `normal` or `admin`, and nothing else.
		 *
		 * Deliberately *not* a role. It used to sit beside a `kind` column that answered "is this a
		 * person or a service"; every row in this table is a person now — a static identity is minted
		 * in memory and never written here — so that column had one possible value and no reader, and
		 * it is gone.
		 *
		 * It is not a role because `subjectHasPolicy` matches a subject to a policy by role, and there
		 * is no policy called `admin` in any workspace, and a team that named one would confer
		 * nothing. The arrangement this replaces put the founder in every team the workspace
		 * mentioned, which made "administers the workspace" indistinguishable from "is simultaneously
		 * an employee, a supervisor, a manager and an HR controller"; any change to the ladder
		 * silently changed what an administrator was.
		 *
		 * Administration is a property of the person, so it lives on the person. `AccessControl`
		 * short-circuits on it before it consults a single policy.
		 *
		 * `sqlDefault` is what makes seeding safe: a row written by the seed loader or created by
		 * Better Auth on first sign-in is `normal` without anybody having to remember to say so.
		 */
		status: text().notNull().default('normal'),
		/** The workspace this subject belongs to — Bolt's concept, not Better Auth's. */
		tenantId: text(),
		/**
		 * The one team this person belongs to, or null.
		 *
		 * One, not many, and that is the simplification the rest of this design rests on: there is no
		 * union across memberships to resolve, no join table, and every combination of authority
		 * anybody actually holds has a name in `+teams.ts` that appears in a diff. Two people who
		 * need different authority belong to two teams; one person who needs a combination belongs to
		 * a team that is that combination.
		 *
		 * Nullable, because a person can exist before anybody has placed them — a founder admitted
		 * into an empty workspace, an address that has just verified a code. Such a subject holds no
		 * policies at all, which is the correct answer and a visible one.
		 */
		team_id: uuid(),
		/**
		 * The messaging identities this person has proven are theirs — a WhatsApp number, a Telegram
		 * handle — as `[{ type, verified, ...address }]`.
		 *
		 * This is what makes an inbound channel message attributable. A transport hands the runtime an
		 * address and nothing else, and `bolt_auth_user` held no address of any kind except `email`, so
		 * a channel declaring `audience: 'authenticated'` had literally nothing to authenticate a
		 * sender against — the audience was decorative.
		 *
		 * **It confers nothing.** A row here answers one question — is this sender someone we know —
		 * and never widens what the resulting turn may do: capability on a channel comes from the
		 * channel's declared `policy` and from nowhere else. A verified number belonging to a workspace
		 * administrator still reaches exactly what the channel declares, which is why this is an
		 * address book and not a credential.
		 *
		 * `verified` is stored rather than implied by the row existing, because the two are genuinely
		 * different states: an administrator recording a contractor's number is a claim, and only a
		 * completed proof of possession makes it an identity. `Channels.receive` matches on
		 * `verified === true` alone, so an unproven claim is inert rather than trusted.
		 *
		 * Json rather than its own collection: it is read only when a message arrives, always for one
		 * person at a time, and never queried across people. A join table would buy a query nothing
		 * asks.
		 */
		channels: jsonb().$type<ReadonlyArray<TransportIdentity>>()
	},
	{
		history: false,
		indexes: [systemIndex('tenantId'), systemIndex('team_id')]
	}
);

const authSessionModel = defineModel(
	{
		expiresAt: timestamp().notNull(),
		token: text().notNull(),
		ipAddress: text(),
		userAgent: text(),
		userId: uuid().notNull()
	},
	{
		history: false,
		sync: false,
		indexes: [systemIndex('token'), systemIndex('userId')]
	}
);

const authAccountModel = defineModel(
	{
		accountId: text().notNull(),
		providerId: text().notNull(),
		userId: uuid().notNull(),
		accessToken: text(),
		refreshToken: text(),
		idToken: text(),
		accessTokenExpiresAt: timestamp(),
		refreshTokenExpiresAt: timestamp(),
		scope: text(),
		password: text()
	},
	{
		history: false,
		sync: false,
		indexes: [systemIndex('userId')]
	}
);

const authVerificationModel = defineModel(
	{
		identifier: text().notNull(),
		value: text().notNull(),
		expiresAt: timestamp().notNull()
	},
	{ history: false, sync: false, indexes: [systemIndex('identifier')] }
);

/** Where bolt keeps the secret that signs its sessions, generated on first use. */
const authConfigModel = defineModel(
	{
		key: text().notNull(),
		value: text().notNull()
	},
	{ history: false, sync: false, indexes: [systemIndex('key')] }
);

/**
 * A team: who a person belongs to, and nothing about what that entitles them to.
 *
 * The split is the point, and it is the whole reason this collection can be a runtime row at all.
 * **Membership** changes constantly and belongs to an operator — somebody joins, somebody moves,
 * somebody leaves — so it is a row, edited from a dashboard, with no deploy. **Authority** is which
 * policies a team holds, and that is declared in the workspace's own `+teams.ts` and compiled into
 * the release. A row that granted a policy would be a privilege escalation performed with an
 * `update` statement, in a place no diff, no review and no type check can see.
 *
 * So a team row carries a name and a position, and the name is what binds it to the authored map.
 * A team whose name the release does not declare is inert rather than broken: it holds no policies,
 * it still works as an approval target, and a deploy that removes a team therefore takes its
 * authority away without orphaning anybody.
 *
 * `parent_id` is the hierarchy. It is nullable, self-referential, and `set null` on delete — a team
 * disappearing must not take its children's rows with it.
 */
const teamModel = defineModel(
	{
		/**
		 * The binding to the authored map, and to every `approvers` entry that names this team.
		 *
		 * Unique, and compared folded wherever it is compared. Today `roles` matched policies
		 * case-insensitively while `teams` matched approvers case-sensitively — two string arrays
		 * with two different rules, and the second one silently produced approvals nobody could
		 * decide. One rule, enforced by the index.
		 */
		name: text({ search: true }).notNull().unique(),
		description: text(),
		/** The parent in the hierarchy, or null at the root. See `resolveTeamPolicies`. */
		parent_id: uuid()
	},
	{ history: false }
);

/** A compiled cron declaration; the task runner is its only reader and writer. */
const scheduleModel = defineModel(
	{
		key: text().notNull().unique(),
		command: text().notNull(),
		crontab: text().notNull(),
		input: jsonb().notNull(),
		next_run_at: timestamp().notNull(),
		last_fired_at: timestamp()
	},
	{
		history: false,
		sync: false,
		indexes: [{ name: 'bolt_schedule_due', columns: ['next_run_at'] }]
	}
);

/** One unit of background work; the task runner is its only reader and writer. */
const taskModel = defineModel(
	{
		command: text().notNull(),
		input: jsonb().notNull(),
		status: text().notNull().default('pending'),
		run_at: timestamp().notNull().defaultNow(),
		attempts: integer().notNull().default(0),
		max_attempts: integer().notNull().default(12),
		effect_id: text().notNull().unique('bolt_task_effect_id'),
		result: jsonb(),
		error: text()
	},
	{
		history: false,
		sync: false,
		indexes: [
			{
				name: 'bolt_task_due',
				columns: ['run_at'],
				where: "status = 'pending'"
			}
		]
	}
);

const approvalStateModel = defineModel(
	{
		request_id: text().notNull().unique(),
		tenant_id: text().notNull(),
		state: jsonb().notNull()
	},
	{ history: false, sync: false }
);

const automationRunModel = defineModel(
	{
		effect_id: text().notNull().unique(),
		automation_name: text().notNull(),
		task_id: text(),
		state: text().notNull(),
		input: jsonb().notNull()
	},
	{ history: false, sync: false }
);

const auditModel = defineModel(
	{
		sequence: bigserial({ mode: 'number' }).unique(),
		kind: text().notNull(),
		subject_id: text().notNull(),
		payload: jsonb().notNull()
	},
	{ history: false, sync: false, indexes: [systemIndex('sequence')] }
);

const envoyRegistrationModel = defineModel(
	{ envoy_name: text().notNull().unique() },
	{ history: false, sync: false }
);

const envoyReceiptModel = defineModel(
	{
		sequence: bigserial({ mode: 'number' }).unique(),
		envoy_name: text().notNull(),
		conversation_id: text().notNull(),
		direction: text().notNull(),
		sender_id: text()
	},
	{
		history: false,
		sync: false,
		indexes: [
			{ name: 'bolt_envoy_receipts_window', columns: ['envoy_name', 'direction', 'created_at'] }
		]
	}
);

const envoyInboundModel = defineModel(
	{
		envoy_name: text().notNull(),
		conversation_id: uuid().notNull(),
		external_conversation_id: text().notNull(),
		external_message_id: text().notNull(),
		receipt_key: text().notNull().unique(),
		sender_external_id: text(),
		sender_display_name: text(),
		status: text().notNull(),
		answered_at: timestamp()
	},
	{ history: false, sync: false }
);

const integrationModel = defineModel(
	{
		name: text().notNull().unique(),
		enabled: boolean().notNull().default(true),
		cursor: jsonb(),
		lease_until: timestamp()
	},
	{ history: false, sync: false }
);

const integrationInboxModel = defineModel(
	{
		integration_name: text().notNull(),
		receipt_id: text().notNull(),
		binding_name: text(),
		payload: jsonb().notNull(),
		status: text().notNull().default('pending'),
		processed_at: timestamp(),
		received_at: timestamp().notNull().defaultNow()
	},
	{
		history: false,
		sync: false,
		indexes: [
			{
				name: 'bolt_integration_inbox_receipt',
				columns: ['integration_name', 'receipt_id'],
				unique: true
			}
		]
	}
);

const integrationOutboxModel = defineModel(
	{
		sequence: bigserial({ mode: 'number' }).unique(),
		integration_name: text().notNull(),
		binding_name: text().notNull(),
		collection_name: text().notNull(),
		record_id: text().notNull(),
		operation: text().notNull(),
		path: text(),
		payload: jsonb(),
		status: text().notNull().default('pending'),
		attempts: integer().notNull().default(0),
		next_attempt_at: timestamp().notNull().defaultNow(),
		last_status: integer(),
		last_error: text(),
		delivered_at: timestamp()
	},
	{
		history: false,
		sync: false,
		indexes: [
			{
				name: 'bolt_integration_outbox_due',
				columns: ['integration_name', 'status', 'next_attempt_at']
			},
			{
				name: 'bolt_integration_outbox_record',
				columns: ['collection_name', 'record_id', 'sequence']
			}
		]
	}
);

const conversationModel = defineModel(
	{
		conversation_id: text().notNull().unique(),
		parent_id: text(),
		agent_name: text().notNull(),
		user_id: text().notNull(),
		title: text(),
		verifier: jsonb(),
		visibility: text().notNull().default('personal'),
		envoy_key: text(),
		usage_cost_usd: doublePrecision().notNull().default(0),
		usage_cost_micro_units: bigint({ mode: 'number' }).notNull().default(0),
		usage_cost_currency: text(),
		usage_total_tokens: bigint({ mode: 'number' }).notNull().default(0),
		usage_turns_counted: integer().notNull().default(0),
		usage_turns_unreported: integer().notNull().default(0)
	},
	{
		history: false,
		indexes: [systemIndex('envoy_key'), systemIndex('parent_id')]
	}
);

const agentMessageModel = defineModel(
	{
		sequence: bigserial({ mode: 'number' }).unique(),
		conversation_id: text().notNull(),
		turn_id: text(),
		role: text().notNull(),
		content: jsonb().notNull()
	},
	{ history: false, indexes: [systemIndex('conversation_id')] }
);

const collectionHistoryModel = defineModel(
	{
		sequence: bigserial({ mode: 'number' }).unique(),
		collection_name: text().notNull(),
		record_id: text().notNull(),
		operation: text().notNull(),
		subject_id: text().notNull(),
		snapshot: jsonb()
	},
	{
		history: false,
		sync: false,
		indexes: [
			{
				name: 'bolt_collection_history_record',
				columns: ['collection_name', 'record_id', 'sequence']
			}
		]
	}
);

const externalSubjectModel = defineModel(
	{
		provider: text().notNull(),
		external_id: text().notNull(),
		user_id: text().notNull(),
		tenant_id: text().notNull(),
		team_id: uuid(),
		email: text()
	},
	{
		history: false,
		sync: false,
		indexes: [
			{
				name: 'bolt_external_subject_identity',
				columns: ['provider', 'external_id', 'tenant_id'],
				unique: true
			}
		]
	}
);

const invitationModel = defineModel(
	{
		invitation_id: text().notNull().unique(),
		tenant_id: text().notNull(),
		email: text().notNull(),
		invited_by: text().notNull(),
		accepted_by: text(),
		status: text().notNull()
	},
	{ history: false, sync: false }
);

const notificationModel = defineModel(
	{
		recipient: text().notNull(),
		payload: jsonb().notNull(),
		read: boolean().notNull().default(false),
		delivered_at: timestamp()
	},
	{ history: false, indexes: [systemIndex('recipient')] }
);

const schemaStateModel = defineModel(
	{
		fingerprint: text().notNull(),
		applied_at: timestamp().notNull().defaultNow()
	},
	{ history: false, sync: false }
);

const schemaMigrationModel = defineModel(
	{ tag: text().notNull().unique() },
	{ history: false, sync: false }
);

const syncOutboxModel = defineModel(
	{
		xid: bigint({ mode: 'number' })
			.notNull()
			.default(sql`pg_current_xact_id()::text::bigint`),
		sequence: bigserial({ mode: 'number' }).unique(),
		collection_name: text().notNull(),
		record_id: text().notNull(),
		operation: text().notNull(),
		record: jsonb()
	},
	{
		history: false,
		sync: false,
		indexes: [
			{ name: 'bolt_sync_outbox_cursor', columns: ['xid', 'sequence'], unique: true },
			{
				name: 'bolt_sync_outbox_record_idx',
				columns: ['collection_name', 'record_id', 'xid', 'sequence']
			}
		]
	}
);

const syncHorizonModel = defineModel(
	{
		singleton: boolean().notNull().default(true).unique(),
		xid: bigint({ mode: 'number' }).notNull().default(0),
		sequence: bigint({ mode: 'number' }).notNull().default(0)
	},
	{ history: false, sync: false }
);

const secretModel = defineModel(
	{
		tenant_id: text().notNull(),
		name: text().notNull(),
		value: text().notNull(),
		updated_by: text()
	},
	{
		history: false,
		sync: false,
		indexes: [{ name: 'bolt_secrets_tenant_name', columns: ['tenant_id', 'name'], unique: true }]
	}
);

const personalSecretModel = defineModel(
	{
		tenant_id: text().notNull(),
		user_id: text().notNull(),
		name: text().notNull(),
		value: text().notNull()
	},
	{
		history: false,
		sync: false,
		indexes: [
			{
				name: 'bolt_personal_secrets_owner_name',
				columns: ['tenant_id', 'user_id', 'name'],
				unique: true
			}
		]
	}
);

const workspaceIdentitySettingsModel = defineModel(
	{
		tenant_id: text().notNull().unique(),
		settings: jsonb().notNull().default({})
	},
	{ history: false, sync: false }
);

export const SYSTEM_COLLECTION_MODELS = Object.freeze({
	approval_request: approvalRequestModel,
	requestor: requestorModel,
	bolt_auth_user: authUserModel,
	bolt_auth_session: authSessionModel,
	bolt_auth_account: authAccountModel,
	bolt_auth_verification: authVerificationModel,
	bolt_auth_config: authConfigModel,
	bolt_team: teamModel,
	chat_session: conversationModel,
	chat_message: agentMessageModel,
	bolt_notifications: notificationModel
});

export const INTERNAL_SYSTEM_MODELS = Object.freeze({
	bolt_approvals: approvalStateModel,
	bolt_automation_runs: automationRunModel,
	bolt_audit: auditModel,
	bolt_envoy_registrations: envoyRegistrationModel,
	bolt_envoy_receipts: envoyReceiptModel,
	bolt_envoy_inbound: envoyInboundModel,
	bolt_integrations: integrationModel,
	bolt_integration_inbox: integrationInboxModel,
	bolt_integration_outbox: integrationOutboxModel,
	bolt_collection_history: collectionHistoryModel,
	bolt_external_subjects: externalSubjectModel,
	bolt_invitations: invitationModel,
	bolt_schema_state: schemaStateModel,
	__drizzle_migrations: schemaMigrationModel,
	bolt_sync_outbox: syncOutboxModel,
	bolt_sync_horizon: syncHorizonModel,
	bolt_secrets: secretModel,
	bolt_personal_secrets: personalSecretModel,
	bolt_workspace_identity_settings: workspaceIdentitySettingsModel,
	bolt_schedule: scheduleModel,
	bolt_task: taskModel
});

export const SYSTEM_MODELS = Object.freeze({
	...SYSTEM_COLLECTION_MODELS,
	...INTERNAL_SYSTEM_MODELS
});

/** Physical tables compiled from the same declarations used by the runtime collection catalog. */
export const SYSTEM_MODEL_TABLES = Object.freeze(compileModelTables(SYSTEM_MODELS));
