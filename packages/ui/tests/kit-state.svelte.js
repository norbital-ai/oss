// A reactive props object for mounted test components.
/** @template T @param {T} initial @returns {T} */
export const reactive = (initial) => {
	const state = $state(initial);
	return state;
};
