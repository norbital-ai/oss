import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { personalSkills } from './personal.server.js';
import { HOST_SKILLS } from './skills.generated.js';
import { isValidSkillName, summarize, type Skill, type SkillSummary } from './types.js';

/**
 * Every skill this run can read: the ones Pod ships, the ones the workspace authored, and the ones
 * sitting in the sandbox this run executes in.
 *
 * Two kinds, not three sources. Host skills are injected — compiled into the package and present in
 * every run. The other two are discovered by reading a filesystem, and differ only in which
 * filesystem: a workspace skill is committed under `src/skills/` and shared by everyone in the
 * tenant, a personal skill is a file in a sandbox and committed nowhere.
 *
 * One flat namespace, because the agent addresses a skill by name and a name that meant two things
 * would make `read_skill` ambiguous. Precedence is host, then workspace, then personal. Host wins
 * everything: host skills document the platform, so anything shadowing `norbital-platform` would
 * replace the only correct account of how approvals behave with its own — an argument that does not
 * weaken when the shadow is one person's file instead of the tenant's. Workspace beats personal
 * because a workspace skill is the tenant's shared answer, and a sandbox should not be able to
 * quietly substitute a different one for its own runs. The losing copy is dropped rather than
 * merged — a half-shadowed skill is harder to diagnose than a missing one.
 *
 * Resolved per call rather than cached, now including the filesystem read. `getTenantWorkspace()` is
 * already the cached thing, a second cache here would be one more place to be wrong after a
 * checkpoint redeploy, and a cached sandbox listing would mean a person who just wrote a skill file
 * has to wait for a restart to use it. The read is not the cost it looks like: every tool call is
 * preceded by a model inference, beside which one directory of small markdown files is free.
 */
async function allSkills(): Promise<readonly Skill[]> {
	const byName = new Map<string, Skill>();
	for (const skill of HOST_SKILLS) byName.set(skill.name, skill);
	for (const skill of workspaceSkills()) {
		if (byName.has(skill.name)) continue;
		byName.set(skill.name, skill);
	}
	for (const skill of await personalSkills()) {
		if (byName.has(skill.name)) continue;
		byName.set(skill.name, skill);
	}
	return [...byName.values()].sort((left, right) => (left.name < right.name ? -1 : 1));
}

/**
 * Skills compiled out of `src/skills/`, defended against a bundle that predates them.
 *
 * A tenant runs an immutable checkpoint, and a checkpoint built before this field existed has no
 * `skills` on its registered state. Reading it optionally means an older workspace keeps working
 * with host skills alone instead of failing on a property access.
 */
function workspaceSkills(): readonly Skill[] {
	const registered = getTenantWorkspace().registered as { readonly skills?: readonly Skill[] };
	const declared = registered.skills ?? [];
	return declared.filter((skill) => isValidSkillName(skill.name));
}

/** The metadata tier: what an agent sees before deciding to load anything. */
export async function listSkillSummaries(): Promise<readonly SkillSummary[]> {
	return (await allSkills()).map(summarize);
}

export async function findSkill(name: string): Promise<Skill | undefined> {
	return (await allSkills()).find((skill) => skill.name === name);
}

export type SkillRead =
	| { readonly ok: true; readonly name: string; readonly path: string; readonly text: string }
	| { readonly ok: false; readonly error: string };

/**
 * Read a skill's body, or one file beneath it.
 *
 * Failures come back as data rather than thrown, because the caller is a model. A thrown error
 * reaches it as an opaque tool failure it tends to either ignore or apologise for; a result naming
 * what is actually available is something it can act on, which is usually retrying with a path that
 * exists.
 */
export async function readSkillContent(name: string, filePath?: string): Promise<SkillRead> {
	// One resolution, not two: with a filesystem read behind it, asking twice would walk the sandbox
	// twice to answer one question.
	const skills = await allSkills();
	const skill = skills.find((entry) => entry.name === name);
	if (!skill) {
		const available = skills.map((entry) => entry.name);
		return {
			ok: false,
			error: `No skill named ${name}. Available: ${available.join(', ') || 'none'}.`
		};
	}
	if (filePath === undefined) {
		return { ok: true, name: skill.name, path: 'SKILL.md', text: skill.body };
	}
	// Compared verbatim against the manifest of files the skill actually carries, which is what makes
	// traversal a non-question: there is no path being joined onto a root, only a lookup in a list.
	const file = skill.files.find((entry) => entry.path === filePath);
	if (!file) {
		const available = skill.files.map((entry) => entry.path);
		return {
			ok: false,
			error: `Skill ${name} has no file ${filePath}. Available: ${available.join(', ') || 'none'}.`
		};
	}
	return { ok: true, name: skill.name, path: file.path, text: file.text };
}
