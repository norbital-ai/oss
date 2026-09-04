/**
 * Shared composer surface tokens for the durable Task panel and shell focus action.
 *
 * Kept as constants rather than inlined so the shell, the editor and the control row stay one
 * decision — which is what let Core's composer read as a single card instead of three stacked ones.
 */
type TaskComposerInput = { readonly message?: string; readonly planMode?: boolean };

export const AGENT_COMPOSER_SHELL_CLASS =
	'flex min-w-0 flex-col overflow-hidden rounded-[1.25rem] border-0 bg-transparent text-popover-foreground shadow-none';

export const AGENT_COMPOSER_EDITOR_CLASS =
	'max-h-40 min-h-14 flex-1 overflow-y-auto resize-none border-0 bg-transparent px-4 py-3 text-sm leading-relaxed shadow-none outline-none focus:border-0 focus:outline-none focus:ring-0 focus-visible:border-0 focus-visible:outline-none focus-visible:ring-0 dark:bg-transparent dark:shadow-none';

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
