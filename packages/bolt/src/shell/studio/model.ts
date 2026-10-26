// Workspace Studio's port (§5.10, §7.1): the shell renders Studio and the host that owns source, builds and releases
// answers it. Bolt names no host: one that passes no port serves no Studio; a platform maps these calls onto its own.
// The agent's authoring tools over it are the host's, never Bolt's; Bolt's own agent only reads (`workspace_search`).
import { Schema, SchemaTransformation } from 'effect';
import { STUDIO_PHASES, STUDIO_ROLES } from '../../protocol/schema.ts';
import type { Authority } from '../../engine/contracts.ts';
import type { EngineManifest } from '../../engine/manifest.ts';
import type { CheckDiagnostic } from '../../compiler/check/index.ts';
import type { StudioAuditPort } from './audit.ts';
import type { StudioInspectInput, StudioInspection } from './inspection.ts';
import { href, kioskHref } from '../nav.ts';

/** A changed file and what its diff needs: the head's `text` (absent: deleted, or not text) and the base's `baseline` (absent: added, or not text), each cut at the host's one-file text bound. */
type StudioFileChange = {
	path: string;
	change: 'added' | 'modified' | 'deleted';
	text?: string;
	baseline?: string;
};
/**
 * One file of a commit (`StudioPort.file`): its text, or `binary` (not UTF-8 text) with its size. A text past the host's
 * one-file bound is cut there, and `truncated` says so: `limit` the bound, `bytes` the whole file (the editor is then
 * read-only, so a save never writes the cut text back).
 */
export type StudioFile =
	{ text: string; truncated?: { limit: number; bytes: number } } | { binary: true; bytes: number };
export type StudioLogLine = { at: string; level: 'info' | 'warn' | 'error'; message: string };
/** One diagnostic of the last build (`bolt build --json`'s `errors`); `severity` defaults to `error` (L-BOLT-528, 530). */
export type StudioDiagnostic = CheckDiagnostic & { severity?: 'error' | 'warn' };
/**
 * A Version (§7): every merge or rollback live ran, newest first, restorable. `rollback` deploys one again as a new
 * Version, source and data together. `checkpoint`: the instant whose data rolling back to it keeps (`null`: none to roll
 * back to). `rollback`: the commit this Version rolled back to. `undo`: the state live was in just before a rollback,
 * so rolling back to it undoes that rollback. `discards`: its schema differs from live's, so rolling back to it
 * discards the data written after this instant (a fork at its latest point). `replaced`: its data point belonged to a
 * database a reset has since replaced, so it can no longer be rolled back to (`checkpoint` is then `null`).
 */
export type StudioRelease = {
	commit: string;
	at: string;
	message: string;
	current: boolean;
	checkpoint?: string | null;
	rollback?: string;
	undo?: true;
	discards?: string;
	replaced?: true;
};
/** A build of a commit, newest first: `deployed` once a Version ran it, `live` while live serves it. */
export type StudioBuild = {
	commit: string;
	at: string;
	status: 'built' | 'failed';
	message: string;
	deployed: boolean;
	live: boolean;
	lines: number;
	diagnostics: number;
};
/** One build's stored log (its last 5,000 lines, at most 1 MiB) and diagnostics, readable after the fact. */
export type StudioBuildRecord = {
	build: StudioBuild;
	log: readonly StudioLogLine[];
	diagnostics: readonly StudioDiagnostic[];
};
/** A tenant environment the host routes (`live`, a change's preview, …): `release` is the artifact it serves, `''` when unrouted. */
type StudioEnvironment = { name: string; release: string; url: string | null };
/**
 * A change's preview (§7): its own copy-on-write fork of live's data, taken when the change was opened, serving the
 * build of `commit` (`stale` once the head moved past it, while the newer head builds). `url` is `null` while it is
 * `shelved`: idle for two hours, its fork was deleted; opening the change again re-forks live and reuses the build.
 * `destructive`: the schema steps merging that build applies (a merge must accept them).
 */
export type StudioPreview = {
	url: string | null;
	commit: string;
	artifact: string;
	stale: boolean;
	shelved?: true;
	destructive?: readonly string[];
};
/**
 * A Change (§7): a named set of edits on `branch`, from live, with its own preview. `base` is where it left live (the
 * diff's other side) and `behind` how many live commits it lacks (a merge takes them in). `merge` is a merge running in
 * the background, or the reason the last one failed; a clean merge moves live and records a Version.
 */
export type StudioChangeSet = {
	id: string;
	title: string;
	state: 'open' | 'merged' | 'closed';
	openedBy: string;
	contributors: readonly string[];
	branch: string;
	base: string;
	head: string;
	behind: number;
	preview: StudioPreview | null;
	merge?: { state: 'running' | 'failed'; at: string; head: string; error?: string };
	log: readonly StudioLogLine[];
	createdAt: string;
	updatedAt: string;
	/** Its head's last build's diagnosis. */
	diagnostics?: readonly StudioDiagnostic[];
};
/**
 * The viewer's Studio: the change they have open (`change`; absent: none, and the tree is live's) — its source tree at
 * `commit` (each path's size; `StudioPort.file` reads one file's text), the diff against `base` with each changed text
 * file's two sides, how many live commits it is `behind`, the files still holding conflict markers, its last build's
 * manifest, log and preview — live's Versions newest first, every change, and the host's environments (the Operations
 * pane).
 */
/** Who is driving a change's preview: Norbius (with its conversation) or the person. */
export type PreviewControl = {
	holder: 'norbius' | 'person';
	conversation?: string;
	at?: string;
};
export type StudioState = {
	commit: string;
	/** The head commit's description (its message's first line). */
	message?: string;
	/** The live workspace's IANA timezone. */
	zone?: string;
	/** Every path of the tree with its size; never its content, so a read stays the same size as a file grows. */
	files: { readonly [path: string]: { bytes: number } };
	changes: readonly StudioFileChange[];
	manifest: EngineManifest | null;
	log: readonly StudioLogLine[];
	/** The viewer's change's preview URL (`null`: no change open, or its preview is shelved). */
	preview: string | null;
	releases: readonly StudioRelease[];
	environments?: readonly StudioEnvironment[];
	change?: string;
	branch?: string;
	previewOf?: StudioPreview;
	/** The open change's preview control; absent: nobody claimed it. */
	previewControl?: PreviewControl;
	base?: string;
	behind?: number;
	conflicts?: readonly string[];
	changeSets?: readonly StudioChangeSet[];
	/** The viewer's change's last build's diagnosis (empty: it built clean; absent: not built, or the host reports none). */
	diagnostics?: readonly StudioDiagnostic[];
	/** The retained builds, newest first; `StudioPort.build` reads one's log and diagnostics. */
	builds?: readonly StudioBuild[];
	/** The viewer's own held requests: what the agent asked to change on live, awaiting their `approval.decide`. */
	approvals?: readonly StudioApproval[];
};
/**
 * `change.open` opens a new change (`title`) — a branch from live and a copy-on-write fork of live's data for its
 * preview — or opens an existing one again (`id`): the viewer works on one change at a time. `save` commits edits to the
 * viewer's change over `expected` (a stale head is refused; with none open, the save opens one named by its message),
 * `null` deletes a file; a save commits only. `preview` is the build: it builds the head and serves it, and a merge
 * requires the preview of the head it promotes. `change.merge` merges a change into live in the background: git's 3-way merge (conflicts land in the change as
 * marked files, live untouched), a build of the merged tree with its checks, then the cutover; `accept` names the
 * destructive schema steps it may apply (any other refuses it). `change.close` drops a change and its preview.
 * `rollback` brings a Version back, source and data together, recording the state it leaves as an Undo Version first;
 * a schema change refuses it unless `discardDataSince` names the instant whose later writes it discards. It is neither
 * the operator's database restore nor a record's restore. `approval.decide` approves (it runs as the viewer) or rejects
 * one of the viewer's held requests (`StudioState.approvals`).
 */
const nonempty = Schema.NonEmptyString;
const truncated = (max: number) =>
	nonempty.pipe(
		Schema.decodeTo(
			Schema.String,
			SchemaTransformation.transform({
				decode: (s: string) => s.slice(0, max),
				encode: (s: string) => s
			})
		)
	);
const safePath = Schema.NonEmptyString.check(
	Schema.makeFilter((p: string) => !p.startsWith('/') && !p.split(/[/\\]/).includes('..'))
);
/** Every browser op is decoded at the shell boundary. */
export const StudioOp = Schema.Union([
	Schema.Struct({
		op: Schema.Literal('save'),
		expected: Schema.String,
		/** What the change does, in the author's words: the commit message (absent: the host names the changed paths). */
		message: Schema.optionalKey(truncated(200)),
		files: Schema.Record(Schema.String, Schema.NullOr(Schema.String)).check(
			Schema.makeFilter((files) => Object.keys(files).every(Schema.is(safePath)))
		)
	}),
	Schema.Struct({
		op: Schema.Literal('preview'),
		/** The explicit change; absent uses the viewer's selected change. */
		id: Schema.optionalKey(nonempty)
	}),
	Schema.Struct({ op: Schema.Literal('preview.claim'), id: nonempty }),
	Schema.Struct({ op: Schema.Literal('preview.release'), id: nonempty }),
	Schema.Struct({
		op: Schema.Literal('package.install'),
		name: nonempty,
		version: nonempty
	}),
	Schema.Struct({ op: Schema.Literal('change.open'), title: truncated(200) }),
	Schema.Struct({ op: Schema.Literal('change.open'), id: nonempty }),
	Schema.Struct({
		op: Schema.Literal('change.merge'),
		id: nonempty,
		accept: Schema.optionalKey(Schema.Array(nonempty))
	}),
	Schema.Struct({ op: Schema.Literal('change.close'), id: nonempty }),
	Schema.Struct({
		op: Schema.Literal('rollback'),
		commit: nonempty,
		discardDataSince: Schema.optionalKey(nonempty)
	}),
	Schema.Struct({
		op: Schema.Literal('approval.decide'),
		id: nonempty,
		kind: Schema.Literals(['approved', 'rejected'])
	})
]);
export type StudioOp = typeof StudioOp.Type;
/**
 * A live-changing op (a merge, a rollback) the agent asked for, held for its requestor: it runs as them once they
 * approve it. `head`: the change's head it was asked on (a moved one refuses the approval); `destructive`: the schema
 * steps approving a merge accepts.
 */
export type StudioApproval = {
	id: string;
	op: StudioOp;
	requestor: string;
	conversation: string;
	at: string;
	head?: string;
	destructive?: readonly string[];
};
/** An authoring phase (L-BOLT-530): diagnose (the build's checks) → copy (the preview's data) → preview → merge. */
export const PHASES = STUDIO_PHASES;
export type StudioPhase = (typeof PHASES)[number];
export type PhaseState = 'running' | 'done' | 'failed';
export type StudioRole = (typeof STUDIO_ROLES)[number];
export { STUDIO_ROLES };
/** A pushed authoring frame: a build log line, a head moved (someone else saved), a change changed, a phase or task moved. */
export type StudioFrame =
	| { kind: 'log'; line: StudioLogLine }
	| { kind: 'source'; commit: string }
	| { kind: 'change'; id: string }
	| { kind: 'phase'; phase: StudioPhase; state: PhaseState };
/** Called for an administrator; the host decides what each may do, a refusal is a thrown `BoltError`. */
export type StudioPort = {
	state(auth: Authority): Promise<StudioState>;
	run(auth: Authority, op: StudioOp): Promise<StudioState>;
	/** One file at a commit (`StudioState.commit`, or a change's base); `null`: no such file there. */
	file(auth: Authority, commit: string, path: string): Promise<StudioFile | null>;
	/** One build's stored log and diagnostics by its commit (a unique prefix); `null`: no such build is retained. */
	build?(auth: Authority, commit: string): Promise<StudioBuildRecord | null>;
	/** This workspace's frames as they happen, never another's; answers the unsubscribe. Absent → no live stream. */
	watch?(auth: Authority, send: (frame: StudioFrame) => void): () => void;
	/** This workspace's own resource use over time (an administrator's). Absent → no Usage view. */
	usage?(auth: Authority): Promise<StudioUsage>;
	/** Curated operational diagnostics shared with Realm across the current HOST_API contract. */
	inspect(auth: Authority, input: StudioInspectInput): Promise<StudioInspection>;
	/** The organization's audit rules and audits (an administrator's). Absent → no Audit rules view. */
	audit?: StudioAuditPort;
};
/**
 * The host's metering of this workspace: one chart per measure, each point a time (epoch milliseconds) and the peak or
 * total of its interval (null when unmeasured). `unit` is `bytes`, `MiB`, `seconds`, `micro-SGD` or a plain count noun.
 */
export type StudioUsage = {
	charts: readonly {
		title: string;
		unit: string;
		points: readonly { at: number; value: number | null }[];
	}[];
};

export const SECTIONS = [
	'models',
	'apps',
	'kiosks',
	'policies',
	'automations',
	'remotes',
	'secrets'
] as const;
export type Section = (typeof SECTIONS)[number];
/** A declaration: its path-derived name, the source file it comes from (rule 1), and where it opens (an app). */
type StudioEntry = { name: string; path: string; href?: string };
/**
 * What the browser gets: the state with the manifest cut to each Manifest chip's entries. `sections` is `null` before a
 * build, and also when the build is `stale`: a declaration whose source file the workbench no longer holds fails the
 * whole projection closed, so the pane never links into files that are gone.
 */
export type StudioView = Omit<StudioState, 'manifest'> & {
	sections: { readonly [s in Section]: readonly StudioEntry[] } | null;
	stale?: true;
};

export function studioView({ manifest: m, ...rest }: StudioState): StudioView {
	if (m === null) return { ...rest, sections: null };
	const at = (o: object | undefined, path: (name: string) => string) =>
		Object.keys(o ?? {})
			.sort()
			.map((name) => ({ name, path: path(name) }));
	const sections = {
		models: at(m.models, (n) => `src/data/model/${n}/+model.ts`),
		apps: at(m.apps, (n) => `src/app/${n}/+app.ts`).map((e) => ({ ...e, href: href(e.name) })),
		kiosks: at(m.kiosks, (n) => `src/kiosk/${n}/+kiosk.ts`).map((e) => ({
			...e,
			href: kioskHref(e.name)
		})),
		policies: at(m.policies, (n) => `src/access_control/policy/+${n}.policy.ts`),
		automations: at(m.automations, (n) => `src/automation/+${n}.automation.ts`),
		remotes: [
			...at(m.mcp, (n) => `src/agent/mcp/+${n}.mcp.ts`),
			...at(m.integrations, (n) => `src/integration/${n}/+integration.ts`)
		],
		secrets: at(m.workspace.secrets, () => 'src/+secrets.ts')
	};
	const stale = Object.values(sections).some((es) => es.some((e) => !(e.path in rest.files)));
	return stale ? { ...rest, sections: null, stale: true } : { ...rest, sections };
}

/** Drafts left after a save of `saved` lands: a path edited again while the save was in flight keeps its newer draft. */
export function settleDrafts<T>(
	drafts: { readonly [path: string]: T },
	saved: { readonly [path: string]: T }
): { [path: string]: T } {
	return Object.fromEntries(
		Object.entries(drafts).filter(([p, v]) => !(p in saved) || saved[p] !== v)
	);
}

const LOG_RING = 256,
	LOG_CLIP = 800;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** A pushed log line folded into the log: ANSI stripped (its level colours it), clipped to 800 characters, the last 256 kept. */
export function foldLog(log: readonly StudioLogLine[], line: StudioLogLine): StudioLogLine[] {
	const message = line.message.replace(ANSI, '');
	return [
		...log,
		{ ...line, message: message.length > LOG_CLIP ? `${message.slice(0, LOG_CLIP)}…` : message }
	].slice(-LOG_RING);
}

/** A pushed phase folded into the progress strip: a phase starting again clears the phases after it (a new run). */
export function foldPhase(
	phases: { readonly [p in StudioPhase]?: PhaseState },
	phase: StudioPhase,
	state: PhaseState
): { [p in StudioPhase]?: PhaseState } {
	const at = PHASES.indexOf(phase);
	const kept =
		state === 'running'
			? Object.fromEntries(
					Object.entries(phases).filter(([p]) => PHASES.findIndex((phase) => phase === p) < at)
				)
			: { ...phases };
	return { ...kept, [phase]: state };
}

/**
 * The furthest phase a run has reached (-1: none yet). A frame of an earlier phase never moves it back, so the progress
 * strip only advances until the run ends.
 */
export function reach(step: number, phase: StudioPhase): number {
	return Math.max(step, PHASES.indexOf(phase));
}
/** The progress strip's words for `reach`'s step. */
export const STEPS = [
	'Getting ready…',
	'Building…',
	'Copying data…',
	'Starting the preview…',
	'Switching over…'
] as const;
export const stepLabel = (step: number): (typeof STEPS)[number] => STEPS[step + 1] ?? STEPS[0];
/** A size in bytes as the tree shows it (`512B`, `3K`, `2M`). */
export const sizeText = (n: number) =>
	n < 1024
		? `${n}B`
		: n < 1024 * 1024
			? `${Math.round(n / 1024)}K`
			: `${Math.round(n / (1024 * 1024))}M`;
/** A running step's elapsed time as `m:ss`. */
export const elapsedText = (ms: number) => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** A plain suggestion for a save's description from the drafts (`null`: deleted) over the saved tree. */
export function suggestMessage(
	drafts: { readonly [path: string]: string | null },
	files: StudioState['files']
): string {
	const words = Object.entries(drafts).map(([path, text]) => {
		const segments = path.split('/'),
			file = segments.at(-1) ?? path,
			folder = segments.at(-2);
		const parts = file.replace(/^\+/, '').split('.');
		const name =
			parts.length > 2
				? `${parts[0]} ${parts[1]}`
				: file.startsWith('+') && folder !== undefined
					? `${folder} ${parts[0]}`
					: (parts[0] ?? path);
		return `${text === null ? 'Remove' : path in files ? 'Update' : 'Add'} ${name}`;
	});
	return words.length <= 2 ? words.join(', ') : `${words[0]} and ${words.length - 1} more files`;
}

/** The environment the Operations pane summarizes: `live` when routed, else the first routed one; none routed → undefined. */
export function routedEnvironment(
	envs: readonly StudioEnvironment[] | undefined
): StudioEnvironment | undefined {
	const routed = (envs ?? []).filter((e) => e.release !== '');
	return routed.find((e) => e.name === 'live') ?? routed[0];
}

/** An age as a short phrase (`just now`, `5m`, `3h`, `2d`); an unreadable instant answers `''`. */
export function ageText(since: string | null, now: number): string {
	const at = since === null ? NaN : Date.parse(since);
	if (!Number.isFinite(at)) return '';
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	return minutes < 1
		? 'just now'
		: minutes < 60
			? `${minutes}m`
			: minutes < 1440
				? `${Math.floor(minutes / 60)}h`
				: `${Math.floor(minutes / 1440)}d`;
}
/** L-BOLT-528: the CodeEditor language a path is edited in. */
export function languageOf(path: string): 'javascript' | 'json' | 'plaintext' {
	return /\.(?:[cm]?[jt]s|svelte)$/.test(path)
		? 'javascript'
		: path.endsWith('.json')
			? 'json'
			: 'plaintext';
}
/** L-BOLT-528: every folder holding a draft (the tree marks it with a dot). */
export function dirtyFolders(paths: Iterable<string>): Set<string> {
	const dirs = new Set<string>();
	for (const p of paths)
		for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) dirs.add(p.slice(0, i + 1));
	return dirs;
}
