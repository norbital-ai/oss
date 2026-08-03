/**
 * The skills Pod ships, for hosts that want to offer them alongside their own tooling.
 *
 * Exported as data rather than as a tool, because a host already has a tool surface of its own and
 * how it presents documentation is its decision. What Pod owns is the content and the format; Core
 * wraps this in a `sandbox_` tool, the standalone runner does not have to.
 *
 * The discovered kinds are deliberately absent here. A workspace skill comes out of a compiled
 * workspace bundle and a personal one out of the sandbox a run executes in, so both only exist
 * inside a running tenant and are reachable from the agent loop's registry and nowhere else.
 */
export { HOST_SKILLS } from './skills.generated.js';
export { summarize, isValidSkillName } from './types.js';
export type { Skill, SkillFile, SkillOrigin, SkillSummary } from './types.js';
