// The shell routes' client (`shellApi`, B.2) as Effects (D9): each member answers its value or fails with `ShellError`,
// today's `Answer<T>` refusal (the wire error, its HTTP status, and on a signed-out boot the workspace the access pages
// show). Agent acts answer their `Outcome`: a refusal there is a business answer the panel renders (rule 32). Pinned for
// R6a (the implementation in `runtime.ts`) and R6b (the Svelte components that run it on the ui edge).
import { Schema, type Effect } from 'effect';
import type { FileRef } from '@norbital-ai/std/kind';
import type { Attachment } from '../decl/runtime/integration.ts';
import { SyncHealth } from '../engine/sync/health-schema.ts';
import type { Json } from '../decl/values.ts';
import type { ActOutcome, AiModel } from '../engine/contracts.ts';
import { AgentSettings } from '../engine/agent/settings.ts';
import type { InboxRequest } from '../engine/approvals/inbox.ts';
import type { RunView } from '../engine/runs/index.ts';
import { RunAttempt } from '../engine/runs/attempt.ts';
import {
	AgentRow,
	Driver,
	EngineActorSchema,
	NoticeRow,
	RunTriggerViewSchema
} from '../protocol/schema.ts';
import { Diagnostic } from '../protocol/diagnostic.ts';
import { MigrationImpact } from '../protocol/migration-impact.ts';
import {
	AutomationExposureSchema,
	FieldsSchema,
	ModelExposureSchema
} from '../protocol/public-page.ts';
import type { PushBody } from '../protocol/wire.ts';
import type { integrationClient, integrationOffers } from '../page/integrations.ts';
import type { Inbox } from './inbox/data.ts';
import type { LogQuery, LogRow } from '../engine/contracts.ts';
import type { AuditPage, AuditQuery, AuditRecord } from '../protocol/audit.ts';
import type { Settings } from './settings/data.ts';
import type { SignInMethods } from './host.ts';
import type { NavNode, ShellBoot } from './nav.ts';
import {
	StudioOp,
	type StudioBuildRecord,
	type StudioFile,
	type StudioUsage,
	type StudioView
} from './studio/model.ts';
import {
	AuditRuleSet,
	AuditRuleState,
	type StudioAudit,
	type StudioAuditRules
} from './studio/audit.ts';
import { StudioInspection, type StudioInspectInput } from './studio/inspection.ts';

const Optional = Schema.optionalKey(Schema.String);
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
export type RunDetail = RunView & { readonly files?: readonly FileRef[] };
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
	/** Outbound: the delivery timeline (§5.9), oldest first; `[]` inbound. */
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

// ── the routes' answers, decoded once by `shellApi` ──
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
		Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String }))
	),
	envoys: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	push: NullableString,
	visitor: Schema.NullOr(Schema.Struct({ app: Schema.String, siteKey: Optional })),
	catalog: Schema.Record(Schema.String, ModelExposureSchema),
	automations: Schema.Record(Schema.String, AutomationExposureSchema),
	aiUnconfigured: True,
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
				groupMessages: Schema.Literals(['disabled', 'mention_or_reply', 'all']),
				delegation: Schema.Literals(['enabled', 'disabled']),
				triage: Schema.Boolean,
				dm: Schema.Literals(['union', 'envoy']),
				active: Schema.Boolean,
				created: Schema.Boolean
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
				named: Schema.Boolean,
				envoy: NullableString,
				active: Schema.Boolean,
				status: Schema.Json,
				configuration: Schema.Json,
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
	mcp: Schema.mutable(Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.Json }))),
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
	previewOf: Schema.optionalKey(StudioPreviewAnswer),
	previewControl: Schema.optionalKey(
		Schema.Struct({
			holder: Schema.Literals(['norbius', 'person']),
			conversation: Optional,
			at: Optional
		})
	),
	base: Optional,
	behind: Schema.optionalKey(Schema.Number),
	conflicts: Schema.optionalKey(Strings),
	changeSets: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				title: Schema.String,
				state: Schema.Literals(['open', 'merged', 'closed']),
				openedBy: Schema.String,
				contributors: Strings,
				branch: Schema.String,
				base: Schema.String,
				head: Schema.String,
				behind: Schema.Number,
				preview: Schema.NullOr(StudioPreviewAnswer),
				merge: Schema.optionalKey(
					Schema.Struct({
						state: Schema.Literals(['scheduled', 'running', 'failed']),
						at: Schema.String,
						head: Schema.String,
						error: Optional,
						runAt: Optional
					})
				),
				log: Schema.Array(StudioLogLineAnswer),
				createdAt: Schema.String,
				updatedAt: Schema.String,
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
			remotes: StudioEntryAnswer,
			secrets: StudioEntryAnswer
		})
	),
	stale: True
});
export const StudioBuildAnswer: Schema.Decoder<StudioBuildRecord | null> = Schema.NullOr(
	Schema.Struct({
		build: StudioBuildAnswerFields,
		log: Schema.Array(StudioLogLineAnswer),
		diagnostics: Schema.Array(StudioDiagnosticAnswer)
	})
);
export const StudioFileAnswer: Schema.Decoder<StudioFile | null> = Schema.NullOr(
	Schema.Union([
		Schema.Struct({
			text: Schema.String,
			truncated: Schema.optionalKey(Schema.Struct({ limit: Schema.Number, bytes: Schema.Number }))
		}),
		Schema.Struct({ binary: Schema.Literal(true), bytes: Schema.Number })
	])
);
const Severity = Schema.Literals(['error', 'hint']);
const StudioAuditRuleErrors = Schema.Array(
	Schema.Struct({ id: Schema.String, message: Schema.String })
);
export const StudioAuditRulesAnswer: Schema.Decoder<StudioAuditRules> = Schema.Struct({
	revision: Schema.Number,
	ruleSet: AuditRuleSet,
	rules: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			pack: Schema.String,
			summary: Schema.String,
			severity: Severity,
			state: AuditRuleState,
			principles: Strings,
			files: Schema.optionalKey(Strings),
			rationale: Optional,
			examples: Schema.Struct({ bad: Strings, good: Strings })
		})
	),
	errors: StudioAuditRuleErrors,
	digest: Schema.String,
	version: Schema.String
});
export const StudioAuditAnswer: Schema.Decoder<StudioAudit> = Schema.Struct({
	commit: Schema.String,
	findings: Schema.Array(
		Schema.Struct({
			rule: Schema.String,
			severity: Severity,
			summary: Schema.String,
			location: Schema.String,
			principles: Strings
		})
	),
	errors: StudioAuditRuleErrors,
	digest: Schema.String,
	version: Schema.String
});
export const SignInMethodsAnswer: Schema.Decoder<SignInMethods> = Schema.Struct({
	email: Schema.Boolean,
	phone: Schema.Boolean,
	whatsapp: Schema.Boolean,
	signup: Schema.Array(Schema.Literals(['email', 'phone'])),
	locale: Schema.String
});
export const VerifiedAnswer = Schema.Struct({ user: Schema.String });
const InboxRequestAnswer: Schema.Decoder<InboxRequest> = Schema.Struct({
	id: Schema.String,
	model: Schema.String,
	record: Schema.String,
	action: Schema.String,
	status: Schema.Literals(['Pending', 'ChangesRequested']),
	step: Schema.Number,
	steps: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			teams: Schema.Array(Schema.String),
			users: Schema.Array(Schema.String)
		})
	).check(Schema.isMinLength(1)),
	at: Schema.String,
	requestor: Schema.String,
	by: Schema.String,
	mine: Schema.Boolean,
	canDecide: Schema.Boolean,
	canSupersede: Schema.Boolean,
	moves: Schema.Array(
		Schema.Struct({
			decision: Schema.Literals(['approve', 'reject', 'requestChanges']),
			reason: Schema.Literals(['required', 'optional'])
		})
	)
});
export const InboxAnswer: Schema.Decoder<Inbox> = Schema.Struct({
	requests: Schema.Array(InboxRequestAnswer),
	notices: Schema.Array(NoticeRow),
	unread: Schema.Number
});
const RunViewFields = {
	id: Schema.String,
	automation: Schema.String,
	cause: Schema.String,
	trigger: Schema.NullOr(RunTriggerViewSchema),
	status: Schema.String,
	due_at: Schema.String,
	started: Schema.NullOr(Schema.String),
	progress: Schema.Json,
	error: Schema.NullOr(
		Schema.Struct({ code: Schema.String, message: Schema.optionalKey(Schema.String) })
	),
	attempt_count: Schema.Number,
	result: Schema.optionalKey(Schema.Json),
	input: Schema.optionalKey(Schema.Json),
	attempts: Schema.optionalKey(Schema.Array(RunAttempt))
};
export const RunViewAnswer: Schema.Decoder<RunView> = Schema.Struct(RunViewFields);
export const RunDetailAnswer: Schema.Decoder<RunDetail> = Schema.Struct({
	...RunViewFields,
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
export const StudioInspectionAnswer = StudioInspection;
export const StudioUsageAnswer: Schema.Decoder<StudioUsage> = Schema.Struct({
	charts: Schema.Array(
		Schema.Struct({
			title: Schema.String,
			unit: Schema.String,
			points: Schema.Array(
				Schema.Struct({ at: Schema.Number, value: Schema.NullOr(Schema.Number) })
			)
		})
	)
});
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

/** The shell routes over one `fetch`, as Effects. */
export type ShellApi = {
	/** The page's boot (`app` for a visitor page, `kiosk` for a kiosk); its `contract` is what later acts name. */
	boot(app?: string, kiosk?: string): Call<ShellBoot>;
	methods(): Call<SignInMethods>;
	sendCode(address: string, via?: 'sms' | 'whatsapp'): Call<void>;
	verify(address: string, code: string): Call<typeof VerifiedAnswer.Type>;
	signOut(): Call<void>;
	invitation(id: string): Call<Invitation>;
	accept(id: string): Call<void>;
	inbox(): Call<Inbox>;
	markNoticesRead(ids: readonly string[]): Call<ActOutcome>;
	markAllNoticesRead(): Call<ActOutcome>;
	runs(o?: { automation?: string; limit?: number }): Call<readonly RunView[]>;
	run(id: string): Call<RunDetail>;
	stopRun(id: string): Call<RunView>;
	settings(): Call<Settings>;
	settingsOp(op: string, input: Json): Call<Json>;
	/** An integration instance's host verbs (`/__bolt/integrations/<instance>/…`). */
	integration(instance: string): ReturnType<typeof integrationClient>;
	/** Every definition with the providers this host offers for it: the envoys' channels. */
	integrationOffers(): ReturnType<typeof integrationOffers>;
	/** L-COL-199: the workspace's name and logo (`null`, an `https:` URL or a `data:image/…` URL), an administrator's. */
	organization(name: string, logo: string | null): Call<void>;
	/** An instance's raw messages, both directions, newest first (an administrator's). */
	instanceMessages(instance: string, before?: string): Call<readonly InstanceMessage[]>;
	/** Sync health and dead-letter replay require update permission on this instance. */
	instanceSyncHealth(instance: string): Call<InstanceSyncHealth>;
	replayInstanceSync(instance: string, ids?: readonly string[]): Call<typeof SyncReplayAnswer.Type>;
	logs(query: LogQuery): Call<readonly LogRow[]>;
	/** Administrator-only server filtering over the host's separate audit store. */
	audit(query: AuditQuery): Call<AuditPage>;
	/** Full payload is fetched only when an administrator opens an event. */
	auditDetail(id: string): Call<AuditRecord | null>;
	studio(): Call<StudioView>;
	studioRun(op: StudioOp): Call<StudioView>;
	studioFile(commit: string, path: string): Call<StudioFile | null>;
	studioBuild(commit: string): Call<StudioBuildRecord | null>;
	studioUsage(): Call<StudioUsage>;
	studioInspect(input: StudioInspectInput): Call<StudioInspection>;
	/** The organization's audit rules: read, saved over `revision`, and an audit of the head (Try: an unsaved set). */
	studioAuditRules(): Call<StudioAuditRules>;
	studioAuditSave(revision: number, ruleSet: AuditRuleSet): Call<StudioAuditRules>;
	studioAudit(ruleSet?: AuditRuleSet): Call<StudioAudit>;
	/** Rule 39: a member id, `{ team }`, or `null` to end the preview. */
	preview(target: string | { team: string } | null): Call<void>;
	/** `access.explain` (L-BOLT-234): the caller's own Authority, or (administrators) a member's or team's. */
	explain(target?: { user: string } | { team: string }): Call<Json>;
	push(body: PushBody): Call<void>;
	agent: {
		start(title?: string, model?: string): AgentAct;
		models(): Call<typeof AgentModels.Type>;
		/** `mode`: the composer's `/plan` or `/compact` (§5.9). */
		post(
			conversation: string,
			text: string,
			now?: boolean,
			attachments?: readonly Attachment[],
			mode?: 'plan' | 'compact'
		): AgentAct;
		/** One panel attachment stored to `/__bolt/files/sys_conversation.inputs`. */
		upload(file: File): Call<Required<Attachment>>;
		respondNow(conversation: string): AgentAct;
		confirm(message: string, approve: boolean): AgentAct;
		setAgent(conversation: string, agent: string): AgentAct;
		file(message: string, about: { model: string; id: string } | null): AgentAct;
		stop(conversation: string): AgentAct;
		setModel(conversation: string, model: string): AgentAct;
		revise(message: string, text: string): AgentAct;
		dequeue(message: string): AgentAct;
		reorder(conversation: string, messages: readonly string[]): AgentAct;
		executePlan(conversation: string): AgentAct;
		discardPlan(conversation: string): AgentAct;
		resume(conversation: string): AgentAct;
		transcript(conversation: string): Call<typeof Transcript.Type>;
		/** The `limit` messages just before `seq` `before` (the panel's older page); `more`: another may lie before `first`. */
		older(conversation: string, before: number, limit: number): Call<typeof OlderPage.Type>;
	};
};
