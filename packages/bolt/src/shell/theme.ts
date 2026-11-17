// The member record is authoritative. bolt.theme is the before-paint cache and the signed-out choice.
import { Effect, Schema } from 'effect';
import { APPEARANCES } from '../decl/preferences.ts';

class ThemeStorageFailed extends Schema.TaggedError<ThemeStorageFailed>()(
	'ThemeStorageFailed',
	{}
) {}

export const THEMES = APPEARANCES;
export type Theme = (typeof THEMES)[number];
const KEY = 'bolt.theme';

/** The stored choice; storage may be absent or refuse (a private window). */
export const storedTheme: Effect.Effect<Theme> = Effect.try({
	try: () => localStorage.getItem(KEY),
	catch: () => new ThemeStorageFailed()
}).pipe(
	Effect.flatMap((value) => Schema.decodeUnknownEffect(Schema.Literals(THEMES))(value)),
	Effect.catch(() => Effect.succeed('system' as const))
);
/** Remembers the choice; a denied storage write does not prevent this load switching. */
export const storeTheme = (theme: Theme): Effect.Effect<void> =>
	Effect.try({
		try: () => {
			if (theme === 'system') localStorage.removeItem(KEY);
			else localStorage.setItem(KEY, theme);
		},
		catch: () => new ThemeStorageFailed()
	}).pipe(Effect.catch(() => Effect.void));
/** Sets `.dark` and the native colour scheme on the document. */
export function applyTheme(theme: Theme, systemDark: boolean): void {
	const dark = theme === 'dark' || (theme === 'system' && systemDark);
	document.documentElement.classList.toggle('dark', dark);
	document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}
