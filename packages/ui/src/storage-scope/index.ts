/**
 * The tenant every browser-storage key belongs to.
 *
 * `localStorage` is per-origin, and every tenant workspace is served from the same origin. A key
 * like `draft_create_form_invoices` therefore names the same slot for every organization a user
 * belongs to, so a half-typed invoice in one tenant would be offered back as the draft in another.
 * The collections share a name because they came from the same template — which makes the
 * collision likely rather than exotic.
 *
 * Scoping is applied centrally, by `scopedStorageKey`, rather than asked of each caller. A
 * workspace author writing an ordinary form never passes an organization id and cannot forget to.
 */
import { createContext } from 'svelte';

const [readStorageScope, provideStorageScope] = createContext<() => string | null>();

/** Provides the active organization from the workspace component that owns its lifetime. */
export function setStorageScope(read: () => string | null): void {
	provideStorageScope(read);
}

export function currentStorageScope(): string | null {
	const read = readStorageScope();
	return read?.() ?? null;
}

/**
 * Namespace a key to the active tenant.
 *
 * Before the shell has published a scope there is no tenant to attribute a key to, so the key is
 * returned unscoped: an unscoped key can never collide with a scoped one, and the alternative —
 * inventing a placeholder scope — would produce entries that no later session can find or clear.
 */
export function scopedStorageKey(key: string): string {
	const organizationId = currentStorageScope();
	return organizationId ? `org:${organizationId}:${key}` : key;
}
