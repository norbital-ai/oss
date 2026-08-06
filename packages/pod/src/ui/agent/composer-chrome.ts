/**
 * Composer surface tokens, restored verbatim from the Core-era `agent-chat.svelte.ts`.
 *
 * Kept as constants rather than inlined so the shell, the editor and the control row stay one
 * decision — which is what let Core's composer read as a single card instead of three stacked ones.
 */

export const AGENT_COMPOSER_SHELL_CLASS =
	'flex min-w-0 flex-col overflow-hidden rounded-[1.25rem] border border-border/70 bg-card shadow-deep';

export const AGENT_COMPOSER_EDITOR_CLASS =
	'max-h-40 min-h-14 flex-1 overflow-y-auto resize-none border-0 bg-transparent p-0 text-sm leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0';

export const AGENT_COMPOSER_CONTROL_TEXT_CLASS = 'text-xs font-normal';
