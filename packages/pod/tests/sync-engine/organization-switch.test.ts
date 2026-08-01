import { afterEach, describe, expect, it, vi } from 'vitest';
import { switchOrganization } from '$lib/runtime/organization-switch.js';
import { readFileSync } from 'node:fs';

const podShellSource = readFileSync(
	new URL('../../src/lib/runtime/pod-shell.svelte', import.meta.url),
	'utf8'
);

afterEach(() => vi.unstubAllGlobals());

describe('organization switch boundary', () => {
	it('connects the hosted organization selector to the document switch boundary', () => {
		expect(podShellSource).toContain("import { switchOrganization } from './organization-switch.js';");
		expect(podShellSource).toMatch(
			/<WorkspaceShell[\s\S]*onOrganizationChange=\{switchOrganization\}/
		);
	});

	it('lets Core select and serve the complete new workspace document', async () => {
		const replace = vi.fn();
		const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', request);
		vi.stubGlobal('window', { location: { replace } });

		await switchOrganization('org-reclamation');

		expect(request).toHaveBeenCalledWith('/api/organizations/switch', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ organizationId: 'org-reclamation' })
		});
		expect(replace).toHaveBeenCalledOnce();
		expect(replace).toHaveBeenCalledWith('/');
	});

	it('keeps the current workspace intact when the session update fails', async () => {
		const replace = vi.fn();
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
		vi.stubGlobal('window', { location: { replace } });

		await expect(switchOrganization('org-broken')).rejects.toThrow('Unable to switch workspace');
		expect(replace).not.toHaveBeenCalled();
	});
});
