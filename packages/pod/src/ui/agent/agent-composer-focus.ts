/**
 * The one-way focus channel between the shell and an AgentChatPanel.
 *
 * The panel is mounted in two places the shell does not own directly — the agent sheet (portaled
 * through `sidebar-inset`) and the full-page `/agent` surface — so the shell cannot reach its
 * textarea through the component tree, and a DOM query across the portal is exactly the coupling
 * the sheet already exists to avoid. A window-level event keeps the direction one-way: the shell
 * asks for focus, the panel that is actually mounted decides what focus means (and only one panel
 * is ever mounted, so there is no broadcast problem).
 */
export const AGENT_COMPOSER_FOCUS_EVENT = 'pod:focus-agent-composer';

/**
 * Ask whichever AgentChatPanel is mounted to focus its composer.
 *
 * Safe to call when no panel exists; the event simply has no listener. A panel that mounts after
 * the event has no way to know it was missed, so callers that mount a panel as a side effect (the
 * agent sheet opening) must dispatch after the mount has happened.
 */
export function requestAgentComposerFocus(): void {
	if (typeof window === 'undefined') return;
	window.dispatchEvent(new Event(AGENT_COMPOSER_FOCUS_EVENT));
}
