import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { systemCollectionCatalog } from '../../src/compiler/workspace-build.js';

/**
 * The six durable agent collections, and the names the Effect cutover retired.
 *
 * Shared by the two assertions below because they are the same claim read from two places: the
 * catalog the client is served, and the durable schema sources it is derived from.
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

	/**
	 * The same six names one layer down, in the sources the catalog is built from.
	 *
	 * The catalog assertion above is satisfied by a schema that still *declares* the retired shapes
	 * and merely withholds them from the client, which is exactly the compatibility path the Effect
	 * cutover was meant to leave nothing of. So the durable sources are read directly: a retired
	 * collection, a retired reference type, or a retired usage entry point reappearing anywhere in
	 * them fails here rather than surviving behind a filter.
	 */
	it('keeps the Effect durable schema cutover flagless', async () => {
		const sources = await Promise.all(
			[
				new URL('../../../bolt-protocol/src/facilities.ts', import.meta.url),
				new URL('../../../bolt-protocol/src/system.ts', import.meta.url),
				new URL('../../src/authoring/system-models.ts', import.meta.url),
				new URL('../../src/runtime/agents/agents.ts', import.meta.url),
				new URL('../../src/runtime/schema/system-collections.ts', import.meta.url)
			].map((url) => readFile(url, 'utf8'))
		);
		const durableSource = sources.join('\n');

		for (const forbidden of [
			...RETIRED_AGENT_COLLECTIONS,
			'agent_message_part',
			'ChatDocumentRef',
			'AgentEnqueueResult',
			'addAIUsage',
			'readAIUsage',
			'TurnResult'
		]) {
			expect(durableSource, forbidden).not.toContain(forbidden);
		}
		for (const required of DURABLE_AGENT_COLLECTIONS) {
			expect(durableSource, required).toContain(required);
		}
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
