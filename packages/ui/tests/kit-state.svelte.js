// @ts-nocheck -- a rune module compiled by the test hook.
// A reactive props object for mounted test components.
export const reactive = (initial) => {
	const state = $state(initial);
	return state;
};
