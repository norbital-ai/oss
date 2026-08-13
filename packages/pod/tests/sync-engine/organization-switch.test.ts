import { afterEach, describe, expect, it, vi } from 'vitest';
import { switchOrganization } from '$lib/ui/shell/organization-switch.js';
import { readFileSync } from 'node:fs';

const podShellSource = readFileSync(
	new URL('../../src/ui/shell/pod-shell.svelte', import.meta.url),
	'utf8'
);
const workspaceShellSource = readFileSync(
	new URL('../../../ui/src/workspace-shell/workspace-shell.svelte', import.meta.url),
	'utf8'
);
const workspaceSidebarSource = readFileSync(
	new URL('../../../ui/src/workspace-shell/workspace-sidebar.svelte', import.meta.url),
	'utf8'
);

afterEach(() => vi.unstubAllGlobals());

describe('organization switch boundary', () => {
	it('connects the hosted organization selector to the document switch boundary', () => {
		expect(podShellSource).toContain(
			"import { switchOrganization } from './organization-switch.js';"
		);
		expect(podShellSource).toMatch(
			/<WorkspaceShell[\s\S]*onOrganizationChange=\{switchOrganization\}/
		);
	});

	it('unmounts the outgoing tenant shell while the host changes organizations', () => {
		expect(workspaceShellSource).toContain('data-testid="organization-switch-loader"');
		expect(workspaceShellSource).toMatch(
			/\{#if switchingOrganization\}[\s\S]*organization-switch-loader[\s\S]*\{:else\}[\s\S]*<WorkspaceShellFrame/
		);
		expect(workspaceShellSource).toContain('onOrganizationChange={changeOrganization}');
	});

	it('uses the neutral outlined organization trigger without a competing chevron', () => {
		expect(workspaceSidebarSource).toContain('hideChevron={true}');
		expect(workspaceSidebarSource).toContain("? 'h-8 px-2'");
		expect(workspaceSidebarSource).not.toContain('hideChevron={!displayExpanded}');
	});

	it('renders the host-supplied omni finder on the sidebar with its activation shortcut', () => {
		expect(workspaceShellSource).toContain('{onSearch}');
		expect(workspaceShellSource).toContain('{searchLabel}');
		expect(workspaceShellSource).toContain('{searchShortcut}');
		expect(workspaceSidebarSource).toContain('data-testid="workspace-omni-trigger"');
		expect(workspaceSidebarSource).toContain('{searchShortcut}');
		expect(podShellSource).toContain('onSearch={toggleOmniFinder}');
		expect(podShellSource).toContain("searchLabel={t('pod.shell.omniTitle')}");
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
