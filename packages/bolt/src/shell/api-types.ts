// The shell routes' client (`shell_api`, B.2) as Effects (D9): each member answers its value or fails with `ShellError`,
// today's `Answer<T>` refusal (the wire error, its HTTP status, and on a signed-out boot the workspace the access pages
// show). Agent acts answer their `Outcome`: a refusal there is a business answer the panel renders. Pinned for
// R6a (the implementation in `runtime.ts`) and R6b (the Svelte components that run it on the ui edge).
import { Schema, type Effect } from 'effect';
import type { FileRef } from '@norbital-ai/store/kind';
import type { Attachment } from '../decl/runtime/integration.ts';
import { SyncDeadLetter, SyncHealth } from '../engine/sync/health-schema.ts';
import type { Json } from '../decl/values.ts';
import type { ActOutcome, AiModel } from '../engine/contracts.ts';
import { AgentSettings } from '../engine/agent/settings.ts';
import { FileRef as ConversationFile } from '../engine/agent/schema.ts';
import type { InboxRequest } from '../engine/approvals/inbox.ts';
import { Snapshot as ApprovalSnapshot } from '../engine/approvals/snapshot.ts';
import type { RunView } from '../engine/runs/rows.ts';
import { RunAttempt, RunError } from '../engine/runs/attempt.ts';
import {
	AgentConversation,
	AgentRow,
	Driver,
	EngineActorSchema,
	NoticeRow,
	RunTriggerViewSchema
} from '../protocol/schema.ts';
import { ApprovalViewSchema } from '../protocol/approval-view.ts';
import type { PageResult } from '../protocol/schema.ts';
import { Diagnostic } from '../protocol/diagnostic.ts';
import { MigrationImpact } from '../protocol/migration-impact.ts';
import {
	AutomationExposureSchema,
	FieldsSchema,
	ModelExposureSchema
} from '../protocol/public-page.ts';
import type { PushBody } from '../protocol/wire.ts';
import type { integration_client, integration_offers } from '../page/integrations.ts';
import type { LogQuery, LogRow } from '../engine/contracts.ts';
import type { AuditPage, AuditQuery, AuditRecord } from '../protocol/audit.ts';
import type { Settings } from './settings/data.ts';
import type { SignInMethods } from './host.ts';
import type { NavNode, ShellBoot } from './nav.ts';
import { ManifestItemSchema } from './finder/manifest.ts';
import { ReadCatalog } from '../protocol/read-answer.ts';
import { OperationOutputs } from '../protocol/output-contract.ts';
import { StudioTestRun } from './studio/test-results.ts';
import {
	StudioOp,
	type StudioFile,
	type StudioView
} from './studio/model.ts';
import { StudioInspection, type StudioInspectInput } from './studio/inspection.ts';

const Optional = Schema.optionalKey(Schema.String);
export const RestartChat = Schema.Struct({
	conversation: Schema.String,
	message: AgentRow,
	mode: Schema.NullOr(Schema.Literals(['agent', 'plan', 'compact']))
});
/** A workspace as the access pages show it (`ShellBoot['workspace']`): name, locale, zone, logo, environment, handle. */
export const ShellWorkspace = Schema.Struct({
	name: Schema.String,
	locale: Schema.String,
	tz: Schema.String,
	logo: Optional,
	environment: Optional,
	handle: Optional,
	apex: Optional,
	live: Optional,
	organization: Schema.optionalKey(Schema.Literal(true))
});
/** A shell route refused the call: its code and message, the HTTP status (`0`: unreachable), and the workspace when signed out. */
export class ShellError extends Schema.TaggedError<ShellError>()('ShellError', {
	code: Schema.String,
	message: Schema.String,
	status: Schema.Number,
	workspace: Schema.optionalKey(ShellWorkspace)
}) {}

type Call<A> = Effect.Effect<A, ShellError>;
/** Declared file outputs on a run whose result the caller may read in full. */
export type RunDetail = RunView & {
	readonly files?: readonly FileRef[];
	/** The run's latest log lines, oldest first, or why the store could not answer; only for a reader of its input. */
	readonly logs?: string | readonly LogRow[];
	readonly log_access?: string;
};
/** One agent act: its outcome (a refusal included), or the route's refusal. */
type AgentAct = Call<ActOutcome>;
/** An invitation as its link shows it. */
export const Invitation = Schema.Struct({
	email: Schema.NullOr(Schema.String),
	phone: Schema.NullOr(Schema.String),
	team: Schema.NullOr(Schema.String),
	external: Schema.Boolean,
	status: Schema.Literals(['open', 'accepted', 'revoked', 'expired'])
});
export type Invitation = typeof Invitation.Type;
/** One raw conversation message as an instance's Messages tab lists it: either direction, as stored. */
export const InstanceMessage = Schema.Struct({
	id: Schema.String,
	seq: Schema.String,
	direction: Schema.Literals(['inbound', 'outbound']),
	at: Schema.String,
	thread: Schema.NullOr(Schema.String),
	kind: Schema.NullOr(Schema.String),
	title: Schema.NullOr(Schema.String),
	sender: Schema.NullOr(Schema.String),
	sender_name: Schema.NullOr(Schema.String),
	text: Schema.NullOr(Schema.String),
	files: Schema.Number,
	status: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	/** Outbound: the delivery timeline, oldest first; `[]` inbound. */
	delivery: Schema.Array(
		Schema.Struct({
			kind: Schema.Literals([
				'queued',
				'sent',
				'deferred',
				'delivered',
				'read',
				'opened',
				'bounced',
				'failed',
				'complained',
				'replied',
				'auto_replied'
			]),
			at: Schema.String,
			provider: Schema.String,
			code: Schema.optionalKey(Schema.String),
			reason: Schema.optionalKey(Schema.String),
			permanent: Schema.optionalKey(Schema.Boolean),
			presumed: Schema.optionalKey(Schema.Boolean),
			approximate: Schema.optionalKey(Schema.Boolean),
			raw: Schema.optionalKey(Schema.Json),
			reply: Schema.optionalKey(Schema.String)
		})
	)
});
export type InstanceMessage = typeof InstanceMessage.Type;
/** Durable sync progress and outbox counts for one integration instance. */
export const InstanceSyncHealth = SyncHealth;
export type InstanceSyncHealth = typeof InstanceSyncHealth.Type;
export const SyncReplayAnswer = Schema.Struct({ replayed: Schema.Number });
export { SyncDeadLetter };
export const SyncRetireAnswer = Schema.Struct({ retired: Schema.Number });

// ── the routes' answers, decoded once by `shell_api` ──
const Strings = Schema.Array(Schema.String);
const True = Schema.optionalKey(Schema.Literal(true));
const NullableString = Schema.NullOr(Schema.String);
// ── the settings rows (`settings/data.ts` reads them; client-safe here) ──
export const Member = Schema.Struct({
	id: Schema.String,
	email: NullableString,
	phone: NullableString,
	telegram: NullableString,
	name: NullableString,
	kind: Schema.Literals(['staff', 'external']),
	active: Schema.Boolean,
	admin: Schema.Boolean,
	team: NullableString,
	last_seen: NullableString
});
export type Member = typeof Member.Type;
export const InvitationRow = Schema.Struct({
	id: Schema.String,
	email: NullableString,
	phone: NullableString,
	team: NullableString,
	external: Schema.Boolean,
	status: Schema.Literals(['accepted', 'revoked', 'expired', 'open']),
	expires_at: Schema.String
});
export type InvitationRow = typeof InvitationRow.Type;
export const KeyRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	prefix: Schema.String,
	team: NullableString,
	created_by: NullableString,
	created_at: Schema.String,
	revoked_at: NullableString,
	last_used_at: NullableString
});
export type KeyRow = typeof KeyRow.Type;
export const AuditRow = Schema.Struct({
	model: Schema.String,
	record: Schema.String,
	revision: Schema.Number,
	at: Schema.String,
	actor: NullableString,
	op: Schema.String,
	changes: Schema.Json
});
export type AuditRow = typeof AuditRow.Type;
const NavPageAnswer = Schema.Struct({
	name: Schema.String,
	title: Schema.String,
	icon: Optional,
	section: Optional,
	portal: True,
	href: Schema.String
});
const NavNodeAnswer: Schema.Decoder<NavNode> = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('app'),
		name: Schema.String,
		title: Schema.String,
		description: Schema.String,
		icon: Schema.String,
		banner: Optional,
		href: Schema.String,
		pages: Schema.mutable(Schema.Array(NavPageAnswer))
	}),
	Schema.Struct({
		kind: Schema.Literal('group'),
		name: Schema.String,
		title: Schema.String,
		description: Optional,
		icon: Schema.String,
		href: Schema.String,
		children: Schema.mutable(Schema.Array(Schema.suspend(() => NavNodeAnswer)))
	})
]);
export const ShellBootAnswer: Schema.Decoder<ShellBoot> = Schema.Struct({
	workspace: ShellWorkspace,
	actor: Schema.NullOr(EngineActorSchema),
	name: NullableString,
	admin: Schema.Boolean,
	preview: Schema.NullOr(
		Schema.Union([
			Schema.Struct({ user: Schema.String, by: Schema.String }),
			Schema.Struct({ team: Schema.String, by: Schema.String })
		])
	),
	client: Schema.optionalKey(Schema.String),
	studio_bundle: Schema.optionalKey(Schema.String),
	notice: Schema.optionalKey(
		Schema.Struct({
			text: Schema.String,
			tone: Schema.optionalKey(Schema.Literals(['info', 'warning'])),
			href: Optional,
			action: Optional
		})
	),
	workspaces: Schema.optionalKey(
		Schema.Array(Schema.Struct({ handle: Schema.String, name: Schema.String, href: Schema.String }))
	),
	nav: Schema.mutable(Schema.Array(NavNodeAnswer)),
	surfaces: Schema.Struct({
		inbox: Schema.Boolean,
		runs: Schema.Boolean,
		settings: Schema.Boolean,
		agent: Schema.Boolean,
		studio: Schema.Boolean
	}),
	inbox: Schema.Number,
	kiosks: Schema.mutable(
		Schema.Array(
			Schema.Struct({
				name: Schema.String,
				title: Schema.String,
				icon: Optional,
				href: Schema.String
			})
		)
	),
	startable: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				name: Schema.String,
				description: Schema.String,
				needs_input: Schema.optionalKey(Schema.Boolean)
			})
		)
	),
	envoys: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	push: NullableString,
	visitor: Schema.NullOr(Schema.Struct({ app: Schema.String, site_key: Optional })),
	catalog: Schema.Record(Schema.String, ModelExposureSchema),
	read_catalog: ReadCatalog,
	automations: Schema.Record(Schema.String, AutomationExposureSchema),
	operation_outputs: OperationOutputs,
	search: Schema.optionalKey(Schema.Array(ManifestItemSchema)),
	ai_unconfigured: True,
	contract: Optional
});
export const SettingsAnswer: Schema.Decoder<Settings> = Schema.Struct({
	members: Schema.Array(Member),
	teams: Schema.mutable(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))),
	invitations: Schema.Array(InvitationRow),
	keys: Schema.Array(KeyRow),
	policies: Schema.mutable(Strings),
	secrets: Schema.mutable(
		Schema.Array(
			Schema.Struct({
				name: Schema.String,
				label: Schema.String,
				set: Schema.NullOr(Schema.Boolean)
			})
		)
	),
	envoys: Schema.mutable(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				audience: Schema.Literals(['public', 'private']),
				task: Schema.String,
				policies: Strings,
				group_messages: Schema.Literals(['disabled', 'mention_or_reply', 'all']),
				delegation: Schema.Literals(['enabled', 'disabled']),
				triage: Schema.Boolean,
				dm: Schema.Literals(['union', 'envoy']),
				active: Schema.Boolean
			})
		)
	),
	instances: Schema.mutable(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				integration: Schema.String,
				owner: NullableString,
				envoy: NullableString,
				active: Schema.Boolean,
				status: Schema.Json,
				configuration: Schema.Json,
				revision: Schema.Number,
				delivery: Schema.Struct({
					sent: Schema.Number,
					pending: Schema.Number,
					retrying: Schema.Number,
					failed: Schema.Number,
					skipped: Schema.Number,
					nextRetry: NullableString,
					lastError: NullableString
				})
			})
		)
	),
	mcp: Schema.mutable(
		Schema.Array(
			Schema.Struct({
				name: Schema.String,
				url: Schema.Json,
				secrets: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String)))
			})
		)
	),
	audit: Schema.Array(AuditRow),
	integrations: Schema.mutable(
		Schema.Array(
			Schema.Struct({
				name: Schema.String,
				driver: Driver,
				description: Schema.String,
				conversation: Schema.Boolean,
				personal: Schema.Boolean,
				sends: Schema.Boolean,
				syncs: Schema.Boolean,
				configuration: FieldsSchema
			})
		)
	),
	signup: Schema.NullOr(
		Schema.Struct({ via: Schema.Array(Schema.Literals(['email', 'phone'])), open: Schema.Boolean })
	)
});
const StudioLogLineAnswer = Schema.Struct({
	at: Schema.String,
	level: Schema.Literals(['info', 'warn', 'error']),
	message: Schema.String
});
const StudioDiagnosticAnswer = Schema.Struct({
	...Diagnostic.fields,
	severity: Schema.optionalKey(Schema.Literals(['error', 'warn']))
});
const StudioPreviewAnswer = Schema.Struct({
	url: NullableString,
	commit: Schema.String,
	artifact: Schema.String,
	stale: Schema.Boolean,
	shelved: True,
	destructive: Schema.optionalKey(Strings),
	impact: Schema.optionalKey(MigrationImpact)
});
const StudioBuildAnswerFields = Schema.Struct({
	commit: Schema.String,
	at: Schema.String,
	status: Schema.Literals(['built', 'failed']),
	message: Schema.String,
	deployed: Schema.Boolean,
	live: Schema.Boolean,
	lines: Schema.Number,
	diagnostics: Schema.Number
});
const StudioEntryAnswer = Schema.Array(
	Schema.Struct({ name: Schema.String, path: Schema.String, href: Optional })
);
export const StudioViewAnswer: Schema.Decoder<StudioView> = Schema.Struct({
	commit: Schema.String,
	working: Optional,
	tree: Optional,
	diagnosis: Schema.optionalKey(Schema.Literals(['passed', 'failed'])),
	tests: Schema.optionalKey(StudioTestRun),
	migration: Schema.optionalKey(
		Schema.Struct({
			state: Schema.Literals(['passed', 'failed']),
			error: Optional,
			impact: Schema.optionalKey(MigrationImpact),
			checks: Schema.optionalKey(
				Schema.Array(Schema.Struct({ sql: Schema.String, before: Schema.Json, after: Schema.Json }))
			)
		})
	),
	message: Optional,
	zone: Optional,
	files: Schema.Record(Schema.String, Schema.Struct({ bytes: Schema.Number })),
	changes: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			change: Schema.Literals(['added', 'modified', 'deleted']),
			text: Optional,
			baseline: Optional
		})
	),
	log: Schema.Array(StudioLogLineAnswer),
	preview: NullableString,
	releases: Schema.Array(
		Schema.Struct({
			commit: Schema.String,
			at: Schema.String,
			message: Schema.String,
			current: Schema.Boolean,
			checkpoint: Schema.optionalKey(NullableString),
			rollback: Optional,
			undo: True,
			discards: Optional,
			replaced: True
		})
	),
	environments: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({ name: Schema.String, release: Schema.String, url: NullableString })
		)
	),
	change: Optional,
	branch: Optional,
	preview_of: Schema.optionalKey(StudioPreviewAnswer),
	preview_control: Schema.optionalKey(
		Schema.Struct({
			holder: Schema.Literals(['norbius', 'person']),
			conversation: Optional,
			at: Optional
		})
	),
	base: Optional,
	behind: Schema.optionalKey(Schema.Number),
	conflicts: Schema.optionalKey(Strings),
	conflict_notes: Schema.optionalKey(Strings),
	change_sets: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				state: Schema.Literals(['open', 'merged', 'closed']),
				opened_by: Schema.String,
				contributors: Strings,
				branch: Schema.String,
				base: Schema.String,
				head: Schema.String,
				commits: Schema.Array(Schema.String),
				files: Schema.optionalKey(
					Schema.Array(
						Schema.Struct({
							path: Schema.String,
							change: Schema.Literals(['added', 'modified', 'deleted'])
						})
					)
				),
				history: Schema.optionalKey(
					Schema.Array(Schema.Struct({ commit: Schema.String, message: Schema.String }))
				),
				behind: Schema.Number,
				preview: Schema.NullOr(StudioPreviewAnswer),
				merge: Schema.optionalKey(
					Schema.Struct({
						state: Schema.Literals(['scheduled', 'queued', 'running', 'failed']),
						at: Schema.String,
						head: Schema.String,
						error: Optional,
						run_at: Optional
					})
				),
				log: Schema.Array(StudioLogLineAnswer),
				created_at: Schema.String,
				updated_at: Schema.String,
				diagnostics: Schema.optionalKey(Schema.Array(StudioDiagnosticAnswer))
			})
		)
	),
	diagnostics: Schema.optionalKey(Schema.Array(StudioDiagnosticAnswer)),
	builds: Schema.optionalKey(Schema.Array(StudioBuildAnswerFields)),
	approvals: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				op: StudioOp,
				requestor: Schema.String,
				conversation: Schema.String,
				at: Schema.String,
				head: Optional,
				destructive: Schema.optionalKey(Strings)
			})
		)
	),
	sections: Schema.NullOr(
		Schema.Struct({
			models: StudioEntryAnswer,
			apps: StudioEntryAnswer,
			kiosks: StudioEntryAnswer,
			policies: StudioEntryAnswer,
			automations: StudioEntryAnswer,
			secrets: StudioEntryAnswer
		})
	),
	stale: True
});
export const StudioFileAnswer: Schema.Decoder<StudioFile | null> = Schema.NullOr(
	Schema.Union([
		Schema.Struct({
			text: Schema.String,
			truncated: Schema.optionalKey(Schema.Struct({ limit: Schema.Number, bytes: Schema.Number }))
		}),
		Schema.Struct({ binary: Schema.Literal(true), bytes: Schema.Number })
	])
);
export const SignInMethodsAnswer: Schema.Decoder<SignInMethods> = Schema.Struct({
	email: Schema.Boolean,
	phone: Schema.Boolean,
	whatsapp: Schema.Boolean,
	signup: Schema.Array(Schema.Literals(['email', 'phone'])),
	locale: Schema.String
});
export const VerifiedAnswer = Schema.Struct({ user: Schema.String });
const RunViewFields = {
	id: Schema.String,
	automation: Schema.String,
	cause: Schema.String,
	trigger: Schema.NullOr(RunTriggerViewSchema),
	status: Schema.String,
	due_at: Schema.String,
	started: Schema.NullOr(Schema.String),
	progress: Schema.Json,
	error: Schema.NullOr(RunError),
	attempt_count: Schema.Number,
	result: Schema.optionalKey(Schema.Json),
	input: Schema.optionalKey(Schema.Json),
	attempts: Schema.optionalKey(Schema.Array(RunAttempt))
};
export const RunViewAnswer: Schema.Decoder<RunView> = Schema.Struct(RunViewFields);
export const LogRowAnswer: Schema.Decoder<LogRow> = Schema.Struct({
	id: Schema.String,
	at: Schema.String,
	severity: Schema.Literals(['info', 'warn', 'error']),
	event: Schema.String,
	invocation: Schema.String,
	run: Schema.NullOr(Schema.String),
	conversation: Schema.NullOr(Schema.String),
	turn: Schema.NullOr(Schema.String),
	attributes: Schema.Json
});
export const RunLogAnswer = Schema.Union([Schema.String, Schema.Array(LogRowAnswer)]);
export const RunDetailAnswer: Schema.Decoder<RunDetail> = Schema.Struct({
	...RunViewFields,
	logs: Schema.optionalKey(RunLogAnswer),
	log_access: Schema.optionalKey(Schema.String),
	files: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				mime: Schema.String,
				size: Schema.optionalKey(Schema.Number)
			})
		)
	)
});
export const StudioInspectionAnswer = StudioInspection;
const Model: Schema.Decoder<AiModel> = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	provider: Schema.optionalKey(Schema.String),
	context: Schema.optionalKey(Schema.Number)
});
/** The models the member may pick and the one a new conversation runs; the MCP servers its policies name. */
export const AgentModels = Schema.Struct({
	models: Schema.Array(Model),
	default: Schema.String,
	mcp: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
	/** An administrator's: every model, the runtime settings, this month's spend (USD) and the policy names. */
	admin: Schema.optionalKey(
		Schema.Struct({
			catalog: Schema.Array(Model),
			settings: AgentSettings,
			spent: Schema.Number,
			policies: Schema.Array(Schema.String)
		})
	)
});
export const Transcript = Schema.Struct({
	status: Schema.Literals(['idle', 'running', 'stopped']),
	rows: Schema.Array(AgentRow)
});
export const OlderPage = Schema.Struct({
	rows: Schema.Array(AgentRow),
	more: Schema.Boolean,
	first: Schema.Number
});

/** Complete native live-read envelopes; the stream validates every initial and patched image. */
export const ConversationsReadAnswer = Schema.Struct({ rows: Schema.Array(AgentConversation) });
export const TranscriptReadAnswer = Schema.Struct({
	rows: Schema.Array(AgentRow),
	status: Schema.optionalKey(Transcript.fields.status),
	from: Schema.optionalKey(Schema.Number),
	thread: Schema.optionalKey(Schema.Literal(true)),
	automation: Schema.optionalKey(Schema.Literal(true)),
	inputs: Schema.optionalKey(Schema.Array(ConversationFile)),
	outputs: Schema.optionalKey(Schema.Array(ConversationFile))
});
export const RunsReadAnswer = Schema.Struct({ rows: Schema.Array(RunViewAnswer), next: Schema.Null });
export const NoticesReadAnswer = Schema.Struct({ rows: Schema.Array(NoticeRow), unread: Schema.Number });
export const InboxRequestAnswer: Schema.Decoder<InboxRequest> = Schema.Struct({
	id: Schema.String,
	model: Schema.String,
	record: Schema.String,
	action: Schema.String,
	requestor: Schema.String,
	step: Schema.Number,
	at: Schema.String,
	by: Schema.String,
	status: Schema.Literals(['Pending', 'ChangesRequested']),
	steps: ApprovalSnapshot.fields.steps,
	mine: Schema.Boolean,
	canDecide: Schema.Boolean,
	canSupersede: Schema.Boolean,
	moves: ApprovalViewSchema.fields.moves
});
export const InboxReadAnswer = Schema.Struct({
	...NoticesReadAnswer.fields,
	requests: Schema.Array(InboxRequestAnswer)
});

/** The shell routes over one `fetch`, as Effects. */
export type ShellApi = {
	/** The page's boot (`app` for a visitor page, `kiosk` for a kiosk); its `contract` is what later acts name. */
	boot(app?: string, kiosk?: string): Call<ShellBoot>;
	methods(): Call<SignInMethods>;
	send_code(address: string, via?: 'sms' | 'whatsapp'): Call<void>;
	verify(address: string, code: string): Call<typeof VerifiedAnswer.Type>;
	sign_out(): Call<void>;
	invitation(id: string): Call<Invitation>;
	accept(id: string): Call<void>;
	mark_notices_read(ids: readonly string[]): Call<ActOutcome>;
	mark_all_notices_read(): Call<ActOutcome>;
	runs(o?: { automation?: string; limit?: number }): Call<readonly RunView[]>;
	run(id: string): Call<RunDetail>;
	run_log(id: string, access: string, after?: string): Call<typeof RunLogAnswer.Type>;
	stop_run(id: string): Call<RunView>;
	settings(): Call<Settings>;
	settings_op(op: string, input: Json): Call<Json>;
	/** An integration instance's host verbs (`/__bolt/integrations/<instance>/…`). */
	integration(instance: string): ReturnType<typeof integration_client>;
	/** Every definition with the providers this host offers for it: the envoys' channels. */
	integration_offers(): ReturnType<typeof integration_offers>;
	/** L-COL-199: the workspace's logo (`null`, an `https:` URL or a `data:image/…` URL), an administrator's. */
	organization(logo: string | null): Call<void>;
	/** An instance's raw messages, both directions, newest first (an administrator's). */
	instance_messages(instance: string, before?: string): Call<readonly InstanceMessage[]>;
	/** Sync health and dead-letter replay require update permission on this instance. */
	instance_sync_health(instance: string): Call<InstanceSyncHealth>;
	replay_instance_sync(instance: string, ids?: readonly string[]): Call<typeof SyncReplayAnswer.Type>;
	instance_sync_dead_letters(instance: string): Call<readonly SyncDeadLetter[]>;
	retire_instance_sync(instance: string, id: string): Call<typeof SyncRetireAnswer.Type>;
	logs(query: LogQuery): Call<readonly LogRow[]>;
	/** Administrator-only server filtering over the host's separate audit store. */
	audit(query: AuditQuery): Call<AuditPage>;
	/** Full payload is fetched only when an administrator opens an event. */
	audit_detail(id: string): Call<AuditRecord | null>;
	studio(): Call<StudioView>;
	studio_run(op: StudioOp): Call<StudioView>;
	studio_file(commit: string, path: string): Call<StudioFile | null>;
	studio_inspect(input: StudioInspectInput): Call<StudioInspection>;
	/** Rule 39: a member id, `{ team }`, or `null` to end the preview. */
	preview(target: string | { team: string } | null): Call<void>;
	/** `access.explain`: the caller's own Authority, or (administrators) a member's or team's. */
	explain(target?: { user: string } | { team: string }): Call<Json>;
	push(body: PushBody): Call<void>;
	agent: {
		start(title?: string, model?: string): AgentAct;
		models(): Call<typeof AgentModels.Type>;
		/** `mode`: the composer's `/plan` or `/compact`. */
		post(
			conversation: string,
			text: string,
			now?: boolean,
			attachments?: readonly { readonly id: string }[],
			mode?: 'plan' | 'compact',
			/** Hold it: an ISO instant, or `finish` for when the running turn finishes. */
			schedule?: string,
			/** The structured question this input answers; scheduling an answer is refused. */
			question?: string
		): AgentAct;
		/** The active tab writes back whether it performed a page action. */
		page_result(message: string, result: PageResult): AgentAct;
		/** The first tab to claim a page action owns it; the others stay silent. */
		claim_page_action(message: string): AgentAct;
		/** One panel attachment stored to `/__bolt/files/sys_conversation.inputs`. */
		upload(file: File): Call<Required<Attachment>>;
		respond_now(conversation: string): AgentAct;
		confirm(message: string, approve: boolean): AgentAct;
		set_agent(conversation: string, agent: string): AgentAct;
		file(message: string, about: { model: string; id: string } | null): AgentAct;
		stop(conversation: string): AgentAct;
		set_model(conversation: string, model: string): AgentAct;
		revise(message: string, text: string, attachments?: readonly Json[]): AgentAct;
		restart(message: string): AgentAct;
		dequeue(message: string): AgentAct;
		reorder(conversation: string, messages: readonly string[]): AgentAct;
		execute_plan(conversation: string): AgentAct;
		discard_plan(conversation: string): AgentAct;
		resume(conversation: string): AgentAct;
		transcript(conversation: string): Call<typeof Transcript.Type>;
		/** The `limit` messages just before `seq` `before` (the panel's older page); `more`: another may lie before `first`. */
		older(conversation: string, before: number, limit: number): Call<typeof OlderPage.Type>;
	};
};
