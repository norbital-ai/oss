/** Composer focus channel and control typography. */
type TaskComposerInput = { readonly message?: string; readonly planMode?: boolean };

export const AGENT_COMPOSER_CONTROL_TEXT_CLASS = 'text-xs font-normal';

/**
 * One-way focus channel: the shell cannot reach the composer through the tree (sheet portal or
 * `/agent` page). Callers that mount the panel as a side effect must dispatch after that mount.
 */
export const AGENT_COMPOSER_FOCUS_EVENT = 'bolt:focus-agent-composer';

export type AgentComposerSeed = Partial<Pick<TaskComposerInput, 'message' | 'planMode'>>;

/** Asks the mounted panel to focus the composer after a shell-driven open. */
export function requestAgentComposerFocus(seed?: AgentComposerSeed): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new CustomEvent(AGENT_COMPOSER_FOCUS_EVENT, { detail: seed }));
}
