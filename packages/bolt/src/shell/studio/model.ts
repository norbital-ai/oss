// Workspace Studio's port (§5.10, §7.1): the shell renders Studio and the host that owns source, builds and releases
// answers it. Bolt names no host: one that passes no port serves no Studio; a platform maps these calls onto its own.
// The agent's authoring tools over it are the host's, never Bolt's; Bolt's own agent only reads (`workspace_search`).
import { Schema, SchemaTransformation } from 'effect';
import { STUDIO_PHASES, STUDIO_ROLES } from '../../protocol/schema.ts';
import type { Authority } from '../../engine/contracts.ts';
import type { EngineManifest } from '../../engine/manifest.ts';
import type { CheckDiagnostic } from '../../compiler/check/index.ts';
import { href, kioskHref } from '../nav.ts';

type StudioChange = { path: string; change: 'added' | 'modified' | 'deleted' };
export type StudioLogLine = { at: string; level: 'info' | 'warn' | 'error'; message: string };
/** One diagnostic of the last build (`bolt build --json`'s `errors`); `severity` defaults to `error` (L-BOLT-528, 530). */
export type StudioDiagnostic = CheckDiagnostic & { severity?: 'error' | 'warn' };
/**
 * A deployment: a recorded commit live ran, oldest last; `rollback` deploys one again as a new deployment, keeping the
 * data. `checkpoint`: when its restore point was taken (`null`: none to roll back to). `rollback`: the commit this
 * deployment rolled back to. `discards`: its schema differs from live's, so rolling back to it discards the data written
 * after this instant (a database restore to its restore point). `replaced`: its restore point belonged to a database a
 * reset has since replaced, so it can no longer be rolled back to (`checkpoint` is then `null`).
 */
export type StudioRelease = {
	commit: string;
	at: string;
	message: string;
	current: boolean;
	checkpoint?: string | null;
	rollback?: string;
	discards?: string;
	replaced?: true;
};
/** A build of a commit, newest first: `deployed` once a deployment ran it, `live` while live serves it. */
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
/** A tenant environment the host routes (`live`, `preview`, …): `release` is the artifact it serves, `''` when unrouted. */
type StudioEnvironment = { name: string; release: string; url: string | null };
type StudioDecision = {
	kind: 'approved' | 'changes_requested' | 'rejected';
	by: string;
	at: string;
	commit: string;
	reason: string | null;
};
type StudioComment = { by: string; at: string; text: string };
/**
 * A merge request (L-COL-190): a pointer to an author's `branch`, from `base` (a live commit) to its `head`. A decision
 * names the head it was made on, so a later commit clears it; an approval also names the `artifact` (the build's hash)
 * the merge promotes, never rebuilding, and `accept` (the destructive schema steps the merge may apply). `preview` is
 * its preview environment (`stale` once the head moved past the commit it was built from).
 */
export type StudioMergeRequest = {
	id: string;
	title: string;
	state: 'draft' | 'ready' | 'merged' | 'closed';
	openedBy: string;
	contributors: readonly string[];
	branch?: string;
	base: string;
	head: string;
	behind: number;
	decision: (StudioDecision & { accept?: readonly string[]; artifact?: string }) | null;
	comments: readonly StudioComment[];
	destructive?: readonly string[];
	preview: { url: string; commit: string; expiresAt: string; stale: boolean } | null;
	log: readonly StudioLogLine[];
	createdAt: string;
	readyAt: string | null;
	updatedAt: string;
	/** Its head's last build's diagnosis. */
	diagnostics?: readonly StudioDiagnostic[];
};
/**
 * The viewer's target (`workbench`: their own draft, the host's `branch` for them; or a merge request id) — its source
 * at `commit`, the diff against `base` (live's commit for the draft, the merge request's base otherwise) with each
 * changed text file's `baseline`, how many live commits it is `behind`, the files still holding conflict markers, the
 * last build's manifest, log and preview (`previewOf`: the commit and artifact it serves, on which data, when it expires,
 * `stale` once the draft moved on) — live's recorded commits newest first, the merge requests, and the host's
 * environments (the Operations pane). The collaboration fields are optional: a host without merge requests leaves them out.
 */
export type StudioState = {
	commit: string;
	/** The head commit's description (its message's first line). */
	message?: string;
	/** The live workspace's IANA timezone. */
	zone?: string;
	files: { readonly [path: string]: string };
	changes: readonly StudioChange[];
	manifest: EngineManifest | null;
	log: readonly StudioLogLine[];
	preview: string | null;
	releases: readonly StudioRelease[];
	environments?: readonly StudioEnvironment[];
	branch?: string;
	previewOf?: {
		commit: string;
		artifact: string;
		expiresAt: string;
		stale: boolean;
	};
	target?: string;
	base?: string;
	baseline?: { readonly [path: string]: string };
	behind?: number;
	conflicts?: readonly string[];
	mergeRequests?: readonly StudioMergeRequest[];
	/** The target's last build's diagnosis (empty: it built clean; absent: not built, or the host reports none). */
	diagnostics?: readonly StudioDiagnostic[];
	/** The retained builds, newest first; `StudioPort.build` reads one's log and diagnostics. */
	builds?: readonly StudioBuild[];
};
/**
 * `save` commits edits to the viewer's target over `expected` (a stale head is refused), `null` deletes a file; `preview`
 * builds the target in its author's sandbox (or reuses the artifact already built for that head) and serves it as a
 * preview on a copy-on-write fork of live's data taken at that moment, and `exit` drops it; `switch` moves the viewer
 * between their own draft (`workbench`) and a merge request; `rebase` replays the target onto live (conflicts land as
 * marked files). `mr.open` opens a merge request over the viewer's own draft; `publish` promotes their draft's artifact.
 * `rollback` deploys a recorded commit's build again as a new deployment on top of live (live's source history stays
 * linear); a schema change refuses it unless `discardDataSince` names that deployment's restore point, whose later
 * writes are discarded. It is neither the operator's database restore nor a record's restore.
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
	Schema.Struct({ op: Schema.Literals(['preview', 'exit', 'publish', 'rebase']) }),
	Schema.Struct({
		op: Schema.Literal('rollback'),
		commit: nonempty,
		discardDataSince: Schema.optionalKey(nonempty)
	}),
	Schema.Struct({ op: Schema.Literal('switch'), target: nonempty }),
	Schema.Struct({ op: Schema.Literal('mr.open'), title: truncated(200) }),
	Schema.Struct({ op: Schema.Literals(['mr.ready', 'mr.close', 'mr.merge']), id: nonempty }),
	Schema.Struct({
		op: Schema.Literal('mr.decide'),
		id: nonempty,
		kind: Schema.Literals(['approved', 'changes_requested', 'rejected']),
		reason: Schema.optionalKey(truncated(4000))
	}),
	Schema.Struct({ op: Schema.Literal('mr.comment'), id: nonempty, text: truncated(4000) })
]);
export type StudioOp = typeof StudioOp.Type;
/** An authoring phase (L-BOLT-530): diagnose (`bolt build`'s checks) → copy (the preview's data) → preview → merge. */
export const PHASES = STUDIO_PHASES;
export type StudioPhase = (typeof PHASES)[number];
export type PhaseState = 'running' | 'done' | 'failed';
export type StudioRole = (typeof STUDIO_ROLES)[number];
export { STUDIO_ROLES };
/**
 * A pushed authoring frame: a build log line, the workbench head moved (someone else saved), a merge request changed,
 * or an authoring phase moved.
 */
export type StudioFrame =
	| { kind: 'log'; line: StudioLogLine }
	| { kind: 'source'; commit: string }
	| { kind: 'mr'; id: string }
	| { kind: 'phase'; phase: StudioPhase; state: PhaseState };
/** Called for any staff member (an administrator, or a member authoring their own draft); the host decides what each may do, a refusal is a thrown `BoltError`. */
export type StudioPort = {
	state(auth: Authority): Promise<StudioState>;
	run(auth: Authority, op: StudioOp): Promise<StudioState>;
	/** One build's stored log and diagnostics by its commit (a unique prefix); `null`: no such build is retained. */
	build?(auth: Authority, commit: string): Promise<StudioBuildRecord | null>;
	/** This workspace's frames as they happen, never another's; answers the unsubscribe. Absent → no live stream. */
	watch?(auth: Authority, send: (frame: StudioFrame) => void): () => void;
	/** This workspace's own resource use over time (an administrator's). Absent → no Usage view. */
	usage?(auth: Authority): Promise<StudioUsage>;
};
/**
 * The host's metering of this workspace: one chart per measure, each point a time (epoch milliseconds) and the peak or
 * total of its interval. `unit` is `bytes`, `MiB`, `seconds`, `micro-SGD` or a plain count noun.
 */
export type StudioUsage = {
	charts: readonly {
		title: string;
		unit: string;
		points: readonly { at: number; value: number }[];
	}[];
};

export const SECTIONS = [
	'collections',
	'pipelines',
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
		collections: at(m.collections, (n) => `src/data/collection/${n}/+collection.ts`),
		pipelines: at(m.pipelines, (n) => `src/data/collection/${n}/+pipeline.ts`),
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
/** A running step's elapsed time as `m:ss`. */
export const elapsedText = (ms: number) => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** A plain suggestion for a save's description from the drafts (`null`: deleted) over the saved files. */
export function suggestMessage(
	drafts: { readonly [path: string]: string | null },
	files: { readonly [path: string]: string }
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

type ReviewFreshness = 'current' | 'live_advanced' | 'terminal';
/** L-BOLT-526: a merge request is current while its base is live's commit; merged or closed is terminal. */
export function reviewFreshness(mr: Pick<StudioMergeRequest, 'state' | 'behind'>): ReviewFreshness {
	return mr.state === 'merged' || mr.state === 'closed'
		? 'terminal'
		: mr.behind > 0
			? 'live_advanced'
			: 'current';
}
/** L-BOLT-526: who acts next — the author (a draft, changes requested, rejected, or live moved on), a reviewer, or nobody. */
export function reviewNextOwner(
	mr: Pick<StudioMergeRequest, 'state' | 'behind' | 'decision'>
): 'author' | 'reviewer' | 'complete' {
	const freshness = reviewFreshness(mr);
	if (freshness === 'terminal') return 'complete';
	if (freshness === 'live_advanced' || (mr.decision !== null && mr.decision.kind !== 'approved'))
		return 'author';
	return mr.state === 'ready' ? 'reviewer' : 'author';
}
/** Review age as a short phrase (`just now`, `5m`, `3h`, `2d`); an unreadable instant answers `''`. */
export function reviewAge(since: string | null, now: number): string {
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
