import { describe, expect, it } from 'vitest';
import {
	DetailSurfaceService,
	type NavStackItem
} from '../../src/client/ui/collection/detail-surface.js';
import {
	baseUrlOf,
	currentDetailTarget,
	mergeDetailNavStack,
	popDetailNavStack,
	routeContextOf
} from '../../src/client/ui/collection/nav-stack.js';
import { resolveRecordDetailFields } from '../../src/client/ui/collection/record-detail-fields.js';

const item = (
	nodeId: string,
	recordId = `${nodeId}-record`,
	collection = 'people'
): NavStackItem => ({
	collection_name: collection,
	record_id: recordId,
	node_id: nodeId,
	viewMode: 'sidesheet'
});

describe('route context', () => {
	it('reads the app a stack belongs to', () => {
		expect(routeContextOf(new URL('http://host/app/hr_controller/people'))).toEqual({
			app: 'hr_controller/people'
		});
	});

	it('reads a host surface', () => {
		expect(routeContextOf(new URL('http://host/__host/workspace-studio'))).toEqual({
			hostSurface: 'workspace-studio'
		});
	});

	it('has no context for the workspace root or an unknown path', () => {
		expect(routeContextOf(new URL('http://host/'))).toBeUndefined();
		expect(routeContextOf(new URL('http://host/settings'))).toBeUndefined();
	});

	it('roots generated links on the surface they came from', () => {
		expect(baseUrlOf(new URL('http://host/app/hr_controller/people?stack=%5B%5D'))).toBe(
			'/app/hr_controller/people'
		);
		expect(baseUrlOf(new URL('http://host/__host/workspace-studio'))).toBe(
			'/__host/workspace-studio'
		);
		expect(baseUrlOf(new URL('http://host/settings'))).toBe('/settings');
	});
});

describe('detail stack placement', () => {
	it('appends a surface it has not seen', () => {
		expect(mergeDetailNavStack([item('a')], item('b')).map(({ node_id }) => node_id)).toEqual([
			'a',
			'b'
		]);
	});

	it('replaces rather than duplicating when the same surface reopens', () => {
		const stack = mergeDetailNavStack([item('a'), item('b', 'first')], item('b', 'second'));
		expect(stack.map(({ node_id }) => node_id)).toEqual(['a', 'b']);
		expect(stack.at(-1)?.record_id).toBe('second');
	});

	it('truncates to the parent when opening a different child', () => {
		const stack = mergeDetailNavStack([item('a'), item('b'), item('c')], item('d'), {
			parentRouteKey: 'a'
		});
		expect(stack.map(({ node_id }) => node_id)).toEqual(['a', 'd']);
	});

	it('replaces a child in place, keeping what sat above its parent', () => {
		const stack = mergeDetailNavStack([item('root'), item('a'), item('b')], item('b', 'again'), {
			parentRouteKey: 'a'
		});
		expect(stack.map(({ node_id }) => node_id)).toEqual(['root', 'a', 'b']);
		expect(stack.at(-1)?.record_id).toBe('again');
	});

	it('appends when the named parent is not in the stack', () => {
		const stack = mergeDetailNavStack([item('a')], item('b'), { parentRouteKey: 'missing' });
		expect(stack.map(({ node_id }) => node_id)).toEqual(['a', 'b']);
	});

	it('collapses to a single record on a host surface', () => {
		const stack = mergeDetailNavStack([item('a'), item('b')], item('c'), {
			routeContext: { hostSurface: 'workspace-studio' }
		});
		expect(stack.map(({ node_id }) => node_id)).toEqual(['c']);
	});

	it('pops the deepest entry', () => {
		expect(popDetailNavStack([item('a'), item('b')]).map(({ node_id }) => node_id)).toEqual(['a']);
		expect(popDetailNavStack([])).toEqual([]);
	});

	it('reports the current record and the parent it came from', () => {
		expect(currentDetailTarget([])).toBeUndefined();
		expect(currentDetailTarget([item('a')])?.parentRouteKey).toBeUndefined();
		expect(currentDetailTarget([item('a'), item('b')])?.parentRouteKey).toBe('a');
	});
});

describe('detail surface service', () => {
	it('reopening a nested surface does not grow the URL', () => {
		const visited: Array<string> = [];
		const service = new DetailSurfaceService({ navigate: (pathname) => visited.push(pathname) });
		const start = new URL('http://host/app/hr_controller/people');

		service.open(start, item('detail', 'r1'));
		const afterFirst = new URL(`http://host${visited.at(-1) ?? ''}`);
		service.open(afterFirst, item('detail', 'r2'));
		const afterSecond = new URL(`http://host${visited.at(-1) ?? ''}`);

		expect(service.read(afterSecond)).toHaveLength(1);
		expect(service.read(afterSecond).at(-1)?.record_id).toBe('r2');
	});

	it('drops the stack parameter entirely once the last surface closes', () => {
		const visited: Array<string> = [];
		const service = new DetailSurfaceService({ navigate: (pathname) => visited.push(pathname) });
		service.open(new URL('http://host/app/x'), item('detail'));
		const opened = new URL(`http://host${visited.at(-1) ?? ''}`);
		service.back(opened);
		expect(visited.at(-1)).not.toContain('stack=');
	});
});

describe('record detail fields', () => {
	it('prefers declared columns and skips row bookkeeping', () => {
		const fields = resolveRecordDetailFields({
			columns: [
				{ name: 'id', type: 'string' },
				{ name: 'norbital_created_at', type: 'datetime' },
				{ name: 'name', type: 'string', required: true },
				{ name: 'headcount', type: 'number' }
			]
		});
		expect(fields.map(({ name }) => name)).toEqual(['name', 'headcount']);
		expect(fields[0]).toMatchObject({ kind: 'string', nullable: false });
	});

	it('treats a generated column as never editable', () => {
		const [field] = resolveRecordDetailFields({
			columns: [{ name: 'summary', type: 'string', required: true, generated: true }]
		});
		expect(field?.nullable).toBe(true);
	});

	it('falls back to the record when nothing is declared', () => {
		const fields = resolveRecordDetailFields({
			record: { norbital_id: 'x', name: 'Ada', active: true, score: 3, payload: { a: 1 } }
		});
		expect(fields.map(({ name, kind }) => [name, kind])).toEqual([
			['name', 'string'],
			['active', 'boolean'],
			['score', 'number'],
			['payload', 'json']
		]);
	});

	it('attaches the relation a foreign key points at', () => {
		const [field] = resolveRecordDetailFields({
			columns: [{ name: 'company_id', type: 'string' }],
			relations: [{ name: 'company', target: 'companies', cardinality: 'one' }]
		});
		expect(field?.relation).toEqual({ name: 'company', target: 'companies' });
	});

	it('leaves an ordinary column without a relation', () => {
		const [field] = resolveRecordDetailFields({
			columns: [{ name: 'name', type: 'string' }],
			relations: [{ name: 'company', target: 'companies' }]
		});
		expect(field?.relation).toBeUndefined();
	});

	it('carries declared enum members through for rendering', () => {
		const [field] = resolveRecordDetailFields({
			columns: [{ name: 'status', type: 'string', values: ['ACTIVE', 'CLOSED'] }]
		});
		expect(field?.values).toEqual(['ACTIVE', 'CLOSED']);
	});
});
