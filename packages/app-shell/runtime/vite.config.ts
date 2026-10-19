import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** The device runtime as one classic script; `norbital-app generate` wraps it with the app's shell config. */
export default defineConfig({
	// A WebView has no `process`.
	define: { 'process.env.NODE_ENV': JSON.stringify('production') },
	build: {
		emptyOutDir: true,
		// iOS 15 is the deployment target; Android needs a WebView with document-start scripts.
		target: ['safari15', 'chrome100'],
		lib: {
			entry: fileURLToPath(new URL('./shell.ts', import.meta.url)),
			name: 'NorbitalShellRuntime',
			formats: ['iife'],
			fileName: () => 'norbital-shell.js'
		}
	}
});
