import { describe, expect, it } from 'vitest';
import {
	appAccessAllowed,
	APPROVALS_PATH,
	buildApplicationNavigation,
	buildSystemNavigation,
	studioSourceFromSearch,
	studioSourceHref,
	WORKSPACE_SETTINGS_PATH
} from '../src/client/ui/shell/workspace-navigation.js';

const shellLabels: Readonly<Record<string, string>> = {
	'bolt.shell.people': 'People',
	'bolt.shell.settings': 'Settings',
	'bolt.shell.approvals': 'Approvals',
	'bolt.shell.automations': 'Automations',
	'bolt.shell.operations': 'Operations',
	'bolt.shell.administration': 'Administration',
	'bolt.shell.applications': 'Applications',
	'bolt.shell.workspaceStudio': 'Workspace Studio',
	'bolt.shell.organization': 'Organization',
	'bolt.shell.agents': 'Agents',
	'bolt.shell.secrets': 'Environment secrets'
};
const shellI18n = {
	has: (key: string) => key in shellLabels,
	t: (key: string) => shellLabels[key] ?? `Missing translation: ${key}`
};

describe('workspace navigation', () => {
	it('marks the current app active and places host plugins by their declared placement', () => {
		const applications = buildApplicationNavigation({
			apps: [
				{ name: 'hr-controller', label: 'HR Controller' },
				{ name: 'employee-self-service', label: 'Employee Self-Service' }
			],
			currentPath: '/app/hr-controller'
		});
		expect(applications.map((item) => item.label)).toEqual([
			'HR Controller',
			'Employee Self-Service'
		]);
		expect(applications[0]?.active).toBe(true);
		expect(applications[0]?.href).toBe('/app/hr-controller');

		const system = buildSystemNavigation({
			isAdmin: true,
			currentPath: WORKSPACE_SETTINGS_PATH,
			i18n: shellI18n,
			plugins: [
				{
					key: 'workspace-studio',
					label: 'Workspace Studio',
					icon: 'product:studio',
					entry: '/__host/workspace-studio',
					placement: 'sidebar',
					adminOnly: true
				},
				{
					key: 'organization',
					label: 'Organization',
					icon: 'lucide:building-2',
					entry: '/__host/organization',
					placement: 'settings',
					adminOnly: true
				},
				{
					key: 'agent',
					label: 'Agents',
					icon: 'lucide:bot',
					entry: '/__host/agent',
					placement: 'settings',
					adminOnly: true
				}
			]
		});
		expect(system[0]?.label).toBe('Settings');
		expect(system[0]?.children?.map((child) => child.label)).toEqual([
			'People',
			'Organization',
			'Agents'
		]);
		expect(system[0]?.children?.[0]?.href).toBe(WORKSPACE_SETTINGS_PATH);
		// The tenant's own People entry is inbuilt and wears no badge; every host-provided plugin
		// entry wears the host's mark, so a host surface is never mistaken for a tenant one.
		expect(system[0]?.children?.[0]?.badge).toBeUndefined();
		expect(system[0]?.children?.slice(1).every((child) => child.badge === 'product:colony')).toBe(
			true
		);
		const studio = system.find((item) => item.key === 'workspace-studio');
		expect(studio?.label).toBe('Workspace Studio');
		expect(studio?.badge).toBe('product:colony');
		expect(system[0]?.children?.some((child) => child.key === 'workspace-studio')).toBe(false);
		expect(system.some((item) => item.key === 'workspace-studio')).toBe(true);
		expect(system.find((item) => item.key === 'approvals')).toMatchObject({
			label: 'Approvals',
			href: APPROVALS_PATH
		});
	});

	it('lands a group on its default child', () => {
		const applications = buildApplicationNavigation({
			apps: [
				{ name: 'hr_controller', label: 'HR Controller', defaultChild: 'people' },
				{ name: 'hr_controller/leave', label: 'Leave', parent: 'hr_controller' },
				{ name: 'hr_controller/people', label: 'People', parent: 'hr_controller' }
			],
			currentPath: '/app/hr_controller/people'
		});
		expect(applications[0]?.href).toBe('/app/hr_controller/people');
		expect(applications[0]?.children?.map((child) => child.key)).toEqual([
			'hr_controller/leave',
			'hr_controller/people'
		]);
	});

	it('translates tenant app titles when the catalog has the key', () => {
		const applications = buildApplicationNavigation({
			apps: [{ name: 'hr_employee', label: 'Hr Employee', icon: 'lucide:user-round' }],
			currentPath: '/',
			i18n: {
				has: (key) => key === 'app.hr_employee.title',
				t: (key) => (key === 'app.hr_employee.title' ? 'Employee Self-Service' : key)
			}
		});
		expect(applications[0]?.label).toBe('Employee Self-Service');
		expect(applications[0]?.icon).toBe('lucide:user-round');
	});

	it('uses the catalog for every built-in shell label without an English fallback', () => {
		const seen: string[] = [];
		const system = buildSystemNavigation({
			isAdmin: true,
			currentPath: '/',
			i18n: {
				has: () => true,
				t: (key) => {
					seen.push(key);
					if (key === 'bolt.shell.settings') return '设置';
					if (key === 'bolt.shell.people') return '人员';
					if (key === 'bolt.shell.approvals') return '审批';
					return `译文：${key}`;
				}
			}
		});

		expect(system.find((item) => item.key === 'settings')?.label).toBe('设置');
		expect(system[0]?.children?.[0]?.label).toBe('人员');
		expect(system.find((item) => item.key === 'approvals')?.label).toBe('审批');
		expect(seen).toContain('bolt.shell.approvals');
		expect(system.flatMap((item) => [item, ...(item.children ?? [])]).every((item) => !item.label.startsWith('bolt.'))).toBe(true);
	});

	it('resolves nested app titles from the leaf catalog key', () => {
		const applications = buildApplicationNavigation({
			apps: [{ name: 'hr_controller/people', label: 'people', parent: 'hr_controller' }],
			currentPath: '/',
			i18n: {
				has: (key) => key === 'app.people.title',
				t: (key) => (key === 'app.people.title' ? 'People' : key)
			}
		});
		expect(applications[0]?.label).toBe('People');
	});

	it('hides apps the subject cannot access', () => {
		expect(appAccessAllowed('payroll', ['hr-controller'])).toBe(false);
		expect(
			buildApplicationNavigation({
				apps: [{ name: 'payroll', label: 'Payroll' }],
				accessibleAppNames: ['leave'],
				currentPath: '/'
			})
		).toEqual([]);
	});

	it('carries a compiler-projected Source path into Studio without inventing one', () => {
		const href = studioSourceHref('src/automations/+daily.ts');
		expect(href).toBe('/__host/workspace-studio?source=src%2Fautomations%2F%2Bdaily.ts');
		expect(studioSourceFromSearch(`?${href.split('?')[1]}`)).toBe('src/automations/+daily.ts');
		expect(studioSourceFromSearch(href.split('?')[1] ?? '')).toBe('src/automations/+daily.ts');
		expect(studioSourceFromSearch('?automation=daily')).toBeUndefined();
		expect(studioSourceFromSearch('?source=%20')).toBeUndefined();
	});
});
