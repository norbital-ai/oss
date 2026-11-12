import { expect, it } from 'vitest';
import { navigationEvents, pageActions, pageConversationStarted } from '../src/shell/agent/navigation.ts';
import { navigation_paths, type NavNode } from '../src/shell/nav.ts';
import type { AgentRow } from '../src/protocol/schema.ts';
import { clientNavigationPath, systemUiIntent, systemUiPath } from '../src/protocol/system-ui.ts';

const row = (id: string, path: string, name = 'page'): AgentRow => ({
	id,
	seq: 1,
	role: 'tool',
	text: null,
	state: null,
	tag: null,
	tool: { name, behavior: { page: true }, failed: false, navigation: path }
});
it('never replays history, another tool’s output or a repeated live result', () => {
	const events = navigationEvents();
	expect(events('one', [row('old', '/inbox')])).toEqual([]);
	expect(events('one', [row('old', '/inbox'), row('new', '/')])).toEqual([{ id: 'new', path: '/' }]);
	expect(
		events('one', [
			row('old', '/inbox'),
			row('new', '/'),
			row('spoof', '/settings/secrets', 'browser')
		])
	).toEqual([]);
	expect(events('two', [row('other', '/inbox')])).toEqual([]);
});
it('never replays history, another tool’s output or a repeated live page action', () => {
	const pageRow = (id: string, page: { click?: string; scroll?: number; go?: 'back' | 'forward' }): AgentRow => ({
		id,
		seq: 1,
		role: 'tool' as const,
		text: null,
		state: null,
		tag: null,
		tool: { name: 'page', behavior: { page: true }, failed: false, page }
	});
	const actions = pageActions();
	expect(actions('one', [pageRow('old', { click: 'Old' })])).toEqual([]);
	expect(
		actions('one', [
			pageRow('old', { click: 'Old' }),
			pageRow('new', { click: 'GREY_RUBBER_0001' })
		])
	).toEqual([
		{
			key: 'new:{"click":"GREY_RUBBER_0001"}',
			id: 'new',
			action: { click: 'GREY_RUBBER_0001' }
		}
	]);
	expect(actions('one', [pageRow('new', { click: 'GREY_RUBBER_0001' })])).toEqual([]);
	expect(actions('two', [pageRow('other', { go: 'back' })])).toEqual([]);
});
it('shares one page-action ledger across Agent instances, so a confirmation is never repeated', () => {
	const pageRow = (id: string, click: string, at?: string): AgentRow => ({
		id,
		seq: 2,
		role: 'tool' as const,
		text: null,
		state: null,
		tag: null,
		...(at === undefined ? {} : { at }),
		tool: { name: 'page', behavior: { page: true }, failed: false, page: { click } }
	});
	const userRow = {
		id: 'shared-input',
		seq: 1,
		role: 'user' as const,
		text: 'open it',
		state: null,
		tag: null
	};
	const first = pageActions();
	const second = pageActions();
	const row = pageRow('shared-action', 'Open', new Date().toISOString());
	expect(first('shared-ledger', [userRow])).toHaveLength(0);
	expect(first('shared-ledger', [userRow, row])).toHaveLength(1);
	expect(second('shared-ledger', [userRow, row])).toHaveLength(0);
});
it('runs the first action of a conversation this panel started', () => {
	const actions = pageActions();
	const row: AgentRow = {
		id: 'started-action',
		seq: 1,
		role: 'tool' as const,
		text: null,
		state: null,
		tag: null,
		tool: { name: 'page' as const, behavior: { page: true }, failed: false, page: { click: 'Open' } }
	};
	pageConversationStarted('started-here');
	expect(actions('started-here', [row])).toHaveLength(1);
	expect(actions('started-here', [row])).toHaveLength(0);
});
it('never replays an opened conversation’s history', () => {
	const actions = pageActions();
	const user = {
		id: 'history-input',
		seq: 1,
		role: 'user' as const,
		text: 'open it',
		state: null,
		tag: null
	};
	const old: AgentRow = {
		id: 'old-action',
		seq: 2,
		role: 'tool' as const,
		text: null,
		state: null,
		tag: null,
		tool: { name: 'page' as const, behavior: { page: true }, failed: false, page: { click: 'Old' } }
	};
	expect(actions('history', [user, old])).toEqual([]);
	expect(actions('history', [user, old])).toEqual([]);
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
	const member = navigation_paths(nodes, false);
	expect(member).toEqual(['/', '/inbox', '/app/ops/dashboard']);
	expect(navigation_paths(nodes, true)).toContain('/settings/integrations');
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
	const paths = navigation_paths([], true);
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
