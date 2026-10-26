import { getContext, setContext } from 'svelte';
import type { ViewBolt } from './contract.js';
export const BOLT = Symbol('ui.views.bolt');
/** Hands the page's client to every view beneath; the shell calls it once per page. */
export const provideBolt = (bolt: ViewBolt) => setContext(BOLT, bolt);
/** The host client when present; controlled local views can render without one. */
export const useOptionalBolt = (): ViewBolt | undefined => getContext(BOLT);
/** The shell client for native reads, actions and translated text. Capture it during component initialization; eagerly registered renderers can avoid importing `$bolt` before boot. */
export function useBolt(): ViewBolt {
	const bolt = useOptionalBolt();
	if (bolt === undefined)
		throw new Error('A view needs the shell: call provideBolt(bolt) above it.');
	return bolt;
}
