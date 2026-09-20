/**
 * A tick the finger feels, where the platform allows one to be asked for.
 *
 * Android vibrates on request. iOS never shipped the Vibration API and closed the last
 * script-driven route in 26.5, so a call there is a no-op by design — not a bug to work around
 * with a hidden switch overlay. A desktop has no motor. Callers therefore treat this as a
 * garnish: nothing may depend on it having happened.
 */
export type HapticKind = 'tap' | 'success' | 'warning';

const PATTERNS: Readonly<Record<HapticKind, ReadonlyArray<number>>> = {
	tap: [10],
	success: [10, 40, 10],
	warning: [30]
};

export const haptic = (kind: HapticKind = 'tap'): void => {
	if (!('navigator' in globalThis)) return;
	if ('vibrate' in navigator) navigator.vibrate([...PATTERNS[kind]]);
};
