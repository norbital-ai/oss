import { Result } from 'effect';

/** Browser-local preferences may be absent or denied; either reads as no stored value. */
export const readPreference = (key: string | null | undefined): string | null =>
	key == null ? null : Result.getOrElse(Result.try(() => localStorage.getItem(key)), () => null);

/** A denied write leaves the current page's choice usable. Null forgets a stored choice. */
export function writePreference(key: string | null | undefined, value: string | null): void {
	if (key == null) return;
	Result.try(() => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value));
}
