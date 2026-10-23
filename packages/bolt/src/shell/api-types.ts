// The shell routes' client (`shellApi`, B.2) as Effects (D9): each member answers its value or fails with `ShellError`,
// today's `Answer<T>` refusal (the wire error, its HTTP status, and on a signed-out boot the workspace the access pages
// show). Agent acts answer their `Outcome`: a refusal there is a business answer the panel renders (rule 32). Pinned for
// R6a (the implementation in `runtime.ts`) and R6b (the Svelte components that run it on the ui edge).
import { Schema, type Effect } from 'effect';
import type { FileRef } from '@norbital-ai/std/kind';
import type { Attachment } from '../decl/runtime/integration.ts';
import type { Json } from '../decl/values.ts';
import type { AiModel, Outcome } from '../engine/contracts.ts';
import type { AgentSettings } from '../engine/agent/settings.ts';
import type { RunView } from '../engine/runs/index.ts';
import type { AgentRow, PushBody } from '../protocol/wire.ts';
import type { integrationClient, integrationOffers } from '../page/integrations.ts';
import type { Inbox } from './inbox/data.ts';
import type { InstanceMessage } from './integration/messages.ts';
import type { LogQuery, LogRow } from './logs/data.ts';
import type { RunRow } from './runs/data.ts';
import type { Settings } from './settings/data.ts';
import type { SignInMethods } from './host.ts';
import type { ShellBoot } from './nav.ts';
import type { StudioBuildRecord, StudioOp, StudioView } from './studio/model.ts';

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
type AgentAct = Call<Outcome>;
/** An invitation as its link shows it. */
export type Invitation = {
	email: string | null;
	phone: string | null;
	team: string | null;
	external: boolean;
	status: 'open' | 'accepted' | 'revoked' | 'expired';
};

/** The shell routes over one `fetch`, as Effects. */
export type ShellApi = {
	/** The page's boot (`app` for a visitor page, `kiosk` for a kiosk); its `contract` is what later acts name. */
	boot(app?: string, kiosk?: string): Call<ShellBoot>;
	methods(): Call<SignInMethods>;
	sendCode(address: string, via?: 'sms' | 'whatsapp'): Call<void>;
	verify(address: string, code: string): Call<{ user: string }>;
	signOut(): Call<void>;
	invitation(id: string): Call<Invitation>;
	accept(id: string): Call<void>;
	inbox(): Call<Inbox>;
	markNoticesRead(ids: readonly string[]): Call<Outcome>;
	markAllNoticesRead(): Call<Outcome>;
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
	logs(query: LogQuery): Call<readonly LogRow[]>;
	studio(): Call<StudioView>;
	studioRun(op: StudioOp): Call<StudioView>;
	studioBuild(commit: string): Call<StudioBuildRecord | null>;
	/** Rule 39: a member id, `{ team }`, or `null` to end the preview. */
	preview(target: string | { team: string } | null): Call<void>;
	/** `access.explain` (L-BOLT-234): the caller's own Authority, or (administrators) a member's or team's. */
	explain(target?: { user: string } | { team: string }): Call<Json>;
	push(body: PushBody): Call<void>;
	agent: {
		start(title?: string, model?: string): AgentAct;
		/** The models the member may pick and the one a new conversation runs; the MCP servers its policies name. */
		models(): Call<{
			models: readonly AiModel[];
			default: string;
			mcp: readonly { name: string; description: string }[];
			/** An administrator's: every model, the runtime settings, this month's spend (USD) and the policy names. */
			admin?: {
				catalog: readonly AiModel[];
				settings: AgentSettings;
				spent: number;
				policies: readonly string[];
			};
		}>;
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
		transcript(
			conversation: string
		): Call<{ status: 'idle' | 'running' | 'stopped'; rows: readonly AgentRow[] }>;
		/** The `limit` messages just before `seq` `before` (the panel's older page); `more`: another may lie before `first`. */
		older(
			conversation: string,
			before: number,
			limit: number
		): Call<{ rows: readonly AgentRow[]; more: boolean; first: number }>;
	};
};
