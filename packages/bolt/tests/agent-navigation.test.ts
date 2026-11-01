import { expect, it } from 'vitest';
import { navigationEvents } from '../src/shell/agent/navigation.ts';
import { navigationPaths, type NavNode } from '../src/shell/nav.ts';
import type { AgentRow } from '../src/protocol/schema.ts';
import { clientNavigationPath, systemUiIntent, systemUiPath } from '../src/protocol/system-ui.ts';

const row = (id: string, path: string, name = 'navigate'): AgentRow => ({
	id,
	seq: 1,
	role: 'tool',
	text: null,
	state: null,
	tag: null,
	tool: { name, failed: false, navigation: path }
});
it('never replays history, another tool’s output or a repeated live result', () => {
	const events = navigationEvents();
	expect(events('one', [row('old', '/inbox')])).toEqual([]);
	expect(events('one', [row('old', '/inbox'), row('new', '/')])).toEqual(['/']);
	expect(
		events('one', [
			row('old', '/inbox'),
			row('new', '/'),
			row('spoof', '/settings/secrets', 'browser_evaluate')
		])
	).toEqual([]);
	expect(events('two', [row('other', '/inbox')])).toEqual([]);
});
it('the navigation allowlist contains authorized pages and no API, external, secret-bearing or cross-workspace URLs', () => {
	const nodes: NavNode[] = [
		{
			kind: 'app',
			name: 'ops',
			title: 'OPS',
			description: '',
			icon: 'lucide:bank',
			href: '/app/ops/dashboard',
			pages: [{ name: 'dashboard', title: 'Dashboard', href: '/app/ops/dashboard' }]
		}
	];
	const member = navigationPaths(nodes, false);
	expect(member).toEqual(['/', '/inbox', '/app/ops/dashboard']);
	expect(navigationPaths(nodes, true)).toContain('/settings/integrations');
	for (const path of [
		'https://example.com',
		'//example.com',
		'/__bolt/act',
		'/another-workspace/',
		'/settings/secrets?key=secret',
		'/app/ops/unknown'
	])
		expect(member).not.toContain(path);
});

it('opens only a typed configuration on its registered admin page, without accepting values or URL escapes', () => {
	const paths = navigationPaths([], true);
	const path = systemUiPath('/settings/secrets', { capability: 'secret.set', record: 'TOKEN' });
	expect(path).not.toBeNull();
	if (path === null) throw new Error('Declared setup route missing');
	expect(clientNavigationPath(path, paths, true)).toBe(true);
	expect(clientNavigationPath(path, paths, false)).toBe(false);
	expect(systemUiIntent(new URL(path, 'https://workspace.invalid'))?.request).toEqual({
		capability: 'secret.set',
		record: 'TOKEN'
	});
	expect(systemUiPath('/settings/secrets', { capability: 'api_key.create' })).toBeNull();
	for (const invalid of [
		'/settings/secrets?setup=secret.set',
		'/settings/secrets?setup=secret.set&record=TOKEN&value=plaintext',
		'/settings/integrations?setup=api_key.create&record=unexpected',
		'/settings/integrations?setup=api_key.create&setup=envoy.create',
		'/settings/integrations?setup=api_key.create#fragment',
		'/\\evil.test/settings/integrations?setup=api_key.create',
		'//evil.test/settings/integrations?setup=api_key.create'
	])
		expect(clientNavigationPath(invalid, paths, true), invalid).toBe(false);
});
