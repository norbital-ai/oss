// What a host adds to a release's agent: host tools (Studio authoring, the browser, search), host skills, the
// author's working source and the workspace events it hears.
import { Schema } from 'effect';
import type { Actor, AgentMark } from './authority.ts';
import type { Downloaded } from './facilities.ts';
import type { Json } from '@norbital-ai/store';

/**
 * What a host tool is to the shell's Studio surfaces, declared so a release never keys behaviour on a host's tool names:
 * - `preview`: its result's `preview` is a preview it built; the agent may show that origin (`page { preview }`).
 * - `view`: a look at a rendered page; the images it attaches are shown to the person too, and its result's `url` is a
 *   preview the panel may show.
 * - `logs`: its result is `{ records: StudioLogLine[] }`, listed in full on the step.
 * - `merge` / `rollback`: a confirmed switch-over; its input is `{ summary, commit }`, its card says what changes.
 * A Studio result's caption facts (`environment`, `release`, `commit`, `message`, `branch`, `url`, `viewport`,
 * `capturedAt`) are read at its top level.
 */
export const STUDIO_ROLES = ['preview', 'view', 'logs', 'merge', 'rollback'] as const;
/** One of `STUDIO_ROLES`. */
export type StudioRole = (typeof STUDIO_ROLES)[number];
/** Native tool behavior, declared by its owner and carried with its stored step. */
export const ToolBehavior = Schema.Struct({
	pure: Schema.optionalKey(Schema.Literal(true)),
	progress_check: Schema.optionalKey(Schema.Literal(true)),
	diagnostics: Schema.optionalKey(Schema.Literal(true)),
	data: Schema.optionalKey(Schema.Literal(true)),
	page: Schema.optionalKey(Schema.Literal(true)),
	downloads: Schema.optionalKey(Schema.Literal(true)),
	resume: Schema.optionalKey(
		Schema.Struct({ argument: Schema.String, roots: Schema.optionalKey(Schema.Literal(true)) })
	)
});
export type ToolBehavior = typeof ToolBehavior.Type;
/** What a host tool learns of its call: the person (a Studio draft is theirs), the conversation (its attachments), the key. */
export type HostToolContext = {
	actor: Actor;
	conversation: string;
	/** The agent's mark when this turn runs as one: a browser page opened for it is the agent's. */
	agent?: AgentMark;
	turn: string;
	call_id: string;
	/** The person's latest message, when the turn has one (a search host ranks by it). */
	question?: string;
	/** An image the model sees on its next step (a screenshot). */
	attach(file: { mime: string; bytes: Uint8Array }): void;
	/** A file the host stored (a download), recorded as the person's and offered on the step; the model sees only its reference. */
	keep?(file: Downloaded): void;
	/** The conversation files the call named in `files`, by name, for a `files` tool. */
	files?: readonly (readonly [name: string, bytes: Uint8Array])[];
};
/**
 * A host capability (`capabilities.tools`): offered to staff members in the app only; `read_only` ones also while planning.
 * An administrator holds every one, another member those their policies grant, and every staff member a read-only
 * `source` tool (it reads the workspace's own source, never a secret or a host file).
 */
export type HostTool = {
	name: string;
	description: string;
	input: Json;
	/** Declared once here; the release does not infer behavior from the operation's name. */
	readonly behavior: ToolBehavior;
	read_only?: boolean;
	source?: true;
	studio?: StudioRole;
	/** A call's wall when it is past the usual host call's. */
	wall_ms?: number;
	/** The call's `files: [{ id }]` are read for it, as `run_js`'s are. */
	files?: true;

	call(input: Json, ctx: HostToolContext, signal: AbortSignal): Promise<Json>;
};
/** A host skill (the platform authoring skill, a person's own): its text, digest, its tree's listing and each file's bytes by path. */
export type HostSkill = {
	readonly text: string;
	readonly digest: string;
	readonly files: readonly string[];
	read(path: string): Promise<Uint8Array>;
};
/** A `workspace_search` as the host's ripgrep answers it, its hits in path order. */
export type SearchRequest = {
	readonly pattern: string;
	readonly path?: string;
	readonly include?: string;
	/** Only the files holding a match, one hit each. */
	readonly files?: boolean;
	readonly literal?: boolean;
	readonly case_sensitive?: boolean;
	readonly limit?: number;
};
/** A `workspace_search` answer: its hits in path order and whether the limit cut them, or why it failed. */
export type SearchAnswer =
	| {
			readonly hits: readonly {
				readonly path: string;
				readonly line: number;
				readonly text: string;
			}[];
			readonly truncated: boolean;
	  }
	| { readonly error: string };
/** A workspace's source files: the released tree, or an author's working tree. */
export type WorkspacePort = {
	files(): Promise<readonly string[]>;
	read(path: string): Promise<string | null>;
};
/** A workspace event as the host publishes it (a change merged, maintenance scheduled, a payment due): `at` is ISO. */
export type WorkspaceNote = {
	readonly id: string;
	readonly at: string;
	readonly title: string;
	readonly body?: string | undefined;
};
/**
 * A skill ("Running a file"): a folder of `SKILL.md`, its scripts and the pure-JavaScript packages it
 * vendors, at most `SKILL_BYTES`. Its `SKILL.md` text, the digest of its tree (sha256 hex of the sorted
 * `<path>\0<sha256 hex>` lines, `\n`-joined) and its file paths, sorted; the bytes are the artifact's `skills/<name>/`.
 */
export const SkillSchema = Schema.Struct({
	text: Schema.String,
	digest: Schema.String,
	files: Schema.Array(Schema.String)
});
/** Most bytes one skill's folder may hold (10 MiB). */
export const SKILL_BYTES = 10 * 1024 * 1024;
/** The skill's text in its tree (in a workspace's source, the folder's `+skill.md`). */
export const SKILL_FILE = 'SKILL.md';
/**
 * A repository reference ("Agents' files"): the host's `reference` tool keeps this index as the
 * person's output file, named `<repository>@<commit>`, and a file run reads its tree from it. Each text file is a blob
 * by its content address. A run reads the whole tree, so a reference over `treeBytes` runs no file.
 */
export const REFERENCE = {
	mime: 'application/vnd.norbital.reference+json',
	treeBytes: 32 * 1024 * 1024
} as const;
/** Schema of a repository reference file: repository, commit, tree digest and each file's path, blob key and size. */
export const ReferenceIndex = Schema.Struct({
	repository: Schema.String,
	commit: Schema.NullOr(Schema.String),
	/** `tree_digest` of the tree: the bundler's cache key. */
	digest: Schema.String,
	files: Schema.Array(
		Schema.Struct({ path: Schema.String, key: Schema.String, bytes: Schema.Number })
	)
});
