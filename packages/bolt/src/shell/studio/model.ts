// Workspace Studio's port: the host that owns source, builds and releases answers it and serves Studio's UI
// (`slot.ts`). Bolt names no host: one that passes no port serves no Studio; a platform maps these calls onto its own.
// The agent's authoring tools over it are the host's, never Bolt's; Bolt's own agent only reads (`workspace_search`).
import { Schema, SchemaTransformation } from 'effect';
import { STUDIO_PHASES, STUDIO_ROLES } from '../../protocol/schema.ts';
import type { Authority } from '../../engine/contracts.ts';
import type { Json } from '../../decl/values.ts';
import type { MigrationImpact } from '../../protocol/migration-impact.ts';
import type { EngineManifest } from '../../engine/manifest.ts';
import type { CheckDiagnostic } from '../../protocol/diagnostic.ts';
import type { StudioInspectInput, StudioInspection } from './inspection.ts';
import { href, kiosk_href } from '../nav.ts';
import type { StudioTestRun } from './test-results.ts';

/** A changed file and what its diff needs: the head's `text` (absent: deleted, or not text) and the base's `baseline` (absent: added, or not text), each cut at the host's one-file text bound. */
export type StudioFileChange = {
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
/** One diagnostic of the last build (`bolt build --json`'s `errors`); `severity` defaults to `error` (530). */
export type StudioDiagnostic = CheckDiagnostic & { severity?: 'error' | 'warn' };
/**
 * A Version: every merge or rollback live ran, newest first, restorable. `rollback` deploys one again as a new
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
/** A tenant environment the host routes (`live`, a change's preview, …): `release` is the artifact it serves, `''` when unrouted. */
type StudioEnvironment = { name: string; release: string; url: string | null };
/**
 * A change's preview: its own copy-on-write fork of live's data, taken when the change was opened, serving the
 * build of `commit` (`stale` once the head moved past it, while the newer head builds). `url` is `null` while it is
 * `shelved`: idle for two hours, its fork was deleted; opening the change again re-forks live and reuses the build.
 * `destructive`: the schema steps merging that build applies (a merge must accept them); `impact`: what applying its
 * migrations did on the fork (each step's rows, the duration: the merge's expected downtime).
 */
export type StudioPreview = {
	url: string | null;
	commit: string;
	artifact: string;
	stale: boolean;
	shelved?: true;
	destructive?: readonly string[];
	impact?: MigrationImpact;
};
/**
 * A Change: a named set of edits on `branch`, from live, with its own preview. `base` is where it left live (the
 * diff's other side) and `behind` how many live commits it lacks (a merge takes them in). `merge` is a merge running in
 * the background, or the reason the last one failed; a clean merge moves live and records a Version.
 */
export type StudioChangeSet = {
	id: string;
	title: string;
	state: 'open' | 'merged' | 'closed';
	opened_by: string;
	contributors: readonly string[];
	branch: string;
	base: string;
	head: string;
	/** What it holds beyond live: each commit's message, oldest first. */
	commits: readonly string[];
	/** The same commits with their ids; a merged one keeps them. */
	history?: readonly { commit: string; message: string }[];
	/** What a merge changed, against `base`. */
	files?: readonly { path: string; change: 'added' | 'modified' | 'deleted' }[];
	behind: number;
	preview: StudioPreview | null;
	merge?: {
		/** `queued` waits its turn: `at` is when it asked, and order among the queued is by `at`. */
		state: 'scheduled' | 'queued' | 'running' | 'failed';
		at: string;
		head: string;
		error?: string;
		run_at?: string;
	};
	log: readonly StudioLogLine[];
	created_at: string;
	updated_at: string;
	/** Its head's last build's diagnosis. */
	diagnostics?: readonly StudioDiagnostic[];
};
/**
 * The viewer's Studio: the change they have open (`change`; absent: none, and the tree is live's) — its working tree
 * at `working ?? commit` (each path's size; `StudioPort.file` reads one file's text), the diff against `base` with each changed text
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
/**
 * The last run of this exact source's migrations on the author's own database: what each step did, or what refused,
 * and each check as it read before and after. Live is never one of these: only a merge migrates live.
 */
export type StudioMigration = {
	state: 'passed' | 'failed';
	error?: string;
	impact?: MigrationImpact;
	checks?: readonly { sql: string; before: Json; after: Json }[];
};
export type StudioState = {
	commit: string;
	/** The commit holding the viewer's uncommitted edits; `files`, `changes` and `conflicts` read it. Absent: none. */
	working?: string;
	/** The last diagnosis of this exact source; none run, absent. */
	diagnosis?: 'passed' | 'failed';
	/** The working tree's git tree: what a check and a test run are kept by. Absent on a monitoring read. */
	tree?: string;
	/** The latest test job for this exact tree; absent when it has not been tested. */
	tests?: StudioTestRun;
	migration?: StudioMigration;
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
	preview_of?: StudioPreview;
	/** The open change's preview control; absent: nobody claimed it. */
	preview_control?: PreviewControl;
	base?: string;
	behind?: number;
	conflicts?: readonly string[];
	/** Why a migration among `conflicts` stopped, in plain words. */
	conflict_notes?: readonly string[];
	change_sets?: readonly StudioChangeSet[];
	/** The viewer's change's last build's diagnosis (empty: it built clean; absent: not built, or the host reports none). */
	diagnostics?: readonly StudioDiagnostic[];
	/** The retained builds, newest first; `StudioPort.build` reads one's log and diagnostics. */
	builds?: readonly StudioBuild[];
	/** The viewer's own held requests: what the agent asked to change on live, awaiting their `approval.decide`. */
	approvals?: readonly StudioApproval[];
};
const nonempty = Schema.NonEmptyString;
/** Room for a whole change set in a sentence or two. */
export const MERGE_SUMMARY = 500;
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
/**
 * `change.open` works on an existing change (`id`): a person has one active change at a time, and their first edit starts
 * it, a branch from live and a copy-on-write fork of live's data as its preview. `draft` writes one path of
 * the viewer's working tree (the whole `content`, an `old_string` replacement, a move `to` another path or a `remove`)
 * and moves no head; with none open, it opens a change. `commit` makes the working tree the change's next
 * commit, in any state. `save` commits edits to the viewer's change over
 * `expected` (a stale head is refused; with none open, the save opens one named by its message), `null` deletes a
 * file. `preview` is the build: it builds the head and serves it, and a merge requires the preview of the head it
 * promotes and an empty working tree; a migration the build generates, and a `squash` of the change's history into a
 * verified baseline, land in the working tree. `change.merge` merges a change into live in the background: git's 3-way merge (conflicts land in the change as
 * marked files, live untouched), a build of the merged tree with its checks, then the cutover; `accept` names the
 * destructive schema steps it may apply (any other refuses it); `at` schedules it for that instant instead, and
 * `change.unschedule` drops the schedule. Its cutover is the tenant's only downtime: requests answer maintenance and
 * in-flight work is cancelled until the new release serves. `change.rebase` replays the viewer's commits on top of live,
 * and a merge needs that: merged migrations stay as they are and the viewer's are set on top, and what stops lands as
 * marked files with `conflict_notes`. `change.revert` drops a commit and those after it, source only: data rolls back on live alone.
 * `rollback` brings a Version back, source and data together, recording the state it leaves as an Undo Version first;
 * a schema change refuses it unless `discard_data_since` names the instant whose later writes it discards. It is neither
 * the operator's database restore nor a record's restore. `approval.decide` approves (it runs as the viewer) or rejects
 * one of the viewer's held requests (`StudioState.approvals`). Every op is decoded at the shell boundary.
 */
export const StudioOp = Schema.Union([
	Schema.Struct({
		op: Schema.Literal('save'),
		expected: Schema.String,
		/** What the save does, in the author's words: its commit message (absent: the host's `suggest_message`). */
		message: Schema.optionalKey(truncated(200)),
		files: Schema.Record(Schema.String, Schema.NullOr(Schema.String)).check(
			Schema.makeFilter((files) => Object.keys(files).every(Schema.is(safePath)))
		)
	}),
	Schema.Struct({ op: Schema.Literal('draft'), path: safePath, content: Schema.String }),
	Schema.Struct({
		op: Schema.Literal('draft'),
		path: safePath,
		old_string: nonempty,
		new_string: Schema.String,
		replace_all: Schema.optionalKey(Schema.Boolean)
	}),
	/** One patch over the working tree, in OpenCode's patch language: its paths are checked as it applies. */
	Schema.Struct({ op: Schema.Literal('draft'), patch_text: nonempty }),
	Schema.Struct({ op: Schema.Literal('draft'), path: safePath, to: safePath }),
	Schema.Struct({ op: Schema.Literal('draft'), path: safePath, remove: Schema.Literal(true) }),
	Schema.Struct({ op: Schema.Literal('commit'), message: truncated(200) }),
	/** A diagnosis of the working tree, kept by its exact source: a merge reads it and never runs it. */
	Schema.Struct({ op: Schema.Literal('diagnose') }),
	/** The tests of the working tree, kept the same way. */
	Schema.Struct({ op: Schema.Literal('test') }),
	/** The next migration for the working tree's schema, written into that working tree. */
	Schema.Struct({ op: Schema.Literal('generate') }),
	Schema.Struct({
		op: Schema.Literal('migrate'),
		checks: Schema.optionalKey(Schema.Array(nonempty))
	}),
	Schema.Struct({
		op: Schema.Literal('preview'),
		/** The explicit change; absent uses the viewer's selected change. */
		id: Schema.optionalKey(nonempty),
		/** Also squash the migration history's schema prefix into a baseline named this (`bolt build --squash`). */
		squash: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,40}$/))),
		/** Also run its migrations on a fresh copy of live, whose rows `impact` then reports: the fork can be older. */
		fresh: Schema.optionalKey(Schema.Literal(true)),
		/** Rebuild even when the preview already serves this head (a host package changed under it). */
		force: Schema.optionalKey(Schema.Boolean)
	}),
	Schema.Struct({ op: Schema.Literal('preview.claim'), id: nonempty }),
	Schema.Struct({ op: Schema.Literal('preview.release'), id: nonempty }),
	Schema.Struct({
		op: Schema.Literal('package.install'),
		name: nonempty,
		version: nonempty
	}),
	Schema.Struct({ op: Schema.Literal('change.open'), id: nonempty }),
	Schema.Struct({ op: Schema.Literal('change.rename'), id: nonempty, title: truncated(200) }),
	Schema.Struct({
		op: Schema.Literal('change.merge'),
		id: nonempty,
		accept: Schema.optionalKey(Schema.Array(nonempty)),
		/** An instant to merge at instead of now: the tenant is down only for the cutover, at that time. */
		at: Schema.optionalKey(nonempty),
		/** What the whole change set does, across its commits: required of a merge, and the Version's name. */
		summary: Schema.optionalKey(truncated(MERGE_SUMMARY))
	}),
	Schema.Struct({ op: Schema.Literal('change.unschedule'), id: nonempty }),
	Schema.Struct({ op: Schema.Literal('change.rebase') }),
	Schema.Struct({
		op: Schema.Literal('change.revert'),
		commit: nonempty,
		discard: Schema.optionalKey(Schema.Boolean)
	}),
	Schema.Struct({ op: Schema.Literal('change.revert'), discard: Schema.Literal(true) }),
	Schema.Struct({
		op: Schema.Literal('rollback'),
		commit: nonempty,
		discard_data_since: Schema.optionalKey(nonempty),
		/** Why, for the person approving it. */
		summary: Schema.optionalKey(truncated(200))
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
/** An authoring phase: diagnose (the build's checks) → copy (the preview's data) → preview → merge. */
export const PHASES = STUDIO_PHASES;
export type StudioPhase = (typeof PHASES)[number];
export type PhaseState = 'running' | 'done' | 'failed';
export type StudioRole = (typeof STUDIO_ROLES)[number];
export { STUDIO_ROLES };
/** A pushed authoring frame: a build log line, a head moved (someone else saved), a change changed, a phase or task moved. */
export type StudioFrame =
	| { kind: 'tests'; commit: string }
	| { kind: 'log'; line: StudioLogLine }
	| { kind: 'source'; commit: string }
	| { kind: 'change'; id: string }
	| { kind: 'phase'; phase: StudioPhase; state: PhaseState };
/** A commit as `StudioPort.log` answers it: its id, who made it, when, and its message's first line. */
type StudioCommit = { commit: string; author: string; at: string; message: string };
/** A changed file between two points: its kind and its lines added and removed (`null`: not text). */
type StudioDiffFile = {
	path: string;
	change: 'added' | 'modified' | 'deleted';
	added: number | null;
	removed: number | null;
};
/** Called for an administrator; the host decides what each may do, a refusal is a thrown `BoltError`. */
export type StudioPort = {
	state(auth: Authority): Promise<StudioState>;
	run(auth: Authority, op: StudioOp): Promise<StudioState>;
	/** One file at a commit (`StudioState.commit`, or a change's base); `null`: no such file there. */
	file(auth: Authority, commit: string, path: string): Promise<StudioFile | null>;
	/** Commits newest first: live's lineage and the commit live runs, or the viewer's line beyond live. */
	log?(
		auth: Authority,
		of: 'live' | 'yours',
		limit: number
	): Promise<{ live: string; commits: readonly StudioCommit[] }>;
	/**
	 * What changed from `from` to `to`, each a commit id or `live`, `head` or `working`; `path`, a file or folder, narrows
	 * it and adds its patch.
	 */
	diff?(
		auth: Authority,
		input: { from: string; to: string; path?: string }
	): Promise<{ from: string; to: string; files: readonly StudioDiffFile[]; patch?: string }>;
	/** This workspace's frames as they happen, never another's; answers the unsubscribe. Absent → no live stream. */
	watch?(auth: Authority, send: (frame: StudioFrame) => void): () => void;
	/** Curated operational diagnostics shared with Realm across the current HOST_API contract. */
	inspect(auth: Authority, input: StudioInspectInput): Promise<StudioInspection>;
	/** Where this host serves Studio's browser bundle (`slot.ts`), under the workspace; `null`: it has none to serve. */
	bundle?(): Promise<string | null>;
};
export const SECTIONS = ['models', 'apps', 'kiosks', 'policies', 'automations', 'secrets'] as const;
export type Section = (typeof SECTIONS)[number];
/** A declaration: its path-derived name, the source file it comes from, and where it opens (an app). */
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

export function studio_view({ manifest: m, ...rest }: StudioState): StudioView {
	if (m === null) return { ...rest, sections: null };
	const at = (o: object | undefined, path: (name: string) => string) =>
		Object.keys(o ?? {})
			.sort()
			.map((name) => ({ name, path: path(name) }));
	const sections = {
		models: at(m.models, (n) => `src/data/model/${n}/+model.ts`),
		apps: at(m.apps, (n) => `src/app/${n}/+app.ts`)
			.filter(({ name }) => m.apps[name]?.shell !== 'kiosk')
			.map((e) => ({ ...e, href: href(e.name) })),
		kiosks: at(m.apps, (n) => `src/app/${n}/+app.ts`)
			.filter(({ name }) => m.apps[name]?.shell === 'kiosk')
			.map((e) => ({ ...e, href: kiosk_href(e.name) })),
		policies: at(m.policies, (n) => `src/access_control/policy/+${n}.policy.ts`),
		automations: at(m.automations, (n) => `src/automation/+${n}.automation.ts`),
		secrets: at(m.workspace.secrets, () => 'src/+secrets.ts')
	};
	const stale = Object.values(sections).some((es) => es.some((e) => !(e.path in rest.files)));
	return stale ? { ...rest, sections: null, stale: true } : { ...rest, sections };
}

/** A running step's elapsed time as `m:ss`. */
export const elapsed_text = (ms: number) => {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** What a save changes, in plain words, from its drafts (`null`: deleted) over the tree they change. */
export function suggest_message(
	drafts: { readonly [path: string]: unknown },
	files: { readonly [path: string]: unknown }
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
