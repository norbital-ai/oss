// The strict tab hierarchy (owner rule): level 1 is `segmented`, level 2 `underline`, level 3 `chips`. A page never
// shows two levels in one style, and there is no fourth level.
/** The context key carrying the enclosing `Tabs` level; an overlay (a sheet) clears it to start a new hierarchy. */
export const TAB_LEVEL = Symbol.for('norbital.ui.tabs.level');

export const TAB_VARIANTS = ['segmented', 'underline', 'chips'] as const;
export type TabLevel = 1 | 2 | 3;
export type TabVariant = (typeof TAB_VARIANTS)[number];

export const tabVariant = (level: TabLevel): TabVariant => TAB_VARIANTS[level - 1];

/** The level a `Tabs` renders at under `parent` (none at the top), and the warning an out-of-order explicit level earns. */
export function tabLevel(parent: TabLevel | undefined, explicit: TabLevel | undefined): { level: TabLevel; warning?: string } {
	const expected = Math.min((parent ?? 0) + 1, 3) as TabLevel;
	const level = explicit ?? expected;
	if (parent === 3) return { level, warning: 'Tabs nested under chips (level 3): there is no fourth tab level.' };
	if (level === expected) return { level };
	return {
		level,
		warning: `Tabs level ${level} (${tabVariant(level)}) under ${parent ? `level ${parent}` : 'no tabs'}: expected level ${expected} (${tabVariant(expected)}). Hierarchy: segmented > underline > chips.`
	};
}
