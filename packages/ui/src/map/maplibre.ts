// MapLibre GL JS is a large client runtime: it never enters a workspace's dependency graph or bundle. The page loads it,
// its stylesheet and its worker from jsDelivr at this pinned release when a map first mounts; ui keeps only its types.
type MapLibreModule = typeof import('maplibre-gl');

const VERSION = '6.16.0';
const DIST = `https://cdn.jsdelivr.net/npm/maplibre-gl@${VERSION}/dist`;
let loading: Promise<MapLibreModule> | undefined;

/** MapLibre, once per page: the ES module, its worker set, and its stylesheet first in `<head>` so ours overrides it. */
export function load_maplibre(): Promise<MapLibreModule> {
	loading ??= Promise.all([
		import(/* @vite-ignore */ `${DIST}/maplibre-gl.mjs`) as Promise<MapLibreModule>,
		// settled either way: without it the controls sit unstyled, the map and its marks still draw
		new Promise<void>((resolve) => {
			const link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = `${DIST}/maplibre-gl.css`;
			link.onload = link.onerror = () => resolve();
			document.head.prepend(link);
		})
	]).then(([maplibre]) => {
		maplibre.setWorkerUrl(`${DIST}/maplibre-gl-worker.mjs`);
		return maplibre;
	});
	// a failed load is tried again by the next map
	loading.catch(() => (loading = undefined));
	return loading;
}
