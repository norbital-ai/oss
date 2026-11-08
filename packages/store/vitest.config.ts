import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/*.test.ts'],
		pool: 'forks',
		isolate: false,
		testTimeout: 60_000,
		hookTimeout: 60_000
	}
});
