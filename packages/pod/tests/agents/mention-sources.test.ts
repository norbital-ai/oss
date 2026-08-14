import { describe, expect, it } from 'vitest';
import {
	COMMAND_PREFIX,
	buildMentionMenuEntries,
	filterCollections,
	isMentionableCollection,
	parseCommandQuery,
	recordSearchIdentity,
	shouldSearchRecords
} from '../../src/ui/agent/mention-sources.js';

const collections = ['companies', 'company_holidays', 'employees', 'jurisdictions'];

describe('command query prefixes', () => {
	it('treats an unprefixed string as a record search', () => {
		expect(parseCommandQuery('acme', collections)).toEqual({
			scope: null,
			collection: null,
			text: 'acme',
			raw: 'acme'
		});
	});

	it('scopes records with # and a unique or exact collection token', () => {
		expect(parseCommandQuery('#', collections)).toEqual({
			scope: 'record',
			collection: null,
			text: '',
			raw: '#'
		});
		expect(parseCommandQuery('#companies', collections)).toEqual({
			scope: 'record',
			collection: 'companies',
			text: '',
			raw: '#companies'
		});
		expect(parseCommandQuery('#companies acme', collections)).toEqual({
			scope: 'record',
			collection: 'companies',
			text: 'acme',
			raw: '#companies acme'
		});
		expect(parseCommandQuery('#jur', collections)).toEqual({
			scope: 'record',
			collection: 'jurisdictions',
			text: '',
			raw: '#jur'
		});
		expect(parseCommandQuery('#comp', collections)).toEqual({
			scope: 'record',
			collection: null,
			text: 'comp',
			raw: '#comp'
		});
	});

	it('parses plan, app, and command prefixes', () => {
		expect(parseCommandQuery('!rewrite leave', collections)).toEqual({
			scope: 'plan',
			collection: null,
			text: 'rewrite leave',
			raw: '!rewrite leave'
		});
		expect(parseCommandQuery('/payroll', collections)).toEqual({
			scope: 'app',
			collection: null,
			text: 'payroll',
			raw: '/payroll'
		});
		expect(parseCommandQuery('>settings', collections)).toEqual({
			scope: 'command',
			collection: null,
			text: 'settings',
			raw: '>settings'
		});
	});

	it('filters collections by a partial token', () => {
		expect(filterCollections('comp', collections)).toEqual(['companies', 'company_holidays']);
		expect(filterCollections('', collections)).toEqual(collections);
	});

	it('keeps the prefix glyphs stable', () => {
		expect(COMMAND_PREFIX).toEqual({ record: '#', plan: '!', app: '/', command: '>' });
	});
});

describe('record search identity', () => {
	it('is empty when there is nothing to search', () => {
		expect(recordSearchIdentity(parseCommandQuery('#', collections))).toBe('');
		expect(recordSearchIdentity(parseCommandQuery('!', collections))).toBe('');
		expect(recordSearchIdentity(null)).toBe('');
		expect(shouldSearchRecords(parseCommandQuery('#companies', collections))).toBe(false);
		expect(shouldSearchRecords(parseCommandQuery('acme', collections))).toBe(false);
		expect(shouldSearchRecords(parseCommandQuery('# acme', collections))).toBe(false);
	});

	it('keys on collection plus trimmed text, never the raw trigger', () => {
		const parsed = parseCommandQuery('#companies acme', collections);
		expect(shouldSearchRecords(parsed)).toBe(true);
		expect(recordSearchIdentity(parsed)).toBe('companies\0acme');
		expect(recordSearchIdentity(parsed)).not.toContain('#');
	});
});

describe('mention menu entries', () => {
	const acme = {
		kind: 'record' as const,
		hit: { collection: 'companies', recordId: 'r1', label: 'Acme' }
	};

	it('offers prefix commands and collection scopes on a bare query', () => {
		expect(buildMentionMenuEntries(parseCommandQuery('', collections), collections, [])).toEqual([
			{ kind: 'command', command: 'record' },
			{ kind: 'command', command: 'plan' },
			{ kind: 'command', command: 'app' },
			{ kind: 'scope', collection: 'companies' },
			{ kind: 'scope', collection: 'company_holidays' },
			{ kind: 'scope', collection: 'employees' },
			{ kind: 'scope', collection: 'jurisdictions' }
		]);
	});

	it('lists collection scopes under # until one is chosen, without searching yet', () => {
		expect(
			buildMentionMenuEntries(parseCommandQuery('#comp', collections), collections, [acme])
		).toEqual([
			{ kind: 'scope', collection: 'companies' },
			{ kind: 'scope', collection: 'company_holidays' }
		]);
		expect(
			buildMentionMenuEntries(parseCommandQuery('#companies acme', collections), collections, [
				acme
			])
		).toEqual([acme]);
	});

	it('offers only the plan command under !', () => {
		expect(
			buildMentionMenuEntries(parseCommandQuery('!rewrite', collections), collections, [])
		).toEqual([{ kind: 'command', command: 'plan' }]);
	});

	it('lists matching apps under /', () => {
		const apps = [
			{ key: 'payroll', label: 'Payroll' },
			{ key: 'crm', label: 'CRM' }
		];
		expect(
			buildMentionMenuEntries(parseCommandQuery('/pay', collections), collections, [], apps)
		).toEqual([{ kind: 'app', key: 'payroll', label: 'Payroll' }]);
		expect(
			buildMentionMenuEntries(parseCommandQuery('/', collections), collections, [], apps)
		).toEqual([
			{ kind: 'app', key: 'payroll', label: 'Payroll' },
			{ kind: 'app', key: 'crm', label: 'CRM' }
		]);
	});

	it('offers collection scopes and apps when typing after @, not an unscoped record dump', () => {
		const apps = [{ key: 'payroll', label: 'Payroll' }];
		expect(
			buildMentionMenuEntries(parseCommandQuery('comp', collections), collections, [acme], apps)
		).toEqual([
			{ kind: 'scope', collection: 'companies' },
			{ kind: 'scope', collection: 'company_holidays' }
		]);
		expect(
			buildMentionMenuEntries(parseCommandQuery('pay', collections), collections, [], apps)
		).toEqual([{ kind: 'app', key: 'payroll', label: 'Payroll' }]);
	});
});

describe('mentionable collections', () => {
	it('includes user and team, and excludes other system collections', () => {
		expect(
			isMentionableCollection({
				collection_name: 'user',
				system: true,
				fields: [{ name: 'email', kind: 'text', nullable: false }]
			} as never)
		).toBe(true);
		expect(
			isMentionableCollection({
				collection_name: 'team',
				system: true,
				fields: [{ name: 'name', kind: 'text', nullable: false }]
			} as never)
		).toBe(true);
		expect(
			isMentionableCollection({
				collection_name: 'chat_session',
				system: true,
				fields: [{ name: 'title', kind: 'text', nullable: false, search: true }]
			} as never)
		).toBe(false);
		expect(
			isMentionableCollection({
				collection_name: 'notification',
				system: true,
				fields: [{ name: 'title', kind: 'text', nullable: false, search: true }]
			} as never)
		).toBe(false);
		expect(
			isMentionableCollection({
				collection_name: 'companies',
				system: null,
				fields: [{ name: 'name', kind: 'text', nullable: false, search: true }]
			} as never)
		).toBe(true);
		expect(
			isMentionableCollection({
				collection_name: 'companies',
				system: null,
				fields: [{ name: 'name', kind: 'text', nullable: false }]
			} as never)
		).toBe(false);
	});
});
