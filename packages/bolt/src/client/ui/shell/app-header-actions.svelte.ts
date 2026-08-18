import { getContext, setContext, type Snippet } from 'svelte';

/**
 * The one place a running application hands controls to the shell chrome above it.
 *
 * An app's identity — icon, title, description, banner — is shell knowledge and the shell already
 * paints it on the `AppMediaHeader`. A scope picker is not: the selected legal entity or project
 * lives in the app's own state. Without this channel an app can only render its picker where it
 * stands, which puts a second bar between the banner and the page's tabs.
 *
 * The slot is deliberately narrow: the app contributes trailing controls and nothing else.
 */
export type AppHeaderActionsSlot = { current: Snippet | null };

const APP_HEADER_ACTIONS_KEY = Symbol.for('norbital.bolt.app-header-actions');

/** Opens the slot for everything rendered beneath the shell. */
export const setAppHeaderActionsSlot = (slot: AppHeaderActionsSlot): AppHeaderActionsSlot =>
	setContext(APP_HEADER_ACTIONS_KEY, slot);

/**
 * `null` when no shell is above this component — an app mounted standalone in a test or a story.
 * Callers render their controls inline in that case rather than dropping them on the floor.
 */
export const getAppHeaderActionsSlot = (): AppHeaderActionsSlot | null =>
	getContext<AppHeaderActionsSlot | undefined>(APP_HEADER_ACTIONS_KEY) ?? null;
