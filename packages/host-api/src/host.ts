import type { Json } from '@norbital-ai/store';
// What a host hands a release and gets back: the ports of one serving generation (`HostPorts`), a branch it prepares
// or administers (`BranchPorts`), an environment's integration links (`LinkHost`), and the full `HostApi` a release answers.
// Promise + AbortSignal throughout; an answer the host interprets rejects with an encoded `HostApiFailure`.
import { Schema } from 'effect';
import type { MintedSession, FounderAnswer } from './answers.ts';
import type { AuditPort } from './audit.ts';
import type { Authority, AgentMark } from './authority.ts';
import type { HostTenantDb } from './db.ts';
import type { BrowserPort } from './browser.ts';
import type {
	BundlerPort,
	ConvertPort,
	DeadlinesPort,
	Facilities,
	FilesPort,
	GeocoderPort,
	KeysPort,
	McpPort,
	RenderPort,
	TcpPort,
	WebReadPort
} from './facilities.ts';
import type { GuestIsolatesPort } from './guest.ts';
import type { ImagesPort } from './media.ts';
import type {
	InstanceAdmin,
	LinksPort,
	OAuthClient,
	OAuthVendor,
	Provider
} from './integrations.ts';
import type { MigrationImpact } from './migration-impact.ts';
import type { Off } from './off.ts';
import type { HostApiCore, Release, Signal } from './ports.ts';
import type { StudioPort } from './studio.ts';
import type {
	HostSkill,
	HostTool,
	SearchAnswer,
	SearchRequest,
	WorkspaceNote,
	WorkspacePort
} from './tools.ts';

// ── what the host hands over ──
/** A host banner above every page; `href` is its one action. */
export type ShellNotice = {
	text: string;
	tone?: 'info' | 'warning';
	href?: string;
	action?: string;
};
/** Another workspace the caller belongs to, for the shell's switcher. */
export type WorkspaceLink = { handle: string; name: string; href: string };
/** The shell's host parts; `studio` and `organization.write` may reject with an encoded `HostFailure`. */
export type ShellPorts = {
	/** Read on every request: the host may rename or rebrand the workspace while it serves. */
	readonly workspace: () => {
		readonly name: string;
		readonly handle: string;
		readonly icons?: readonly {
			readonly src: string;
			readonly sizes: string;
			readonly type: string;
		}[];
	};
	readonly push?: { readonly public_key: string };
	readonly studio?: StudioPort;
	/** The agent panel is offered. */
	readonly ai?: boolean;
	/** The environment badge's name (`production` shows none). */
	readonly environment?: string;
	readonly notice?: (auth: Authority) => Promise<ShellNotice | null>;
	readonly organization?: {
		write(auth: Authority, branding: { logo: string | null }): Promise<void>;
	};
	/** The host's apex origin (sign-in hand-off, the workspace switcher). */
	readonly apex?: string;
	/** Set when this shell serves a preview environment: the live workspace's address (the preview banner's link). */
	readonly live?: string;
	/**
	 * Where an administrator repairs this workspace when it will not open (the host's recovery Studio). A host with no
	 * recovery of its own (a self-hosted server) sets none; the failure card then offers only a retry.
	 */
	readonly recovery?: string;
	/**
	 * Where an administrator sees this workspace's usage, cost, payment card and invoices (the host's billing page);
	 * Settings links it. A host that bills nothing sets none.
	 */
	readonly billing?: string;
	readonly workspaces?: (auth: Authority) => Promise<readonly WorkspaceLink[]>;
	/**
	 * The shell's Feedback dialog: `send` takes what a person wrote, `sent` answers what that person sent before and
	 * what became of each. A host that takes no feedback sets none and the shell offers no dialog.
	 */
	readonly feedback?: {
		readonly send: (auth: Authority, feedback: Feedback) => Promise<void>;
		readonly sent: (auth: Authority) => Promise<readonly SentFeedback[]>;
	};
	/** Page views as the shell saw them, in order; a host that keeps no usage sets none and the shell sends nothing. */
	readonly usage?: (auth: Authority, views: readonly PageView[]) => Promise<void>;
};
/** What a host tool list is for: one agent conversation, or one automation run's inference. */
export type ToolSubject =
	| { readonly conversation: string }
	| { readonly run: string };
/**
 * A system agent's task: an agent conversation no person attends, acting as the system under `policies`. `run` names
 * it to its starter (the automation run, or the host's own id for the work).
 */
export const TaskStart = Schema.Struct({
	run: Schema.String,
	/** The conversation's title: three to five words. */
	description: Schema.String,
	prompt: Schema.String,
	/** Stored file references the task's first message carries (a feedback's, as the shell sent them). */
	files: Schema.optionalKey(Schema.Array(Schema.Json))
});
export type TaskStart = typeof TaskStart.Type;
/** How a task ended: `completed` with its last words, `question` when they ask its starter, `error` or `cancelled`. */
export type TaskEnd = {
	readonly run: string;
	readonly conversation: string;
	readonly state: 'completed' | 'question' | 'error' | 'cancelled';
	readonly text: string;
};
/** What a person sent from the shell's Feedback dialog: their words, the files they attached and the page they were on. */
export type Feedback = {
	readonly text: string;
	/** Stored file references of what they attached, as an agent message carries them. */
	readonly files: readonly Json[];
	readonly route: string;
};
/** Something a person sent before, as its sender sees it: their words, where it stands and the last word on it. */
export const SentFeedback = Schema.Struct({
	id: Schema.String,
	text: Schema.String,
	at: Schema.String,
	/** `received`: nobody works on it yet; `working`: being worked on; `done`: live has the fix; `closed`: dismissed; `platform`: passed to the platform. */
	status: Schema.Literals(['received', 'working', 'done', 'closed', 'platform']),
	/** The assistant's last report on it or an administrator's last reply, whichever is later. */
	reply: Schema.NullOr(
		Schema.Struct({
			by: Schema.Literals(['assistant', 'administrator']),
			text: Schema.String,
			at: Schema.String
		})
	)
});
export type SentFeedback = typeof SentFeedback.Type;
/** One page a person had open: its route pattern (no record id, no query) and how long it stayed open. */
export type PageView = {
	readonly route: string;
	readonly dwell_ms: number;
};
/** The agent's host parts; the release's own source (`workspace_grep`) and attachments are the release's. */
export type AgentPorts = {
	/** The person's current working source (the default for source tools); none where they author nothing. */
	readonly draft?: (a: Authority) => Promise<WorkspacePort | undefined>;
	/** ripgrep over this author's working tree (`workspace_grep`). */
	readonly search?: (a: Authority, request: SearchRequest) => Promise<SearchAnswer | undefined>;
	/**
	 * Host tools (Workspace Studio authoring, browser, personal skills): a fixed list, or the actor's catalogue per turn.
	 * `subject` is what the tools work for: an agent conversation, or an automation run's inference.
	 */
	readonly host_tools?:
		| readonly HostTool[]
		| ((a: Authority, subject: ToolSubject) => Promise<readonly HostTool[]>);
	/** A system agent's task ended (`ActiveWorkspace.task`, `ctx.ai.sys_2.task`): told once, whatever ended it. */
	readonly task_ended?: (end: TaskEnd) => Promise<void>;
	/** An administrator turned the host's own tasks on (`ActiveWorkspace.task` was refused until now): it may start what waits. */
	readonly tasks_enabled?: () => Promise<void>;
	/** Host skills merged into `skill` on in-app staff turns: the platform authoring skill, the person's own skills. */
	readonly skills?: (a: Authority) => Promise<{ readonly [name: string]: HostSkill }>;
	/** Reject pending host tool approvals from the previous turn; return only IDs actually rejected. */
	readonly on_turn_start?: (conversation: string) => Promise<readonly string[]>;
	/**
	 * Workspace events after `since` (ISO), oldest first: an in-app conversation hears each one once, at its next step.
	 * The release's wake also delivers them to the inbox.
	 */
	readonly events?: (since: string) => Promise<readonly WorkspaceNote[]>;
};
/**
 * One serving generation of an environment: the host's `facilities` and what it serves around them. Every member is
 * required; one the host may leave out takes `off`.
 */
export type HostPorts = {
	readonly facilities: Facilities;
	/** This environment's epoch (a fork's rows are never sent). */
	readonly epoch?: string;
	/** `<tenant>/<environment>`: the deadlines scope and the log key. */
	readonly scope: string;
	readonly release: Release;
	/** The workspace's public URL with its path prefix (`https://host/acme`), no trailing slash. */
	readonly public_url: string;
	/** The host's own guest runner: isolates it makes, meters and ends for guest code (bodies, page loaders, `run_js`). */
	readonly guests: GuestIsolatesPort;
	readonly deadlines: DeadlinesPort;
	readonly images: ImagesPort;
	/** The confined bundler for the agent's file runs; `off`, `run_js` runs inline code only. */
	readonly bundler: BundlerPort | Off;
	readonly convert: ConvertPort | Off;
	/** The host's headless browser printing a record's print route (`ctx.convert.record`); `off`, that call is unavailable. */
	readonly render: RenderPort | Off;
	readonly geocoder: GeocoderPort | Off;
	readonly web: WebReadPort | Off;
	readonly browser: BrowserPort | Off;
	readonly mcp: McpPort | Off;
	/** The environment's live integration links. */
	readonly links: LinksPort | Off;
	readonly shell: ShellPorts;
	readonly agent: AgentPorts;
	/** The kernel's meter: as each run of a wake starts, the run begins the next unit, with a CPU budget of its own. */
	readonly units?: { next(): Promise<void> };
	/**
	 * Why the previous generation ended, when the kernel stopped it past a unit's CPU budget: the runs it left `running`
	 * fail `cpu_budget` with this message instead of rerunning (they would only overrun again).
	 */
	readonly overran?: string;
};
/**
 * A branch the host works on outside any serving generation: the lifecycle prepares one (provision, reset, probe,
 * restore), and an operator changes a live one's integration instances. No guest code runs.
 */
export type BranchPorts = {
	readonly release: Release;
	readonly database: HostTenantDb;
	/** The environment's durable host store; founder bootstrap, which mutates identity, refuses without it. */
	readonly audit?: AuditPort;
	/** As `LinkHost.keys`: credential restore seals through it, and refuses without it. */
	readonly keys?: KeysPort;
};
/** An integration instance's row, as its sealed credentials open with it. */
export type InstanceRow = {
	readonly integration: string;
	readonly owner: string | null;
	readonly active: boolean;
	readonly configuration: Json;
	readonly import_start: Json | null;
};
/** An environment's sealed integration credentials, under each instance's epoch; a failure is encoded. */
export type HostCredentials = {
	open(instance: string): Promise<{
		epoch: string;
		row: InstanceRow;
		values: ReadonlyMap<string, Json>;
	}>;
	read(instance: string): Promise<{
		epoch: string | null;
		row: InstanceRow;
		values: ReadonlyMap<string, Json>;
	}>;
	write(
		instance: string,
		epoch: string | null,
		changes: ReadonlyMap<string, Json | null>,
		rotate?: boolean
	): Promise<string | null>;
};
/** An environment's integration links: they outlive idle generations and re-enter the current one. */
export type LinkHost = {
	readonly release: Release;
	readonly database: HostTenantDb;
	/** As `Facilities.keys`: the sealed credentials open through it. */
	readonly keys: KeysPort;
	/** As `HostPorts.public_url`: every webhook URL and the OAuth callback are under it. */
	readonly public_url: string;
	readonly providers: readonly Provider[];
	/** The host's OAuth clients (Google), signing in every definition that names none of its own. */
	readonly oauth?: Partial<Record<OAuthVendor, OAuthClient>>;
	/** Runs `work` on the scope's current generation, outside compute admission (a link's ingest). */
	enter<T>(work: (workspace: ActiveWorkspace) => Promise<T>): Promise<T>;
	/** As `enter`, admitted under the compute envelope (a guest body: a custom conversation's webhook, a test send). */
	admit<T>(work: (workspace: ActiveWorkspace) => Promise<T>): Promise<T>;
	/** Wraps the sealed credentials the links write through, so credential I/O can survive a retirement. */
	credentials?(sealed: HostCredentials): HostCredentials;
	/** The providers' network: a cell has no `fetch` of its own. */
	readonly fetch: typeof fetch;
	/** The providers' TCP/TLS (IMAP, SMTP), as `Facilities.ports.outbound.tcp`. */
	readonly tcp: TcpPort;
	log?(line: string): void;
};

// ── what the host gets ──
/** One cron the manifest declares: an automation's (`id` its name) or a remote sync's periodic read. */
export type CronEntry = { readonly id: string; readonly cron: string; readonly zone: string };
/**
 * `ran: false`: a repeat of `(id, slot)`, a run that only read and wrote nothing, or a resting cron. `until`: the cron
 * rests, and while the workspace is not in use the host need not fire it before this instant.
 */
export type CronFired = { readonly ran: boolean; readonly until?: string };
/** A release activated for one workspace: the routes it serves, its renders, crons and lifecycle as the host drives them. */
export type ActiveWorkspace = {
	/**
	 * The release's routes for this generation, the request as the workspace sees it (no host prefix): the shell host
	 * (`/__bolt/session/*`, `/__bolt/shell*`, the PWA manifest), files, the data protocol and `/hooks/<path>` automation
	 * webhooks; `null` when none is the release's. Event streams end when the generation closes.
	 */
	handle(request: Request, options: { readonly address: string }): Promise<Response | null>;
	/**
	 * Protected public-page loading and HTML rendering share one read-only guest invocation. A host routes public
	 * documents here before static client serving, passing the original request and keeping the returned cookies,
	 * status, cache and content-security headers; serving `index.html` for a public route bypasses rendering.
	 */
	render(
		request: Request,
		options: Signal & { readonly address: string }
	): Promise<Response | null>;
	/** One deadline wake: every due run of the environment, then `deadlines.settle`. */
	wake(options: Signal): Promise<void>;
	/** Signal work due during an existing wake without entering another compute envelope. */
	pulse(options: Signal): Promise<boolean>;
	/** Every cron the manifest declares; the host's clock computes their slots. */
	crons(): Promise<readonly CronEntry[]>;
	/** Runs cron `id` for `slot` (an ISO minute), once per `(id, slot)`; `ran: false` for a repeat or a run that wrote nothing. */
	fire(id: string, slot: string, options: Signal): Promise<CronFired>;
	/**
	 * A planned close: ordinary pages and requests go on; no new job or automation call starts. Active automations get `automations_ms` to end, while
	 * turns work on; then every turn holds at its next step. Answers once no step is running; the host then closes the
	 * generation and the next one takes the turns over. A host bounds the wait.
	 */
	park(options: Signal & { readonly automations_ms: number }): Promise<void>;
	/** Interrupts every guest invocation and in-flight crossing of this generation; the host then ends its pool. */
	close(): Promise<void>;
	/**
	 * The host's word to an agent conversation (the end of work it carried on for a turn, such as a host tool's job):
	 * one queued system note that wakes the conversation. `id` makes it once: a repeat of `(conversation, id)` adds
	 * nothing, across restarts, and answers `false`. A conversation that does not exist is refused.
	 */
	notify(note: { readonly conversation: string; readonly text: string; readonly id: string }, options: Signal): Promise<boolean>;
	/**
	 * Starts a system agent on `task` under the policies the workspace's administrator set for host tasks, and answers
	 * its conversation. Once per `run`: a repeat answers the same conversation and starts nothing. Refused at the
	 * workspace's system spending limit. Its end is told through `AgentPorts.task_ended`.
	 */
	task(task: TaskStart, options: Signal): Promise<string>;
	readonly identity: {
		/** The caller's authority from the request's session, or `null`. */
		authority(request: Request, options: Signal): Promise<Authority | null>;
		/** `session.mint` for an active member; `null` for none. `agent`: minted for the agent's browser (`Authority.agent`). */
		mint(
			user: string,
			options: Signal & { readonly agent?: AgentMark }
		): Promise<MintedSession | null>;
	};
};
/** A seed asset a restore reads: its path in the pack, digest, size and media type. */
export type SeedAsset = {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly content_type: string;
};
/** One pack-load step's answer: `more` to enter again, `loaded`, or `hadRows` (the branch had rows; nothing changed). */
export const PackStep = Schema.Literals(['more', 'loaded', 'hadRows']);
export type PackStep = typeof PackStep.Type;
/**
 * A pack load in bounded steps ("Limits and liveness"): the host enters `step` once per unit of work
 * until it answers other than `more`. Each step commits on its own, so a failed load leaves the steps before it: load
 * into a branch the host drops on failure.
 */
export type PackLoad = {
	step(options: Signal): Promise<PackStep>;
};
/** A branch of a workspace database the host prepared: its schema migration, seed pack loads and identity. */
export type WorkspaceBranch = {
	readonly schema: {
		/**
		 * Engine tables, then the release's schema plan (destructive steps only when accepted). Answers what it
		 * did: each pending step's rows and the whole duration, measured on this branch.
		 */
		migrate(
			options: Signal & { readonly accept?: true | readonly string[] }
		): Promise<MigrationImpact>;
	};
	readonly packs: {
		/** The release's seed pack by name (`base`), its assets into `files` when given, ready to load in steps. */
		load(
			pack: string,
			options: Signal & { readonly at: string; readonly files?: FilesPort }
		): Promise<PackLoad>;
		/**
		 * Rows `bolt seed` sent, held only in memory, decoded here and loaded in steps like a pack; each of
		 * `assets` is read through `asset` into `files`.
		 */
		restore(
			rows: { readonly [model: string]: readonly { readonly [field: string]: Json }[] },
			options: Signal & {
				readonly at: string;
				readonly start: readonly string[];
				readonly assets: readonly SeedAsset[];
				readonly asset: (path: string, options: Signal) => Promise<Uint8Array>;
				readonly files: FilesPort;
			}
		): Promise<PackLoad>;
	};
	readonly identity: {
		founder(address: string, options: Signal & { readonly at: string }): Promise<FounderAnswer>;
		capture(options: Signal): Promise<string>;
		restore(snapshot: string, options: Signal): Promise<void>;
	};
	/**
	 * Integration instances as the host's operator changes them, for a host whose links on this branch are stopped (it
	 * reopens them after). Each change bumps the row's `revision` and commits on its own; values never leave the release.
	 */
	readonly integrations: {
		/** A restored branch's session instances lose their credentials and read `unpaired`. */
		unpair_sessions(options: Signal): Promise<void>;
		/** One instance as an operator observes it; `not_found` for no such instance. */
		status(instance: string, options: Signal): Promise<InstanceAdmin>;
		/**
		 * Pauses or resumes an instance and deploys or detaches its envoy (an active one, on a workspace conversation
		 * instance, else `invalid`), fenced by the `revision` its status read: `conflict` when it moved. Credentials stay.
		 */
		configure(
			instance: string,
			change: { readonly active: boolean; readonly envoy: string | null; readonly revision: number },
			options: Signal
		): Promise<InstanceAdmin>;
		/**
		 * Replaces every sealed credential of an instance with `values` under a rotated epoch, fencing any earlier link.
		 * The instance is paused first, so a failed or interrupted restore leaves it paused; then it takes `active` and
		 * reads `unpaired` until its own link opens. `conflict` when another link moved its epoch meanwhile.
		 */
		restore(
			instance: string,
			values: { readonly [name: string]: Json },
			options: Signal & { readonly active: boolean }
		): Promise<void>;
	};
};
/** A workspace's integration links: their port, sealed credentials, hooks and the open count the host reads to idle them. */
export type WorkspaceLinks = {
	/** Relayed, not interpreted: hand it to `activate` as `links`; its failures are the release's own. */
	readonly port: LinksPort;
	/** The sealed credentials the links write through, failures encoded (another owner's `LinkHost.credentials` may retry here). */
	readonly credentials: HostCredentials;
	/** Reopens every active, paired instance this host's providers serve. */
	resume(options: Signal): Promise<void>;
	/** How many links are open now: with none, the host may close these links until it needs them again. */
	open(): Promise<number>;
	/** Closes every link; status streams end. The host then ends its pool. */
	close(): Promise<void>;
	/** `/hooks/integration/<instance>…` and `/hooks/oauth/callback`, the request as the workspace sees it; `null` otherwise. */
	hook(request: Request): Promise<Response | null>;
	/**
	 * `/__bolt/integrations/*` for a caller the current generation signs in (`LinkHost.enter`); `null` for another
	 * path.
	 */
	admin(request: Request): Promise<Response | null>;
};
/** A release's schema state, opaque to the host: it stores one and hands it back to `schema.destructive`. */
export const SchemaSlice = Schema.Json;
export type SchemaSlice = typeof SchemaSlice.Type;
/** A tree's `migrations/`: each file's text by its path in the tree (`migrations/0002_notes.sql`). */
const Migrations = Schema.Record(Schema.String, Schema.String);
/**
 * `schema.carry`'s input, each side a tree's `migrations/`: `base` where an author's line left live, `live` live's now,
 * and `line` each of the line's commits, oldest first.
 */
export const MigrationCarry = Schema.Struct({
	base: Migrations,
	live: Migrations,
	line: Schema.Array(Migrations)
});
export type MigrationCarry = typeof MigrationCarry.Type;
/**
 * One of the author's migrations set on top of live: `path` the author's, `target` its place after live's. Its file is
 * `text`, or, where the author edited what the generator wrote, the host's three-way merge of `merge.theirs` (the
 * author's file) from `merge.base` (what the generator wrote them) onto `merge.ours` (what it writes on live).
 * `clashes` say, in plain words, why it must stop for the author. `snapshot` and `lock` are the `migrations/` files after
 * it, and `at` the line's commit that brought it.
 */
export const CarriedMigration = Schema.Struct({
	path: Schema.String,
	target: Schema.String,
	text: Schema.optionalKey(Schema.String),
	merge: Schema.optionalKey(
		Schema.Struct({ base: Schema.String, ours: Schema.String, theirs: Schema.String })
	),
	clashes: Schema.Array(Schema.String),
	snapshot: Schema.String,
	lock: Schema.String,
	at: Schema.Number
});
export type CarriedMigration = typeof CarriedMigration.Type;
/**
 * The versioned boundary a host drives one release through: Promise + AbortSignal calls with Schema JSON answers,
 * so hosts and releases on different module graphs interoperate.
 */
export type HostApi = HostApiCore & {
	/** Whether a request may run a guest body, so the host admits only these under its compute envelope. */
	needs_guest(request: Request): Promise<boolean>;
	readonly schema: {
		/** The schema state the release plans from (what a successor's plan is diffed against). */
		slice(release: Release, options: Signal): Promise<SchemaSlice>;
		/** The destructive steps planning `release` over `applied` (another release's `slice`) would take. */
		destructive(
			applied: SchemaSlice,
			release: Release,
			options: Signal
		): Promise<readonly string[]>;
		/**
		 * An author's migrations set on top of live's, with this release's generator: a merged migration stays byte for
		 * byte, the author's are renumbered after it and written again from live's schema. Rejects when nothing can be
		 * written (an unreadable snapshot, a rename of something live dropped).
		 */
		carry(input: MigrationCarry, options: Signal): Promise<readonly CarriedMigration[]>;
	};
	/**
	 * Applies the artifact's verified migration files (checksummed, one transaction each under the `bolt:schema`
	 * advisory lock, ledger and receipt committed with the file) and activates the release. Refuses a bundle whose
	 * recorded needs name a facility left `off`, live schema drift from the verified lock (even when every applied
	 * checksum matches), and a database with no migration ledger: an existing schema is never adopted.
	 */
	activate(ports: HostPorts, options: Signal): Promise<ActiveWorkspace>;
	branch(ports: BranchPorts, options: Signal): Promise<WorkspaceBranch>;
	links(host: LinkHost, options: Signal): Promise<WorkspaceLinks>;
};
