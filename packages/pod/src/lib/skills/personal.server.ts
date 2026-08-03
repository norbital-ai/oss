import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
// The parser lives in the compiler tree because that is where its first caller was, and it is
// deliberately imported from there rather than copied: a personal skill and a workspace skill are
// the same document in different places, and two parsers is exactly how they would stop being. It
// pulls in nothing from Vite — only the shared name rule — so the runtime carries no build tooling
// for having reached across.
import { parseSkillDocument } from '$lib/vite/compiler/skill-frontmatter.js';
import { isValidSkillName, type Skill, type SkillFile } from './types.js';

/**
 * Skills read out of the filesystem this run is executing on, belonging to whoever that filesystem
 * belongs to.
 *
 * There is no user id anywhere in this file, and that is the design rather than an omission.
 * Discovery answers "the skills on this filesystem", which is a fact the process already has, and
 * asking instead who is acting would be a question with no answer on at least one surface: a channel
 * agent may be a group chat, and no participant of a group owns the channel's skills.
 *
 * What that scopes to is therefore the host's answer and not this file's, and only one host shape
 * makes these *personal*. A self-hosted `pod dev` or `pod start` runs one process on one working
 * directory for one principal, so the files here are theirs and nobody else's. A host that runs one
 * runtime per organization has no per-person filesystem to point at — one process environment
 * variable cannot name a different directory for each of an organization's users — so under such a
 * host this either finds nothing, which is Core's case today because its guest runs on a read-only
 * bundle, or it would find skills shared by the whole organization. Neither is personal, and the
 * thing that would make it so is not a path but an acting principal on the binding frame that
 * reaches the host. See `docs/AGENT_ARCHITECTURE.md`.
 */

/**
 * Where a sandbox keeps files it means an agent to find.
 *
 * `.agents/skills/<name>/` is not invented here — it is the convention this repository already
 * follows for exactly this purpose, symlinking the skills Pod ships into `.agents/skills/` so local
 * agents discover them (see the root `AGENTS.md`), and it is what Cursor and similar tools look for.
 * A personal skill is the same directory-with-a-`SKILL.md` shape as a workspace or host one, so a
 * person who has written one of those has already written one of these.
 */
const SANDBOX_SKILLS_DIRECTORY = path.join('.agents', 'skills');

/**
 * The sandbox root, which is the working directory unless the host says otherwise.
 *
 * A host that starts the runtime somewhere other than the writable directory it means the run to use
 * needs a way to say so; every other host gets the obvious answer with no configuration. Read on
 * each call rather than at module load, so a test — and a host that rebinds it between runs — is not
 * fighting import order.
 */
function sandboxRoot(): string {
	return process.env.NORBITAL_POD_SANDBOX_DIR?.trim() || process.cwd();
}

/**
 * Ceilings, because this is a place a person can put anything.
 *
 * Neither is a security boundary — whoever can write to this filesystem can already fill it. They
 * exist so one runaway directory cannot turn `list_skills` into a directory walk of someone's home
 * or `read_skill` into a way to spend a context window by accident.
 */
const MAX_PERSONAL_SKILLS = 64;
const MAX_FILES_PER_SKILL = 64;

/**
 * Read one skill directory, or decline to.
 *
 * Every failure returns `undefined` instead of throwing. There is no compiler here to collect a
 * diagnostic and no author watching a build, so the only thing a thrown error could accomplish is
 * to take `list_skills` down for the whole run because one file in a sandbox was malformed — losing
 * the platform skills, which are the ones the model most needs, over a typo in a personal one. The
 * warning is what keeps it from being silent.
 */
async function readPersonalSkill(root: string, name: string): Promise<Skill | undefined> {
	try {
		const directory = path.join(root, name);
		const parsed = parseSkillDocument(
			await readFile(path.join(directory, 'SKILL.md'), 'utf8'),
			name
		);
		if (!parsed.ok) {
			console.warn(`[pod] skipping personal skill ${name}: ${parsed.message}`);
			return undefined;
		}
		return { ...parsed.document, files: await readSkillFiles(directory), origin: 'personal' };
	} catch (cause) {
		// A directory with no `SKILL.md` is the ordinary case, not a fault: `.agents/skills/` may hold
		// anything, and only the entries shaped like a skill are one.
		if (isMissing(cause)) return undefined;
		console.warn(`[pod] skipping personal skill ${name}: ${describe(cause)}`);
		return undefined;
	}
}

/** Everything beneath the skill root except its own `SKILL.md`, addressed the way the spec does. */
async function readSkillFiles(directory: string): Promise<readonly SkillFile[]> {
	const entries = await readdir(directory, { recursive: true, withFileTypes: true });
	const files: SkillFile[] = [];
	for (const entry of entries) {
		if (files.length >= MAX_FILES_PER_SKILL) break;
		if (!entry.isFile()) continue;
		const absolute = path.join(entry.parentPath, entry.name);
		const relative = path.relative(directory, absolute);
		if (relative === 'SKILL.md') continue;
		try {
			files.push({
				path: relative.split(path.sep).join('/'),
				text: await readFile(absolute, 'utf8')
			});
		} catch (cause) {
			// One unreadable reference file loses that file, not the skill that carries it.
			console.warn(`[pod] skipping personal skill file ${relative}: ${describe(cause)}`);
		}
	}
	return files.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/**
 * Every well-formed skill in this run's sandbox.
 *
 * A sandbox with no `.agents/skills/` is the normal case — most runs have no personal skills at all
 * — so a missing directory resolves to an empty list rather than to anything a caller has to handle.
 */
export async function personalSkills(): Promise<readonly Skill[]> {
	const root = path.join(sandboxRoot(), SANDBOX_SKILLS_DIRECTORY);
	let names: readonly string[];
	try {
		names = (await readdir(root)).sort();
	} catch (cause) {
		if (!isMissing(cause)) {
			console.warn(`[pod] cannot read personal skills at ${root}: ${describe(cause)}`);
		}
		return [];
	}
	const skills: Skill[] = [];
	for (const name of names) {
		if (skills.length >= MAX_PERSONAL_SKILLS) break;
		// The directory name is the skill's identity, exactly as it is for a workspace skill, so one
		// that could not be a skill name is not a skill directory and is passed over in silence.
		if (!isValidSkillName(name)) continue;
		const skill = await readPersonalSkill(root, name);
		if (skill) skills.push(skill);
	}
	return skills;
}

function isMissing(cause: unknown): boolean {
	const code: unknown = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
