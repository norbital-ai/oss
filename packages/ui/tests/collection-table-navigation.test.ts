// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CollectionTableUrlNavigation } from '../src/collection-table/collection-table-navigation.svelte.ts';

const client = (name: string) => ({
	db: {},
	collections: {},
	records: { findMany: () => ({ name }) }
});

test('resolves a record detail through the client registered by its table route', () => {
	const navigation = new CollectionTableUrlNavigation({
		getUrl: () => new URL('https://workspace.test/people'),
		navigate: () => undefined
	});
	const people = client('people');
	const release = navigation.registerDetailClient(
		'collection-table:workspace-settings:people',
		people
	);

	assert.equal(navigation.detailClient('collection-table:workspace-settings:people'), people);
	assert.equal(navigation.detailClient('collection-table:another-view'), undefined);

	release();
	assert.equal(navigation.detailClient('collection-table:workspace-settings:people'), undefined);
});

test('a stale table cleanup cannot remove the client registered by its replacement', () => {
	const navigation = new CollectionTableUrlNavigation({
		getUrl: () => new URL('https://workspace.test/people'),
		navigate: () => undefined
	});
	const stale = client('stale');
	const current = client('current');
	const releaseStale = navigation.registerDetailClient('people', stale);
	const releaseCurrent = navigation.registerDetailClient('people', current);

	releaseStale();
	assert.equal(navigation.detailClient('people'), current);

	releaseCurrent();
	assert.equal(navigation.detailClient('people'), undefined);
});

test('deep-linked People projections resolve independently of the active table route', () => {
	let url = new URL('https://workspace.test/people');
	const navigation = new CollectionTableUrlNavigation({
		getUrl: () => url,
		navigate: () => undefined
	});
	let projection = client('initial');
	const collections = ['workspace_members', 'workspace_invitations', 'workspace_events'];
	const releases = collections.map((collectionName) =>
		navigation.registerCollectionClient(collectionName, () => projection)
	);

	for (const collectionName of collections) {
		url = new URL('https://workspace.test/people');
		url.searchParams.set(
			'stack',
			JSON.stringify({
				stack: [
					{
						collection_name: collectionName,
						record_id: `${collectionName}-record`,
						node_id: `collection-table:inactive:${collectionName}`,
						viewMode: 'sidesheet'
					}
				]
			})
		);
		const target = navigation.targets[0];
		assert.equal(target?.collectionName, collectionName);
		assert.equal(
			navigation.detailClient(target?.routeKey ?? '', target?.collectionName),
			projection
		);
	}

	const loaded = client('loaded');
	projection = loaded;
	for (const collectionName of collections) {
		assert.equal(navigation.detailClient('restored-after-access-load', collectionName), loaded);
	}

	for (const release of releases) release();
});

test('an explicit host collection does not capture unrelated tenant detail routes', () => {
	const navigation = new CollectionTableUrlNavigation({
		getUrl: () => new URL('https://workspace.test/people'),
		navigate: () => undefined
	});
	const projection = client('people');
	const tenant = client('tenant');
	const releaseProjection = navigation.registerCollectionClient(
		'workspace_members',
		() => projection
	);
	const releaseRoute = navigation.registerDetailClient('collection-table:tenant:employees', tenant);

	assert.equal(
		navigation.detailClient('collection-table:tenant:employees', 'workspace_members'),
		projection
	);
	assert.equal(navigation.detailClient('collection-table:tenant:employees', 'employees'), tenant);
	assert.equal(navigation.detailClient('collection-table:unknown', 'employees'), undefined);

	releaseRoute();
	releaseProjection();
});
