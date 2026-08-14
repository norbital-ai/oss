import { getContext, setContext, type Snippet } from 'svelte';

/**
 * The one place a running application can hand controls to the shell chrome above it.
 *
 * An app's identity — icon, name, description — is shell knowledge: it comes from the manifest and
 * the shell already paints it on the `AppMediaHeader`. A scope picker is not shell knowledge; the
 * selected legal entity or project lives in the app's own state. Before this channel existed the
 * only way to hang a picker off a header was for the app to render a second `PageHeader`, and
 * because `PageHeader` renders a title when you give it one, every app that wanted a picker also
 * repeated the title and description the banner had just shown.
 *
 * So the slot is deliberately narrow: the app contributes the trailing controls and nothing else.
 */
export type AppHeaderActionsSlot = { current: Snippet | null };

const APP_HEADER_ACTIONS_KEY = Symbol.for('norbital.pod.app-header-actions');

/** Registers the running app's trailing header controls with the shell chrome. */
// stupidity:allow Q4 -- named helper
export function setAppHeaderActionsSlot(slot: AppHeaderActionsSlot): AppHeaderActionsSlot {
	return setContext(APP_HEADER_ACTIONS_KEY, slot);
}

/**
 * `null` when no shell is above this component — an app rendered standalone in a test or a story.
 * Callers render their controls inline in that case rather than dropping them on the floor.
 */
// stupidity:allow Q4 -- named helper
export function getAppHeaderActionsSlot(): AppHeaderActionsSlot | null {
	return getContext<AppHeaderActionsSlot | undefined>(APP_HEADER_ACTIONS_KEY) ?? null;
}
