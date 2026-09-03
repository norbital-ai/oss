import { describe, expect, it } from 'vitest';
import { systemCollectionCatalog } from '../src/compiler/workspace-build.js';

/**
 * The six durable agent collections, and the names the Effect cutover retired.
 *
 * Shared by the catalog assertions below: the names the client is served, and the names the
 * Effect cutover retired.
 */
const DURABLE_AGENT_COLLECTIONS = [
	'agent_task',
	'agent_plan',
	'agent_message',
	'agent_inbox',
	'agent_run',
	'agent_usage'
] as const;

const RETIRED_AGENT_COLLECTIONS = [
	'chat_session',
	'chat_message',
	'chat_message_part',
	'agent_lane'
] as const;

/**
 * The client catalog has to describe the collections the *platform* declares, not only the ones a
 * workspace authors.
 *
 * `WorkspaceApis.create` answers an unknown collection with `{ name, fields: [], relationships: [] }`
 * instead of failing, so a collection missing from the catalog does not surface as a missing
 * collection — every column declared against it is reported as unknown. The shell's own Approvals
 * surface renders `CollectionTable collection="approval_request"`, and the whole workspace client
 * refused to load with `declares unknown column "collection_name"` on a column the model has
 * always declared.
 */
describe('system collection catalog', () => {
	const entries = systemCollectionCatalog();
	const byName = new Map(entries.map((entry) => [entry.name, entry]));

	it('publishes approval_request with the columns the shell renders', () => {
		const approval = byName.get('approval_request');
		expect(approval).toBeDefined();
		const fields = approval?.fields.map(({ name }) => name) ?? [];
		for (const column of ['collection_name', 'action', 'record_id', 'status', 'proposed_values']) {
			expect(fields).toContain(column);
		}
	});

	it('publishes the identity collections a shell surface can bind to', () => {
		for (const name of ['user', 'team', 'session']) expect(byName.has(name)).toBe(true);
	});

	it('publishes exactly the six canonical durable agent collections', () => {
		for (const name of DURABLE_AGENT_COLLECTIONS) expect(byName.has(name)).toBe(true);
		for (const retired of RETIRED_AGENT_COLLECTIONS) expect(byName.has(retired)).toBe(false);
	});

	it('publishes automation observability without queue and retry columns', () => {
		const fields = byName.get('automation_run')?.fields.map(({ name }) => name) ?? [];
		for (const field of ['task_id', 'name', 'status', 'progress', 'result', 'error']) {
			expect(fields).toContain(field);
		}
		for (const retired of ['attempts', 'max_attempts', 'next_run_at', 'lane', 'position']) {
			expect(fields).not.toContain(retired);
		}
	});

	it('gives every field a catalog kind rather than defaulting silently', () => {
		const kinds = new Set(entries.flatMap((entry) => entry.fields.map(({ kind }) => kind)));
		expect(kinds.size).toBeGreaterThan(1);
		for (const kind of kinds) expect(kind).toMatch(/^[a-z_]+$/);
	});

	it('marks a required column non-nullable', () => {
		const approval = byName.get('approval_request');
		const collectionName = approval?.fields.find(({ name }) => name === 'collection_name');
		expect(collectionName?.nullable).toBe(false);
	});
});
