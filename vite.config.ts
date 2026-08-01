import { defineConfig } from 'vite';
import { pod } from '@norbital-ai/pod/vite';

const libreDwgWasm = decodeURIComponent(
	new URL('../wasm/libredwg-web.wasm', import.meta.resolve('@mlightcad/libredwg-web')).pathname
);

export default defineConfig({
	plugins: [
		pod({
			serverAssets: [{ source: libreDwgWasm, target: 'libredwg-web.wasm' }]
		})
	]
});
