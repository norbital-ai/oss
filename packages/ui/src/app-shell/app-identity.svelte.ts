import { getContext, setContext } from 'svelte';

/**
 * The one place a running application hands its identity to the shell chrome above it.
 *
 * The compiler reads static identity out of app source, but translated titles and
 * descriptions (`title={t('...')}`) are not statically readable — and `AppShell` already
 * receives them as props. Without this channel every shelled app falls back to a
 * filename-derived label, a fallback icon, and no description in the hero, sidebar,
 * and finder, no matter what the shell was told.
 *
 * The slot is deliberately narrow: translated identity and artwork, nothing else.
 */
export type AppIdentity = {
	readonly title?: string | undefined;
	readonly description?: string | null | undefined;
	readonly icon?: string | undefined;
	readonly banner?: string | null | undefined;
	readonly thumbnail?: string | null | undefined;
};

export type AppIdentitySlot = { current: AppIdentity | null };

const APP_IDENTITY_KEY = Symbol.for('norbital.ui.app-identity');

/** Opens the slot for everything rendered beneath the shell. */
export const setAppIdentitySlot = (slot: AppIdentitySlot): AppIdentitySlot =>
	setContext(APP_IDENTITY_KEY, slot);

/**
 * `null` when no shell is above this component — an app mounted standalone in a test or a story.
 * Callers fall back to static metadata in that case rather than dropping identity on the floor.
 */
export const getAppIdentitySlot = (): AppIdentitySlot | null =>
	getContext<AppIdentitySlot | undefined>(APP_IDENTITY_KEY) ?? null;
