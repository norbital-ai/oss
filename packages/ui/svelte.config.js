import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * `$app/*` imports are intentionally left bare in the packaged output. They are
 * resolved by the consumer at runtime — a compatible host app (real SvelteKit), the sandbox
 * bundle (proxy layer), and `tsc` (shim paths in `tsconfig.json`).
 *
 * @type {import('@sveltejs/kit').Config}
 */
const config = {
	preprocess: vitePreprocess()
};

export default config;
