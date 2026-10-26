// The shell routes' client (`shellApi`, B.2) as Effects (D9): each member answers its value or fails with `ShellError`,
// today's `Answer<T>` refusal (the wire error, its HTTP status, and on a signed-out boot the workspace the access pages
// show). Agent acts answer their `Outcome`: a refusal there is a business answer the panel renders (rule 32). Pinned for
// R6a (the implementation in `runtime.ts`) and R6b (the Svelte components that run it on the ui edge).
import { Predicate, Schema, type Effect } from 'effect';
import type { FileRef } from '@norbital-ai/std/kind';
import type { Attachment } from '../decl/runtime/integration.ts';
import { SyncHealth } from '../engine/sync/health-schema.ts';
import type { Json } from '../decl/values.ts';
import type { ActOutcome, AiModel } from '../engine/contracts.ts';
import { AgentSettings } from '../engine/agent/settings.ts';
import type { InboxRequest } from '../engine/approvals/inbox.ts';
import type { RunView } from '../engine/runs/index.ts';
import { AgentRow, NoticeRow } from '../protocol/schema.ts';
import type { PushBody } from '../protocol/wire.ts';
import type { integrationClient, integrationOffers } from '../page/integrations.ts';
import type { Inbox } from './inbox/data.ts';
import type { LogQuery, LogRow } from '../engine/contracts.ts';
import type { AuditPage, AuditQuery, AuditRecord } from '../protocol/audit.ts';
import type { RunRow } from './runs/data.ts';
import type { Settings } from './settings/data.ts';
import type { SignInMethods } from './host.ts';
import type { ShellBoot } from './nav.ts';
import type {
	StudioBuildRecord,
	StudioFile,
	StudioOp,
	StudioUsage,
	StudioView
} from './studio/model.ts';
import type { AuditRuleSet, StudioAudit, StudioAuditRules } from './studio/audit.ts';
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
/**
 * An answer this package's own host builds from `T` and no wire Schema describes yet (the boot, settings and studio views):
 * an object here, as the manifest's compiler-proven parts are.
 */
const own = <T extends object>(identifier: string): Schema.Decoder<T> =>
	Schema.declare((u: unknown): u is T => Predicate.isObject(u), { identifier });
export const ShellBootAnswer = own<ShellBoot>('shell boot');
export const SettingsAnswer = own<Settings>('settings');
export const StudioViewAnswer = own<StudioView>('studio view');
export const StudioBuildAnswer: Schema.Decoder<StudioBuildRecord | null> = Schema.NullOr(
	own<StudioBuildRecord>('studio build')
);
export const StudioFileAnswer: Schema.Decoder<StudioFile | null> = Schema.NullOr(
	own<StudioFile>('studio file')
);
export const StudioAuditRulesAnswer = own<StudioAuditRules>('studio audit rules');
export const StudioAuditAnswer = own<StudioAudit>('studio audit');
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
	collection: Schema.String,
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
	attempts: Schema.optionalKey(Schema.Json)
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
	runs(o?: { automation?: string; limit?: number }): Call<readonly RunRow[]>;
	run(id: string): Call<RunDetail>;
	stopRun(id: string): Call<RunView>;
	settings(): Call<Settings>;
	settingsOp(op: string, input: Json): Call<Json>;
	/** An integration instance's host verbs (`/__bolt/integrations/<instance>/…`). */
	integration(instance: string): ReturnType<typeof integrationClient>;
	/** Every definition with the providers this host offers for it: a member's Connections, the envoys' channels. */
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
		file(message: string, about: { collection: string; id: string } | null): AgentAct;
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
