// The platform layer carries one svelte and one ui, the shell's: a workspace import of either resolves to the shell's
// copy; the shell's own imports and every other package resolve as they are.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHELL, shellRuntime } from '../src/compiler/artifact/platform.ts';

const page = '/workspace/src/app/main/+home.page.svelte';

describe('shellRuntime', () => {
	it('sends a workspace import of svelte or ui to the shell', () => {
		for (const id of ['svelte', 'svelte/store', '@norbital-ai/ui', '@norbital-ai/ui/layout'])
			expect(shellRuntime(id, page), id).toBe(true);
	});

	it('leaves the shell, entries and other packages alone', () => {
		expect(shellRuntime('svelte', join(SHELL, 'mount.ts'))).toBe(false);
		expect(shellRuntime('svelte', undefined)).toBe(false);
		for (const id of ['effect', 'svelte-check', '@norbital-ai/uikit'])
			expect(shellRuntime(id, page), id).toBe(false);
	});
});
