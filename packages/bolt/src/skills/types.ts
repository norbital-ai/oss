/**
 * The Agent Skills format, as far as Bolt needs it.
 *
 * Follows the spec at https://agentskills.io/specification: a skill is a directory holding a
 * `SKILL.md` with `name` and `description` frontmatter, plus optional `references/`, `scripts/` and
 * `assets/` files loaded on demand. Bolt implements the reading half of that spec — progressive
 * disclosure — and not the executing half, because a skill's `scripts/` are shell, and the agent
 * loop has no shell to run them in.
 *
 * `origin` exists because the three sources answer to different people. A host skill ships inside
 * `@norbital-ai/bolt` and documents the platform; a workspace skill is authored under `.agents/skills/`
 * by whoever owns the tenant; a personal skill is a file in the sandbox this run executes in, put
 * there by the principal that sandbox belongs to. When all three are in one list a reader has to be
 * able to tell which is which — not least because a workspace skill naming something wrong is a bug
 * its author can fix, and a host skill doing the same is not.
 */
export type SkillOrigin = 'host' | 'workspace' | 'personal';

/** One loadable file beneath a skill root, addressed by its path relative to that root. */
export type SkillFile = {
	/** Relative to the skill directory, POSIX separators — `references/data-access.md`. */
	readonly path: string;
	readonly text: string;
};

export type Skill = {
	/** Lowercase, hyphenated, matches the directory name. Unique across origins. */
	readonly name: string;
	/** What the skill covers and when to load it. This is the part an agent reads at startup. */
	readonly description: string;
	readonly license?: string;
	readonly compatibility?: string;
	readonly metadata?: Readonly<Record<string, string>>;
	/** `SKILL.md` with its frontmatter removed. */
	readonly body: string;
	readonly files: readonly SkillFile[];
	readonly origin: SkillOrigin;
};

/**
 * What an agent is shown before it decides to load anything.
 *
 * Name, description, origin and the list of file paths — roughly the spec's ~100-token metadata
 * tier. The paths are included because a model that can see `references/approvals-and-policies.md`
 * exists will ask for it directly, where one shown only a description has to load the whole body
 * first to discover the same thing.
 */
export type SkillSummary = {
	readonly name: string;
	readonly description: string;
	readonly origin: SkillOrigin;
	readonly files: readonly string[];
};

export function summarize(skill: Skill): SkillSummary {
	return {
		name: skill.name,
		description: skill.description,
		origin: skill.origin,
		files: skill.files.map((file) => file.path)
	};
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The spec's naming rule, which is also a uniqueness rule once three origins share one namespace.
 *
 * Enforced rather than trusted because a workspace supplies half the input here. The regex covers
 * the spec's three separate prohibitions at once — no uppercase, no leading or trailing hyphen, no
 * consecutive hyphens — since each of those is a way to write a name that no longer matches its own
 * directory.
 */
export function isValidSkillName(name: string): boolean {
	return name.length > 0 && name.length <= 64 && SKILL_NAME.test(name);
}
