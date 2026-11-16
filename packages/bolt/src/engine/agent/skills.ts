// Shared procedures are authored once in oss/skills and bundled into each Bolt release.
import type { SkillSpec } from '../manifest.ts';
import { SKILL_SOURCES } from './skills.generated.ts';

/** Skills for changing source, offered only to authors. */
export const AUTHORING_SKILLS: ReadonlySet<string> = new Set(
	Object.entries(SKILL_SOURCES)
		.filter(([, skill]) => skill.authoring)
		.map(([name]) => name)
);

export const PLATFORM_SKILLS: { readonly [name: string]: SkillSpec } = Object.fromEntries(
	Object.entries(SKILL_SOURCES).map(([name, skill]) => [
		name,
		{
			text: skill.files['SKILL.md'] ?? '',
			digest: skill.digest,
			files: Object.keys(skill.files)
		}
	])
);
/** A bundled reference belonging to a platform skill. */
export const platformFile = (name: string, path: string): string | undefined =>
	SKILL_SOURCES[name]?.files[path];
