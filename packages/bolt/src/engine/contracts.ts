// Shared engine budgets and the guest ABI's types. Services live in services.ts, the database in db/tenant-db.ts,
// compiled source in manifest.ts; the host boundary (ports, facilities, `HostApi`) is `@norbital-ai/host-api`'s.
import type {
	EngineActorSchema,
	RunTriggerSchema,
	RunTriggerViewSchema,
	WriteOutcome,
	Outcome as ActOutcomeSchema,
	Written as WrittenSchema
} from '../protocol/schema.ts';
import type { BoltError } from '../protocol/errors.ts';
import { HOST_LIMITS, type FacilityFailure, type Unavailable } from '@norbital-ai/host-api';
import type { MessageValues } from '../decl/errors/refusal.ts';
import type { Json } from '../decl/values.ts';
import type { Pred } from '@norbital-ai/store';
import type { Holder } from './access/authority.ts';
import type { FacilityMember } from '../decl/runtime/facility-members.ts';

/** The precise facility failure sent across the guest ABI; interior failures remain tagged errors. */
export type FacilityError =
	| (Pick<FacilityFailure, 'kind' | 'message'> & { readonly status?: number | undefined })
	| ({ readonly kind: 'unavailable' } & Pick<Unavailable, 'facility' | 'reason'>);

// ── budgets ──
const MiB = 1024 * 1024;
/** Every wall and cap as one table; each overrun is a typed `BoltError`, never a clamp. */
export const LIMITS = {
	runLog: { lines: 100, pollMs: 2_000 },
	...HOST_LIMITS,
	/** Read crossings per invocation: `write` for one create/update transform, reading the whole batch;
	 * `sync` for every other synchronous body. */
	crossings: { sync: 40, write: 10, automation: 10_000 },
	/** Rows per write-callback invocation: a batch of N rows is ⌈N/1000⌉ calls per verb per model, one 3 s budget each. */
	writeChunk: 1_000,
	readBytes: 32 * MiB,
	/** Coalesced native reads retained between an automation's successful read and its next act. */
	readGuards: { count: 256, bytes: 4 * MiB },
	changeSetBytes: 16 * MiB,
	/** A direct act holds its root inputs through the atomic commit. */
	act: { rows: 10_000, inputBytes: 8 * MiB },
	seedChunkBytes: MiB,
	changesPerAct: 50_000,
	expandedRowsPerStatement: 100_000,
	writeDepth: 8,
	page: { max: 10_000, all: 50_000, allBytes: 8 * MiB, relationArm: 10_000 },
	statement: { shapes: 500, params: 30_000 },
	fileBytes: 4 * MiB,
	/** A waiting run's row: what it waits on and the answers of the crossings it made before (`ctx.wait`). */
	waitBytes: 4 * MiB,
	/** An outbound conversation message's attachments together, read for its provider; more refuses the message (permanent). */
	messageAttachmentBytes: 20 * MiB
} as const;

/** A facility's native wall; the guest may tighten ordinary crossings, while ingest and inference keep their own liveness. */
export function facility_wall_ms(member: FacilityMember, crossing_wall_ms?: number): number | undefined {
	switch (member) {
		case 'ai.sys_2.infer': return undefined;
		case 'convert.ingest': return LIMITS.callMs.ingest;
		case 'files.image': return crossing_wall_ms ?? LIMITS.callMs.image;
		case 'ai.sys_1.decide':
		case 'ai.embed': return crossing_wall_ms ?? LIMITS.callMs.ai;
		case 'convert.document': return crossing_wall_ms ?? LIMITS.callMs.database;
		case 'convert.record': return LIMITS.callMs.render;
		default: return crossing_wall_ms ?? LIMITS.callMs.other;
	}
}

/** Size of wire text in UTF-8, including non-ASCII characters. */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

// ── the tenant database (C11 per activation) ──
/** What operands resolve against, fixed per invocation (a replay keeps `now` and `today`). */
export type Bindings = {
	now: string;
	today: string;
	tz: string;
};
/** Who reads: a caller's Authority (scoped to the outputs it holds), or the workspace (the transform: unscoped). */
export type Reader = { as: 'caller'; authority: Authority } | { as: 'workspace' };
// ── changes: everything one act's statement writes besides the engine's bookkeeping ──
/** A row's stored values in wire form: a decimal as its exact text; dates and instants as ISO strings. */
export type RowData = { readonly [field: string]: Json };
/** Where a change came from in the caller's input, for `refused { field, row }`. */
export type InputPath = readonly (string | number)[];
/** Native keyed writes choose replacement or retention; authored imports separately permit refusal. */
export type NativeWriteConflict = 'update' | 'keep';
/** One write per row; relation actions are already flattened (`link`/`unlink` are FK updates). */
export type Change = { model: string; id: string; path: InputPath } & (
	| { op: 'create'; values: RowData }
	| { op: 'upsert'; values: RowData; on: readonly string[]; on_conflict: NativeWriteConflict }
	/** `revision` is the one the caller observed; `null` writes blind. */
	| { op: 'update'; set: RowData; revision: number | null }
	| { op: 'delete'; revision: number | null }
);
export type QueuedRun = {
	automation: string;
	input: Json;
	due_at: string;
	key?: string;
	id?: string;
	actor?: string;
	starter?: Json;
	/** An automation run's trigger; absent on an effect's or platform run. */
	trigger?: RunTrigger;
	cause: string;
	depth: number;
};
export type { Captured } from './db/captured.ts';

// ── outcomes: the author types of decl/ctx with names erased; a write's own `Outcome` is never `running` ──
export type Written = typeof WrittenSchema.Type;
export type Outcome = typeof WriteOutcome.Type;
/** A refused outcome: its code, message and where it points. */
export type Refused = Extract<Outcome, { kind: 'refused' }>;
/** Past the person-wait the write continues in the background as run `run`; its row reports the outcome (`Running`). */
export type Running = Extract<ActOutcome, { kind: 'running' }>;
/** What an act answers its caller: the write's outcome, or `running` once it outlives the person-wait. */
export type ActOutcome = typeof ActOutcomeSchema.Type;

// ── actors and authority ──
/** The decl `Actor` with names erased: one engine serves any workspace. */
export type MemberActor = Extract<EngineActor, { kind: 'member' }>;
export type EngineActor = typeof EngineActorSchema.Type;
/** The decl `RunTrigger` with names erased (`sys_run.trigger`): who or what started an automation run. */
export type RunTrigger = typeof RunTriggerSchema.Type;
/** A run's trigger as the ledger shows it (decl `RunTriggerView`): a person by actor ref and display name. */
export type RunTriggerView = typeof RunTriggerViewSchema.Type;
/** One read arm of one layer of one output: its policy's row filter; arms of every held policy union. */
export type Arm = { policy: string; where: Pred; history?: true };
/**
 * A create or update arm: the columns it admits per write path (checked before any guest code) and whether its policy
 * declares a `verdict` (`policy.<p>.grants.<model>.<op>.verdict`, invocation kind `policy`); without one the arm allows. The
 * verdicts of every admitting arm combine: any `allow` executes; else the first `approve` in the team's policy order
 * holds the batch for its flow; else the first `refuse` refuses it.
 */
export type WriteArm = {
	policy: string;
	columns: { readonly [path: string]: readonly string[] };
	check: boolean;
};
/** A delete arm: its policy, and whether it declares a verdict callback. */
export type DeleteArm = { policy: string; check: boolean };
/**
 * A model's access points as one actor holds them: only this model's policies guard its reads and writes,
 * every layer under them included; a layer's own model's policies are never consulted on that path.
 */
export type ModelAuthority = {
	/**
	 * Per read output the caller is granted (`default`, a named one), per read path of that output (`'<model>'`,
	 * `'<model>.<rel>'`, …): one arm per policy granting it. The root arm's `where` scopes the roots; a deeper arm's
	 * scopes that layer's rows (a ref layer: nulls it). A path a grant does not name is `{ where: true }`. An output
	 * absent here is not granted.
	 */
	read: { readonly [output: string]: { readonly [path: string]: readonly Arm[] } };
	create: readonly WriteArm[];
	update: readonly WriteArm[];
	delete: readonly DeleteArm[];
	moves: { readonly [stateField: string]: 'all' | readonly string[] };
};
export type LimitRule = { key: string; rate: string; per: 'actor' | 'ip' | 'sender' | 'subject' };
/** Compiled once per `key` = (actor, affiliation revision, source release). */
export type Authority = {
	key: string;
	actor: EngineActor;
	admin: boolean;
	policies: readonly string[];
	/** Trusted admin preview context, rechecked before an approval decision or proposal replay. */
	preview?: { by: string; team: string | null };
	/** Set when compiled for a kiosk's requests: the kiosk whose assigned policies this reads and writes as. */
	kiosk?: string;
	/**
	 * Set from a session minted for the agent's browser (`session.mint`'s `agent`): every request made with it is the
	 * agent's, acting for this authority's own member in `conversation`. A host holds live-changing work from it.
	 */
	agent?: { readonly conversation: string };
	/** Set on a render grant's requests (`RenderGrants`): the run's reads, every write and start stripped. */
	render?: true;
	/**
	 * Set inside an automation or effect run (runs/index.ts `invoke`): the run's chain depth and the holder it runs as,
	 * which the model effects its writes queue run as, one deeper (`writerOf`).
	 */
	run?: { readonly depth: number; readonly holder: Holder };
	models: { readonly [model: string]: ModelAuthority };
	automations: readonly string[];
	capabilities: {
		apps: readonly string[];
		syncs: readonly string[];
		tools: readonly string[];
		mcp: readonly string[];
	};
	limits: readonly LimitRule[];
	/** Actor variables: `actor.team_tree`, `actor.scopes.<policy>`. */
	teamTree: readonly string[];
	scopes: { readonly [policy: string]: readonly string[] };
};

// ── the guest (C2) ──
export type InvocationKind =
	| 'create'
	| 'update'
	| 'delete'
	| 'vector'
	| 'probe'
	| 'rerank'
	| 'syncRead'
	| 'syncWrite'
	| 'parse'
	| 'policy'
	| 'automation'
	| 'effect'
	| 'integration'
	| 'webhook'
	| 'page'
	| 'validation'
	| 'tool';
/** One body of a guest batch (`Guest.invokeEach`): its target and input, as an invocation's. */
export type GuestPart = { readonly target: string; readonly input: Json };
/**
 * One fresh-isolate run of one body. `target` names it: `'<model>'` (create/update/delete transforms),
 * `'<model>.<index>'` (`vector`, `probe`, `rerank`), `'<model>.<sync>'` (`syncRead`, `syncWrite`),
 * `'<model>.<sync>.<media type>'` (`parse`), `'<policy>.<model>.<op>'` (`policy`: a write grant's verdict, answering a
 * `VerdictData`), `'<a>'` (automation), `'<model>.effect.<verb>'` (effect), or `'<app>/<page>'` (page).
 */
export type Invocation = {
	id: string;
	/** The `sys_run` an automation attempt belongs to: its events (console lines among them) carry it. */
	run?: string;
	kind: InvocationKind;
	target: string;
	input: Json;
	ctx: {
		actor: EngineActor;
		now: string;
		today: string;
		tz: string;
		seed: string;
		attempt?: number;
		/** An automation run's trigger and, for a job, its id (`ctx.trigger`). */
		run?: { id?: string; trigger?: RunTrigger };
		admin?: boolean;
		policies?: readonly string[];
		/** The approving decision asks a held write's callback again, for its `on_approved`. */
		approving?: true;
		/** A sync body's or integration test's instance and configuration; `key` a sync write's `Idempotency-Key`. */
		instance?: string;
		key?: string;
		configuration?: Json;
		/** Only the member's file-sync export writer may read bytes and derive images. */
		fileExport?: true;
	};
	budget: { crossings: number; readBytes: number };
};
export type CrossAnswer =
	| { ok: true; value: Json; bins?: readonly Uint8Array[] }
	| {
			ok: false;
			error:
				| FacilityError
				| { kind: 'refused'; code: string; message: string; key?: string; values?: MessageValues; field?: string; row?: number; rows?: readonly number[]; rule?: string }
				| { kind: 'bolt'; code: string; message: string };
	  };
/** A Bolt failure crossing back to a guest; facility and authored refusal envelopes remain distinct. */
export const cross_failure = (code: string, message: string): CrossAnswer => ({
	ok: false,
	error: { kind: 'bolt', code, message }
});
export type GuestOutcome =
	| { kind: 'ok'; output: Json }
	/**
	 * `ctx.refuse(message_key, { row, field, values })`: `message` is the rendered catalogue text, `key` and `values`
	 * what rendered it; `row` indexes the batch a write callback received.
	 */
	| {
			kind: 'refused';
			message: string;
			key?: string;
			values?: MessageValues;
			code?: string;
			field?: string;
			row?: number;
			rows?: readonly number[];
			rule?: string;
			data?: { readonly request_id: string };
			records?: readonly { readonly model: string; readonly id: string }[];
			invocation?: string;
	  }
	/** A throw, a budget (`cpu_budget`, `crossing_budget`, `read_budget_exceeded`, `memory`) or a bad answer. */
	| { kind: 'failed'; error: BoltError };
export interface MembershipPort {
	/** `team` is a source team handle (`+team.ts`). */
	project(
		member: {
			user: string;
			email: string | null;
			phone: string | null;
			team: string | null;
			state: 'active' | 'inactive';
		},
		signal: AbortSignal
	): Promise<void>;
}
