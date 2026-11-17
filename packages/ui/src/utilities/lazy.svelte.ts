/**
 * A module loaded on first ask, so a page's startup carries none of it: until it arrives the reader gets `undefined` (and
 * shows its plain form), then re-renders with it. A module that fails to load stays `undefined`.
 */
export const lazy = <M>(load: () => Promise<M>) => {
	let module = $state.raw<M | undefined>();
	let asked = false;
	return (): M | undefined => {
		if (!asked) {
			asked = true;
			void load().then(
				(loaded) => {
					module = loaded;
				},
				() => undefined
			);
		}
		return module;
	};
};
