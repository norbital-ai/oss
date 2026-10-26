/** Whether the caller is reading inside Svelte's component reactivity. */
export const isTracking = (): boolean => $effect.tracking();
