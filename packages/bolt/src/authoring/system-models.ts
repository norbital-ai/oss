import { sql } from 'drizzle-orm';
import { bigserial, boolean, integer, jsonb, uuid } from 'drizzle-orm/pg-core';
import { compileModelTables } from './model-introspection.js';
import { defineModel, instant, text, type ModelIndex } from './models-schema.js';
import type { TransportIdentity } from '../runtime/envoys/transport-identity.js';

const systemIndex = (column: string): ModelIndex => ({ columns: [column] });

/** Better Auth's logical model names mapped to the platform collection each one uses. */
export const AUTH_MODELS = Object.freeze({
	user: 'user',
	session: 'session',
	account: 'account',
	verification: 'verification'
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
		/** Folded team names allowed to decide the active step; queryable without inspecting private state. */
		approver_teams: jsonb()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** Folded team names allowed to supersede the active flow. */
		superseder_teams: jsonb()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** Written in the same transaction as the approved graph; approval alone is not settlement. */
		applied_at: instant(),
		closed_at: instant(),
		closed_by: text()
	},
	{
		history: false,
		indexes: [
			systemIndex('collection_name'),
			systemIndex('record_id'),
			systemIndex('status'),
			{ columns: ['approver_teams'], method: 'gin' },
			{ columns: ['superseder_teams'], method: 'gin' }
		]
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
 * Their short names are deliberate: identity is part of every workspace's ordinary model rather
 * than a second, prefixed namespace. Those names are therefore reserved by the runtime; an authored
 * collection cannot replace one of these declarations with a different shape.
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
		 * address and nothing else, and `user` held no address of any kind except `email`, so
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
		 * completed proof of possession makes it an identity. `Envoys.receive` matches on
		 * `verified === true` alone, so an unproven claim is inert rather than trusted.
		 *
		 * Json rather than its own collection: it is read only when a message arrives, always for one
		 * person at a time, and never queried across people. A join table would buy a query nothing
		 * asks.
		 */
		channels: jsonb().$type<ReadonlyArray<TransportIdentity>>()
	},
	{
		// People and teams are the two platform rows whose changes are somebody's decision — who
		// administers, who belongs where — so they keep history like a tenant collection does. The
		// rest of the platform (conversations, turns, runs, audit) is bookkeeping and keeps none.
		history: true,
		indexes: [systemIndex('tenantId'), systemIndex('team_id')],
		// Platform tables the schema plan owns: people and teams are found by name, never by meaning,
		// and no record of who someone is goes to an embedding provider.
		embedding: false
	}
);

const authSessionModel = defineModel(
	{
		expiresAt: instant().notNull(),
		token: text().notNull(),
		ipAddress: text(),
		userAgent: text(),
		userId: uuid().notNull()
	},
	{
		history: false,
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
		accessTokenExpiresAt: instant(),
		refreshTokenExpiresAt: instant(),
		scope: text(),
		password: text()
	},
	{
		history: false,
		indexes: [systemIndex('userId')]
	}
);

const authVerificationModel = defineModel(
	{
		identifier: text().notNull(),
		value: text().notNull(),
		expiresAt: instant().notNull()
	},
	{ history: false, indexes: [systemIndex('identifier')] }
);

/** Where bolt keeps the secret that signs its sessions, generated on first use. */
const authConfigModel = defineModel(
	{
		key: text().notNull(),
		value: text().notNull()
	},
	{ history: false, indexes: [systemIndex('key')] }
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
	{ history: true, embedding: false }
);

/** A compiled cron declaration; the task runner is its only reader and writer. */
const scheduleModel = defineModel(
	{
		key: text().notNull().unique(),
		command: text().notNull(),
		crontab: text().notNull(),
		input: jsonb().notNull(),
		next_run_at: instant().notNull(),
		last_fired_at: instant()
	},
	{
		history: false,
		indexes: [{ name: 'bolt_schedule_due', columns: ['next_run_at'] }]
	}
);

/** One durable unit of scheduled or runtime-authored background work. */
const taskModel = defineModel(
	{
		command: text().notNull(),
		input: jsonb().notNull(),
		status: text().notNull().default('pending'),
		/** When pending work becomes eligible. Retries move this forward without sleeping a worker. */
		run_at: instant().notNull().defaultNow(),
		/** The claim fence for a running attempt. Expiry makes an interrupted attempt recoverable. */
		lease_expires_at: instant(),
		/** Counted at claim time so a host crash still consumes one bounded attempt. */
		attempts: integer().notNull().default(0),
		max_attempts: integer().notNull().default(12),
		effect_id: text().notNull().unique('bolt_task_effect_id'),
		/** Latest automation progression; null until the run reports one. */
		progress: jsonb(),
		progress_sequence: integer().notNull().default(0),
		progress_updated_at: instant(),
		result: jsonb(),
		error: text()
	},
	{
		history: false,
		indexes: [
			{
				name: 'bolt_task_pending_due',
				columns: ['run_at'],
				where: "status = 'pending'"
			},
			{
				name: 'bolt_task_running_lease',
				columns: ['lease_expires_at'],
				where: "status = 'running'"
			}
		]
	}
);

/** One durable Task. Lifecycle and its sole active-run fence live together on this row. */
const conversationModel = defineModel(
	{
		workbench_id: text().notNull(),
		subject_id: text().notNull(),
		agent_id: text().notNull(),
		audience: text().notNull(),
		parent_id: uuid(),
		title: text(),
		status: text().notNull(),
		active_plan_id: uuid(),
		active_turn_id: uuid(),
		/**
		 * The agent's checklist for this conversation, set and read through the `todo` tool.
		 *
		 * It lives here because it is one current list, not a history: the agent replaces it, reads it
		 * back, and every reader wants the same latest value. Recovering it by walking the transcript
		 * for the newest successful `todo` tool-result — which is what this replaced — made a
		 * *derived* fact out of a stored one, and left two scanners (runtime and panel) to agree by
		 * hand.
		 */
		todos: jsonb()
	},
	{
		history: false,
		indexes: [
			{
				name: 'conversation_subject_route',
				columns: ['workbench_id', 'subject_id', 'status', 'created_at']
			},
			{
				name: 'conversation_workbench_route',
				columns: ['workbench_id', 'audience', 'status', 'created_at']
			},
			systemIndex('parent_id'),
			systemIndex('active_plan_id'),
			{
				name: 'conversation_active_run',
				columns: ['active_turn_id'],
				unique: true
			}
		]
	}
);

/** One immutable revision of the Task objective and verification contract. */
const planModel = defineModel(
	{
		conversation_id: uuid().notNull(),
		revision: integer().notNull(),
		checkpoint_sequence: integer().notNull(),
		body: text().notNull(),
		status: text().notNull()
	},
	{
		history: false,
		indexes: [
			{
				name: 'plan_task_revision',
				columns: ['conversation_id', 'revision'],
				unique: true
			},
			{ name: 'plan_task_status', columns: ['conversation_id', 'status', 'revision'] }
		]
	}
);

/**
 * One complete encoded Effect Prompt message. Parts are never normalized into another table.
 *
 * `supersedes_id` is the message's only mutation route and it never mutates anything: a revised user
 * message is a *new* row naming the revision it replaces, exactly as a new Plan revision supersedes
 * the previous one. The superseded row stays byte-for-byte durable and readable; only the projection
 * that feeds the model skips it. The route is unique so one revision can never fork a message into
 * two live heads.
 */
const conversationMessageModel = defineModel(
	{
		conversation_id: uuid().notNull(),
		sequence: integer().notNull(),
		turn_id: uuid(),
		author: jsonb().notNull(),
		message: jsonb().notNull(),
		semantic_hash: text().notNull(),
		annotation: jsonb(),
		supersedes_id: uuid(),
		/**
		 * The message queue, which is the transcript.
		 *
		 * A message somebody sent and no turn has answered is `queued`; the turn that answers it marks
		 * it `consumed`. What that turn needs in order to answer — the mode it runs in, the model it
		 * runs on, and how it orders against other waiting messages — rides here, because those
		 * describe this message rather than a separate work item about it. `null` is a message nobody
		 * is waiting on an answer to: an assistant reply, a tool result, a system note.
		 */
		state: text(),
		mode: text(),
		priority: text(),
		model_id: text()
	},
	{
		history: false,
		indexes: [
			{
				name: 'conversation_message_sequence',
				columns: ['conversation_id', 'sequence'],
				unique: true
			},
			{ name: 'conversation_message_turn', columns: ['turn_id', 'sequence'] },
			// What a turn asks for at every boundary: this conversation's waiting messages, in the
			// order it should answer them.
			{
				name: 'conversation_message_queue',
				columns: ['conversation_id', 'state', 'priority', 'sequence']
			},
			{ name: 'conversation_message_supersedes', columns: ['supersedes_id'], unique: true },
			{
				name: 'conversation_message_identity',
				columns: ['conversation_id', 'semantic_hash'],
				unique: true
			},
			{ name: 'conversation_message_content_route', columns: ['message'], method: 'gin' },
			{ name: 'conversation_message_annotation_route', columns: ['annotation'], method: 'gin' }
		]
	}
);

/** One fenced execution attempt with one immutable authority snapshot. */
const turnModel = defineModel(
	{
		conversation_id: uuid().notNull(),
		/** The queued message this turn was started to answer. */
		input_message_id: uuid().notNull(),
		mode: text().notNull(),
		phase: text().notNull(),
		input_through_sequence: integer().notNull(),
		model_id: text().notNull(),
		/**
		 * The model's context window, in tokens, as the catalog stated it when this turn was claimed.
		 *
		 * Stored rather than looked up, for the reason `capability_snapshot` is: a turn is judged by
		 * what was true when it started. Compaction fires against this number, so a turn that
		 * compacted has to be able to say what bound it was compacting to — a host that later
		 * re-registers the same model with a different window must not change the reading of a turn
		 * that already ran.
		 */
		context_window_tokens: integer().notNull(),
		capability_snapshot: jsonb().notNull(),
		status: text().notNull()
	},
	{
		history: false,
		indexes: [
			{ name: 'turn_conversation_status', columns: ['conversation_id', 'status', 'created_at'] },
			// One turn per queued message: the turn that answers a message is the only turn that
			// answers it, and this is what says so.
			{ name: 'turn_input_message', columns: ['input_message_id'], unique: true }
		]
	}
);

/** One immutable exact observation and settlement record per provider attempt. */
const turnUsageModel = defineModel(
	{
		call_id: text().notNull().unique(),
		turn_id: uuid().notNull(),
		provider: text().notNull(),
		model: text().notNull(),
		operation: text().notNull(),
		usage: jsonb(),
		charge: jsonb(),
		charge_source: text(),
		pricing_version: text(),
		settlement_id: text().notNull().unique(),
		settlement_state: text().notNull()
	},
	{
		history: false,
		indexes: [
			{ name: 'turn_usage_run_route', columns: ['turn_id', 'created_at'] },
			systemIndex('settlement_state')
		]
	}
);

/**
 * The safe, sync-visible lifecycle of one automation invocation.
 *
 * `bolt_task.input` can contain secrets and arbitrary command payloads, so the record itself must
 * never replicate. Direct invocations write this row themselves; a database trigger projects cron
 * occurrences from `bolt_task`. Clients receive only lifecycle, progress, error and typed result.
 */ const automationRunModel = defineModel(
	{
		task_id: text().notNull().unique(),
		name: text().notNull(),
		status: text().notNull(),
		progress: jsonb(),
		progress_sequence: integer().notNull().default(0),
		progress_updated_at: instant(),
		result: jsonb(),
		error: text()
	},
	{
		history: false,
		indexes: [systemIndex('task_id'), systemIndex('name'), systemIndex('status')]
	}
);

/**
 * What the runtime told about itself: one row per telemetry record — a turn started or settled,
 * a model call with its tokens and charge, a tool call with its time, a write with its statement
 * count, a dispatch that failed — kept for the window the host configures and readable like any
 * system collection. The shape follows the OpenTelemetry log record: `severity`, `event` is the
 * body, `attributes` the fields, and the ids that join a record to its invocation, conversation
 * and turn are columns so a query can narrow on them.
 */
const telemetryModel = defineModel(
	{
		at: instant().notNull(),
		severity: text().notNull(),
		event: text().notNull(),
		invocation: text(),
		conversation: text(),
		turn: text(),
		attributes: jsonb().notNull()
	},
	{
		history: false,
		indexes: [
			systemIndex('at'),
			systemIndex('conversation'),
			systemIndex('turn'),
			systemIndex('severity')
		]
	}
);

const approvalStateModel = defineModel(
	{
		request_id: text().notNull().unique(),
		tenant_id: text().notNull(),
		state: jsonb().notNull()
	},
	{ history: false }
);

const auditModel = defineModel(
	{
		sequence: bigserial({ mode: 'number' }).unique(),
		kind: text().notNull(),
		subject_id: text().notNull(),
		/** Query key for approval events; other audit kinds leave it null. */
		request_id: text(),
		payload: jsonb().notNull()
	},
	{ history: false, indexes: [systemIndex('sequence'), systemIndex('request_id')] }
);

/**
 * A channel's history: every message the provider shows, both directions, kept by a one-way sync
 * (channels.md §7). Identity is the provider's message id; an edit converges the row, a sender's
 * delete tombstones it (its text and attachments leave every read), and nothing but the channel's
 * own sync writes here — read-only to every workspace surface.
 */
const channelMessageModel = defineModel(
	{
		channel: text().notNull(),
		transport: text().notNull(),
		/** The provider conversation: a chat id, a mail thread's root Message-ID, an http delivery. */
		conversation_id: text().notNull(),
		conversation_kind: text().notNull(),
		direction: text().notNull(),
		/** `live` | `sync`: only a live inbound row can be answered. */
		origin: text().notNull(),
		provider_message_id: text().notNull(),
		version: text().notNull(),
		sender_id: text(),
		sender_name: text(),
		sent_at: instant().notNull(),
		invocation: text(),
		subject: text(),
		text: text().notNull(),
		/** The whole normalised envelope, attachment bytes excluded. */
		envelope: jsonb().notNull(),
		attachments: jsonb()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** The outbox row a sent message came from, for event correlation. */
		outbox_id: text(),
		/** Whether this inbound row asks the channel's envoy for an answer. */
		addressed: boolean().notNull().default(false),
		/** The agent conversation the channel's envoy admitted this row to. */
		agent_conversation_id: text(),
		answered_at: instant(),
		/** Null is unread; `sync` for history, the tool call's effect id for an on-demand read. */
		read_by: text(),
		edited_at: instant(),
		deleted_at: instant()
	},
	{
		history: false,
		indexes: [
			{ name: 'channel_messages_identity', columns: ['channel', 'provider_message_id'], unique: true },
			{ name: 'channel_messages_conversation', columns: ['channel', 'conversation_id', 'sent_at'] },
			{ name: 'channel_messages_agent', columns: ['agent_conversation_id', 'direction', 'sent_at'] },
			{
				name: 'channel_messages_unanswered',
				columns: ['channel', 'conversation_id', 'sent_at'],
				where: "addressed and answered_at is null and deleted_at is null and direction = 'inbound' and origin = 'live'"
			}
		]
	}
);

/** The history sync's lifecycle per channel, as the host last reported it. */
const channelStateModel = defineModel(
	{
		channel: text().notNull().unique(),
		state: text().notNull().default('unlinked'),
		horizon: text(),
		last_inbound_at: instant()
	},
	{ history: false }
);

/**
 * The channel outbox: every outbound message — an envoy reply, a notification, an outbound rule, an
 * `api.channels.<n>.send` — committed in the transaction that caused it, then drained, retried and
 * settled here. One delivery record for every sender.
 */
const channelOutboxModel = defineModel(
	{
		sequence: bigserial({ mode: 'number' }).unique(),
		channel: text().notNull(),
		transport: text().notNull(),
		/** `pending` | `inflight` | `sent` | `failed` | `skipped`. */
		status: text().notNull().default('pending'),
		message: jsonb(),
		/** A notification's recipient user id; the address is resolved at send time. */
		recipient_user: text(),
		/** The conversation an envoy reply belongs to, so the sent message lands in its history. */
		conversation_id: text(),
		/** The record an outbound rule sent from; events patch it. */
		source_collection: text(),
		source_record_id: text(),
		rule: text(),
		thread_key: text(),
		provider_message_id: text(),
		attempts: integer().notNull().default(0),
		next_attempt_at: instant().notNull().defaultNow(),
		last_error: text(),
		sent_at: instant()
	},
	{
		history: false,
		indexes: [
			{ name: 'bolt_channel_outbox_due', columns: ['channel', 'status', 'next_attempt_at'] },
			{ name: 'bolt_channel_outbox_provider', columns: ['channel', 'provider_message_id'] },
			{ name: 'bolt_channel_outbox_thread', columns: ['channel', 'thread_key'] }
		]
	}
);

/** One sync's lifecycle, cursors and last report (integrations.md §7). */
const syncStateModel = defineModel(
	{
		/** `<integration>.<sync>`. */
		sync: text().notNull().unique(),
		state: text().notNull().default('unlinked'),
		detail: text(),
		/** The sweep in progress: `{ id, mode, page, pageCursor, counts, samples }`. */
		sweep: jsonb(),
		changes_cursor: text(),
		report: jsonb(),
		lease_until: instant()
	},
	{ history: false }
);

/**
 * The link between a local row and a remote identity, and the shadow both sides last agreed on.
 *
 * `shadow` holds the synced fields in their local form; `version` the source's version token (or a
 * content hash). A row is `linked`, `pending_link` (created locally, not yet acknowledged) or
 * `local_only`. `swept` is the id of the last sweep that saw the remote record: a full sweep that
 * finishes without touching a linked row is the only place absence becomes a delete.
 */
const syncLinkModel = defineModel(
	{
		sync: text().notNull(),
		record_id: text().notNull(),
		identity: text(),
		status: text().notNull(),
		shadow: jsonb()
			.notNull()
			.default(sql`'{}'::jsonb`),
		version: text(),
		swept: text()
	},
	{
		history: false,
		indexes: [
			{ name: 'bolt_integration_links_record', columns: ['sync', 'record_id'], unique: true },
			{ name: 'bolt_integration_links_identity', columns: ['sync', 'identity'], unique: true },
			{ name: 'bolt_integration_links_swept', columns: ['sync', 'swept'] }
		]
	}
);

/**
 * Local intent to push, one row per record: the marker is written in the local write's own
 * transaction, and the change itself is re-derived from the row and its shadow when it is pushed,
 * so later edits coalesce into it and a dead letter is repaired from state, not a stale payload.
 */
const syncOutboxModel = defineModel(
	{
		sync: text().notNull(),
		record_id: text().notNull(),
		/** Bumped by every local write; a push settles only the revision it claimed. */
		revision: integer().notNull().default(1),
		status: text().notNull().default('pending'),
		attempts: integer().notNull().default(0),
		next_attempt_at: instant().notNull().defaultNow(),
		last_status: integer(),
		last_error: text()
	},
	{
		history: false,
		indexes: [
			{ name: 'bolt_integration_pushes_record', columns: ['sync', 'record_id'], unique: true },
			{ name: 'bolt_integration_pushes_due', columns: ['sync', 'status', 'next_attempt_at'] }
		]
	}
);

/** Every conflict a declared rule resolved: nothing about a conflict is silent (§8.3). */
const syncConflictModel = defineModel(
	{
		sync: text().notNull(),
		record_id: text().notNull(),
		field: text().notNull(),
		base: jsonb(),
		local: jsonb(),
		remote: jsonb(),
		rule: text().notNull(),
		winner: text().notNull()
	},
	{ history: false, indexes: [{ name: 'bolt_integration_conflicts_sync', columns: ['sync', 'created_at'] }] }
);

const collectionHistoryModel = defineModel(
	{
		sequence: bigserial({ mode: 'number' }).unique(),
		collection_name: text().notNull(),
		record_id: text().notNull(),
		operation: text().notNull(),
		subject_id: text().notNull(),
		/** Durable invocation identity. Null only for history written before this column existed. */
		effect_id: text(),
		snapshot: jsonb()
	},
	{
		history: false,
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
		status: text().notNull(),
		/** Nullable only for invitations created before expiring links existed. */
		expires_at: instant()
	},
	{ history: false }
);

/**
 * One offer to attach a messaging address to whichever account claims it.
 *
 * Shaped after `invitationModel` on purpose, down to `status`: claiming is a conditional update on
 * `status = 'pending'`, so the database itself makes a link single-use and a replay finds nothing to
 * claim. That matters more here than for an email invitation, because this token travels over a
 * channel the recipient can forward.
 *
 * `sender_id` is the canonical transport identity the message arrived from, stored so the claim
 * writes the address the host actually saw rather than one the browser asked for. `expires_at`
 * bounds how long a forwarded link stays dangerous; `claimed_by` records which account won it, so a
 * number that ends up on the wrong account can be traced rather than guessed at.
 */
const channelLinkModel = defineModel(
	{
		link_id: text().notNull().unique(),
		tenant_id: text().notNull(),
		envoy: text().notNull(),
		transport: text().notNull(),
		sender_id: text().notNull(),
		status: text().notNull(),
		claimed_by: text(),
		expires_at: instant().notNull()
	},
	{ history: false }
);

const notificationModel = defineModel(
	{
		recipient: text().notNull(),
		payload: jsonb().notNull(),
		read: boolean().notNull().default(false),
		delivered_at: instant()
	},
	{ history: false, indexes: [systemIndex('recipient')] }
);

/**
 * One row per browser that asked for pushes: the push service endpoint and the keys the browser
 * minted for it. `recipient` is the notification recipient — a user id — so a drain fans out by
 * the same column the inbox is addressed by. The endpoint is the identity: a browser that
 * re-subscribes replaces its row, and a push service answering 404/410 deletes it.
 */
const pushSubscriptionModel = defineModel(
	{
		recipient: text().notNull(),
		endpoint: text().notNull().unique(),
		keys: jsonb().notNull()
	},
	{ history: false, indexes: [systemIndex('recipient')] }
);

const schemaStateModel = defineModel(
	{
		fingerprint: text().notNull(),
		applied_at: instant().notNull().defaultNow()
	},
	{ history: false }
);

const schemaMigrationModel = defineModel({ tag: text().notNull().unique() }, { history: false });

const secretModel = defineModel(
	{
		tenant_id: text().notNull(),
		name: text().notNull(),
		value: text().notNull(),
		updated_by: text()
	},
	{
		history: false,
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
	{ history: false }
);

/**
 * The tenant-database authority for browser mutation replay.
 *
 * Scope columns are all host/authentication facts. None is accepted from the command payload. The
 * request digest detects a client that reuses a key for different work, while `outcome` is the
 * compact, typed result needed to answer a retry without running authored hooks again.
 */
const browserMutationModel = defineModel(
	{
		tenant_id: text().notNull(),
		environment: text().notNull(),
		principal_id: text().notNull(),
		authority_id: text().notNull(),
		command: text().notNull(),
		idempotency_key: text().notNull(),
		partition_key: text().notNull(),
		schema_fingerprint: text().notNull(),
		request_digest: text().notNull(),
		status: text().notNull(),
		outcome: jsonb(),
		issued_at: instant().notNull(),
		lease_expires_at: instant(),
		expires_at: instant().notNull()
	},
	{
		history: false,
		indexes: [
			{
				name: 'bolt_browser_mutation_scope_key',
				columns: [
					'tenant_id',
					'environment',
					'principal_id',
					'authority_id',
					'command',
					'idempotency_key'
				],
				unique: true
			},
			{ name: 'bolt_browser_mutation_expiry', columns: ['expires_at'] }
		]
	}
);

export const SYSTEM_COLLECTION_MODELS = Object.freeze({
	approval_request: approvalRequestModel,
	requestor: requestorModel,
	user: authUserModel,
	session: authSessionModel,
	account: authAccountModel,
	verification: authVerificationModel,
	auth_config: authConfigModel,
	team: teamModel,
	conversation: conversationModel,
	plan: planModel,
	conversation_message: conversationMessageModel,
	turn: turnModel,
	turn_usage: turnUsageModel,
	automation_run: automationRunModel,
	telemetry: telemetryModel,
	bolt_notifications: notificationModel,
	channel_messages: channelMessageModel
});

export const INTERNAL_SYSTEM_MODELS = Object.freeze({
	bolt_approvals: approvalStateModel,
	bolt_audit: auditModel,
	bolt_channel_state: channelStateModel,
	bolt_channel_outbox: channelOutboxModel,
	bolt_integration_state: syncStateModel,
	bolt_integration_links: syncLinkModel,
	bolt_integration_pushes: syncOutboxModel,
	bolt_integration_conflicts: syncConflictModel,
	bolt_collection_history: collectionHistoryModel,
	bolt_external_subjects: externalSubjectModel,
	bolt_invitations: invitationModel,
	bolt_channel_links: channelLinkModel,
	bolt_schema_state: schemaStateModel,
	__drizzle_migrations: schemaMigrationModel,
	bolt_secrets: secretModel,
	bolt_personal_secrets: personalSecretModel,
	bolt_workspace_identity_settings: workspaceIdentitySettingsModel,
	bolt_browser_mutation: browserMutationModel,
	bolt_schedule: scheduleModel,
	bolt_task: taskModel,
	bolt_push_subscriptions: pushSubscriptionModel
});

export const SYSTEM_MODELS = Object.freeze({
	...SYSTEM_COLLECTION_MODELS,
	...INTERNAL_SYSTEM_MODELS
});

/** Physical tables compiled from the same declarations used by the runtime collection catalog. */
export const SYSTEM_MODEL_TABLES = Object.freeze(compileModelTables(SYSTEM_MODELS));
