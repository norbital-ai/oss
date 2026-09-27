// The viewer's appearance (light, dark, or the system's), a per-browser choice under `bolt.theme` — the key the access
// pages' switch writes. The page document applies it before paint (`compiler/artifact/client.ts`); the shell re-applies
// it on a change of choice or of the system preference. Absent means `system`, as staging's mode-watcher defaulted.
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = typeof THEMES[number];
const KEY = 'bolt.theme';

/** The stored choice; storage may be absent or refuse (a private window). */
export function storedTheme(): Theme {
	try {
		return THEMES.find((t) => t === localStorage.getItem(KEY)) ?? 'system';
	} catch {
		return 'system';
	}
}
/** Remembers the choice (`system` forgets it). */
export function storeTheme(theme: Theme): void {
	try {
		if (theme === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, theme);
	} catch { /* not remembered; this load still switches */ }
}
/** Sets `.dark` and the native colour scheme on the document. */
export function applyTheme(theme: Theme, systemDark: boolean): void {
	const dark = theme === 'dark' || (theme === 'system' && systemDark);
	document.documentElement.classList.toggle('dark', dark);
	document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}
