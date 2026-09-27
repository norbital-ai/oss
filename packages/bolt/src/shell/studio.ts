// Workspace Studio's port (§5.10, §7.1): the shell renders Studio and the host that owns source, builds and releases
// answers it. Bolt names no host: one that passes no port serves no Studio; a platform maps these calls onto its own.
// The agent's authoring tools over it are the host's, never Bolt's; Bolt's own agent only reads (`workspace_search`).
import type { Json } from '../decl/values.ts';
import type { Authority, EngineManifest } from '../engine/contracts.ts';
import type { CheckDiagnostic } from '../compiler/check/index.ts';
import { href } from './nav.ts';

export type StudioChange = { path: string; change: 'added' | 'modified' | 'deleted' };
export type StudioLogLine = { at: string; level: 'info' | 'warn' | 'error'; message: string };
/** One diagnostic of the last build (`bolt build --json`'s `errors`); `severity` defaults to `error` (L-BOLT-528, 530). */
export type StudioDiagnostic = CheckDiagnostic & { severity?: 'error' | 'warn' };
/** A recorded commit live ran; `restore` returns live to one. `checkpoint`: when its restore point was taken (`null`: none to restore to). */
export type StudioRelease = { commit: string; at: string; message: string; current: boolean; checkpoint?: string | null };
/** A tenant environment the host routes (`live`, `preview`, …): `release` is the artifact it serves, `''` when unrouted. */
export type StudioEnvironment = { name: string; release: string; url: string | null };
export type StudioDecision = { kind: 'approved' | 'changes_requested' | 'rejected'; by: string; at: string; commit: string; reason: string | null };
export type StudioComment = { by: string; at: string; text: string };
/**
 * A merge request (L-COL-190): a pointer to an author's `branch`, from `base` (a live commit) to its `head`. A decision
 * names the head it was made on, so a later commit clears it; an approval also names the `artifact` (the build's hash)
 * the merge promotes, never rebuilding, and `accept` (the destructive schema steps the merge may apply). `preview` is
 * its preview environment (`stale` once the head moved past the commit it was built from).
 */
export type StudioMergeRequest = {
	id: string; title: string; state: 'draft' | 'ready' | 'merged' | 'closed'; openedBy: string; contributors: readonly string[];
	branch?: string;
	base: string; head: string; behind: number; decision: (StudioDecision & { accept?: readonly string[]; artifact?: string }) | null;
	comments: readonly StudioComment[]; destructive?: readonly string[];
	preview: { url: string; commit: string; live: boolean; expiresAt: string; stale: boolean } | null;
	log: readonly StudioLogLine[]; createdAt: string; readyAt: string | null; updatedAt: string;
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
	commit: string; files: { readonly [path: string]: string }; changes: readonly StudioChange[];
	manifest: EngineManifest | null; log: readonly StudioLogLine[]; preview: string | null; releases: readonly StudioRelease[];
	environments?: readonly StudioEnvironment[];
	branch?: string; previewOf?: { commit: string; artifact: string; live: boolean; expiresAt: string; stale: boolean };
	target?: string; base?: string; baseline?: { readonly [path: string]: string }; behind?: number; conflicts?: readonly string[];
	mergeRequests?: readonly StudioMergeRequest[];
	/** The target's last build's diagnosis (empty: it built clean; absent: not built, or the host reports none). */
	diagnostics?: readonly StudioDiagnostic[];
};
/**
 * `save` commits edits to the viewer's target over `expected` (a stale head is refused), `null` deletes a file; `preview`
 * builds the target in its author's sandbox (or reuses the artifact already built for that head) and serves it as a
 * preview (`live`: on a fork of live data, else on the public seed) and `exit` drops it; `switch` moves the viewer
 * between their own draft (`workbench`) and a merge request; `rebase` replays the target onto live (conflicts land as
 * marked files). `mr.open` opens a merge request over the viewer's own draft; `publish` promotes their draft's artifact.
 */
export type StudioOp =
	| { op: 'save'; expected: string; files: { readonly [path: string]: string | null } }
	| { op: 'preview'; live?: true } | { op: 'exit' } | { op: 'publish' } | { op: 'restore'; commit: string }
	| { op: 'switch'; target: string } | { op: 'rebase' }
	| { op: 'mr.open'; title: string }
	| { op: 'mr.ready' | 'mr.close' | 'mr.merge'; id: string }
	| { op: 'mr.decide'; id: string; kind: StudioDecision['kind']; reason?: string }
	| { op: 'mr.comment'; id: string; text: string };
/** An authoring phase (L-BOLT-530): diagnose (`bolt build`'s checks) → preview → merge. */
export const PHASES = ['diagnose', 'preview', 'merge'] as const;
export type StudioPhase = typeof PHASES[number];
export type PhaseState = 'running' | 'done' | 'failed';
/**
 * A pushed authoring frame: a build log line, the workbench head moved (someone else saved), a merge request changed,
 * or an authoring phase moved.
 */
export type StudioFrame = { kind: 'log'; line: StudioLogLine } | { kind: 'source'; commit: string } | { kind: 'mr'; id: string }
	| { kind: 'phase'; phase: StudioPhase; state: PhaseState };
/** Called for any staff member (an administrator, or a member authoring their own draft); the host decides what each may do, a refusal is a thrown `BoltError`. */
export type StudioPort = {
	state(auth: Authority): Promise<StudioState>;
	run(auth: Authority, op: StudioOp): Promise<StudioState>;
	/** This workspace's frames as they happen, never another's; answers the unsubscribe. Absent → no live stream. */
	watch?(auth: Authority, send: (frame: StudioFrame) => void): () => void;
};

export const SECTIONS = ['collections', 'pipelines', 'apps', 'policies', 'envoys', 'automations', 'remotes', 'environment'] as const;
export type Section = typeof SECTIONS[number];
/** A declaration: its path-derived name, the source file it comes from (rule 1), and where it opens (an app). */
export type StudioEntry = { name: string; path: string; href?: string };
/**
 * What the browser gets: the state with the manifest cut to each Manifest chip's entries. `sections` is `null` before a
 * build, and also when the build is `stale`: a declaration whose source file the workbench no longer holds fails the
 * whole projection closed, so the pane never links into files that are gone.
 */
export type StudioView = Omit<StudioState, 'manifest'> & { sections: { readonly [s in Section]: readonly StudioEntry[] } | null; stale?: true };

export function studioView({ manifest: m, ...rest }: StudioState): StudioView {
	if (m === null) return { ...rest, sections: null };
	const at = (o: object | undefined, path: (name: string) => string) => Object.keys(o ?? {}).sort().map((name) => ({ name, path: path(name) }));
	const env = Object.keys((m.workspace.env ?? {}) as object).sort().map((name) => ({ name, path: 'src/+workspace.ts' }));
	const sections = {
		collections: at(m.collections, (n) => `src/data/collection/${n}/+collection.ts`),
		pipelines: at(m.pipelines, (n) => `src/data/collection/${n}/+pipeline.ts`),
		apps: at(m.apps, (n) => `src/app/${n}/+app.ts`).map((e) => ({ ...e, href: href(e.name) })),
		policies: at(m.policies, (n) => `src/access/+${n}.policy.ts`),
		envoys: at(m.envoys, (n) => `src/agent/envoy/+${n}.envoy.ts`),
		automations: at(m.automations, (n) => `src/automation/+${n}.automation.ts`),
		remotes: [...at(m.connections, (n) => `src/connection/+${n}.connection.ts`), ...at(m.mcp, (n) => `src/agent/mcp/+${n}.mcp.ts`),
			...at(m.integrations, (n) => `src/data/collection/${n}/+integration.ts`)],
		environment: env,
	};
	const stale = Object.values(sections).some((es) => es.some((e) => !(e.path in rest.files)));
	return stale ? { ...rest, sections: null, stale: true } : { ...rest, sections };
}

/** Drafts left after a save of `saved` lands: a path edited again while the save was in flight keeps its newer draft. */
export function settleDrafts<T>(drafts: { readonly [path: string]: T }, saved: { readonly [path: string]: T }): { [path: string]: T } {
	return Object.fromEntries(Object.entries(drafts).filter(([p, v]) => !(p in saved) || saved[p] !== v));
}

const LOG_RING = 256, LOG_CLIP = 800;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** A pushed log line folded into the log: ANSI stripped (its level colours it), clipped to 800 characters, the last 256 kept. */
export function foldLog(log: readonly StudioLogLine[], line: StudioLogLine): StudioLogLine[] {
	const message = line.message.replace(ANSI, '');
	return [...log, { ...line, message: message.length > LOG_CLIP ? `${message.slice(0, LOG_CLIP)}…` : message }].slice(-LOG_RING);
}

/** A pushed phase folded into the progress strip: a phase starting again clears the phases after it (a new run). */
export function foldPhase(phases: { readonly [p in StudioPhase]?: PhaseState }, phase: StudioPhase, state: PhaseState): { [p in StudioPhase]?: PhaseState } {
	const at = PHASES.indexOf(phase);
	const kept = state === 'running' ? Object.fromEntries(Object.entries(phases).filter(([p]) => PHASES.indexOf(p as StudioPhase) < at)) : { ...phases };
	return { ...kept, [phase]: state };
}

/** The environment the Operations pane summarizes: `live` when routed, else the first routed one; none routed → undefined. */
export function routedEnvironment(envs: readonly StudioEnvironment[] | undefined): StudioEnvironment | undefined {
	const routed = (envs ?? []).filter((e) => e.release !== '');
	return routed.find((e) => e.name === 'live') ?? routed[0];
}

/** A browser's op, checked at the boundary; `null` when malformed. */
export function studioOp(x: Json): StudioOp | null {
	if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
	const o = x as { readonly [k: string]: Json };
	const str = (k: string): string | null => {
		const v = o[k];
		return typeof v === 'string' && v !== '' ? v : null;
	};
	switch (o['op']) {
		case 'publish': case 'exit': case 'rebase': return { op: o['op'] };
		case 'preview': return o['live'] === true ? { op: 'preview', live: true } : { op: 'preview' };
		case 'restore': return str('commit') === null ? null : { op: 'restore', commit: str('commit')! };
		case 'switch': return str('target') === null ? null : { op: 'switch', target: str('target')! };
		case 'mr.open': return str('title') === null ? null : { op: 'mr.open', title: str('title')!.slice(0, 200) };
		case 'mr.ready': case 'mr.close': case 'mr.merge': return str('id') === null ? null : { op: o['op'], id: str('id')! };
		case 'mr.comment': return str('id') === null || str('text') === null ? null : { op: 'mr.comment', id: str('id')!, text: str('text')!.slice(0, 4000) };
		case 'mr.decide': {
			const kind = o['kind'];
			if (str('id') === null || (kind !== 'approved' && kind !== 'changes_requested' && kind !== 'rejected')) return null;
			return { op: 'mr.decide', id: str('id')!, kind, ...(str('reason') === null ? {} : { reason: str('reason')!.slice(0, 4000) }) };
		}
		case 'save': {
			const files = o['files'];
			if (typeof o['expected'] !== 'string' || typeof files !== 'object' || files === null || Array.isArray(files)) return null;
			// a path stays inside the workspace source: relative, no `..` segment
			if (!Object.entries(files).every(([p, v]) => (v === null || typeof v === 'string') && p !== '' && !p.startsWith('/') && !p.split(/[/\\]/).includes('..'))) return null;
			return { op: 'save', expected: o['expected'], files: files as { readonly [path: string]: string | null } };
		}
	}
	return null;
}

export type ReviewFreshness = 'current' | 'live_advanced' | 'terminal';
/** L-BOLT-526: a merge request is current while its base is live's commit; merged or closed is terminal. */
export function reviewFreshness(mr: Pick<StudioMergeRequest, 'state' | 'behind'>): ReviewFreshness {
	return mr.state === 'merged' || mr.state === 'closed' ? 'terminal' : mr.behind > 0 ? 'live_advanced' : 'current';
}
/** L-BOLT-526: who acts next — the author (a draft, changes requested, rejected, or live moved on), a reviewer, or nobody. */
export function reviewNextOwner(mr: Pick<StudioMergeRequest, 'state' | 'behind' | 'decision'>): 'author' | 'reviewer' | 'complete' {
	const freshness = reviewFreshness(mr);
	if (freshness === 'terminal') return 'complete';
	if (freshness === 'live_advanced' || (mr.decision !== null && mr.decision.kind !== 'approved')) return 'author';
	return mr.state === 'ready' ? 'reviewer' : 'author';
}
/** Review age as a short phrase (`just now`, `5m`, `3h`, `2d`); an unreadable instant answers `''`. */
export function reviewAge(since: string | null, now: number): string {
	const at = since === null ? NaN : Date.parse(since);
	if (!Number.isFinite(at)) return '';
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
/** L-BOLT-528: the CodeEditor language a path is edited in. */
export function languageOf(path: string): 'javascript' | 'json' | 'plaintext' {
	return /\.(?:[cm]?[jt]s|svelte)$/.test(path) ? 'javascript' : path.endsWith('.json') ? 'json' : 'plaintext';
}
/** L-BOLT-528: every folder holding a draft (the tree marks it with a dot). */
export function dirtyFolders(paths: Iterable<string>): Set<string> {
	const dirs = new Set<string>();
	for (const p of paths) for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) dirs.add(p.slice(0, i + 1));
	return dirs;
}
