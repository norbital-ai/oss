/**
 * Package source lives at `src/`, not `src/lib/` — svelte-package hardcodes the `$lib` alias to
 * `kit.files.lib` (default `src/lib`), so this points it at the actual source root. The build
 * output (`build/`) mirrors `src/` 1:1 and the exports map is unchanged.
 */
export default {
	kit: {
		files: {
			lib: 'src'
		}
	}
};
