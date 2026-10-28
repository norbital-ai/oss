import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		pool: 'threads',
		isolate: false,
		testTimeout: 60_000,
		hookTimeout: 60_000
	}
});
