// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function componentSource(relativePath: string): string {
	return readFileSync(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');
}

function between(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
	const endIndex = source.indexOf(end, startIndex);
	assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
	return source.slice(startIndex, endIndex + end.length);
}

test('Kanban lanes own vertical scrolling and fixed-height cards are not nested scrollports', () => {
	const lane = componentSource('collection-kanban/collection-kanban-lane.svelte');
	const laneBody = between(lane, '<Scroll', '</Scroll>');
	const cardBody = between(laneBody, '<CardPrimitive.Content', '</CardPrimitive.Content>');

	assert.match(laneBody, /axis="y"/u);
	assert.match(laneBody, /data-kanban-lane=\{lane\}/u);
	assert.doesNotMatch(cardBody, /<Scroll\b|overflow-y-(?:auto|scroll)|SCROLL_AXIS_CLASSES/u);
});

test('the narrow collection list keeps one records scrollport around every card', () => {
	const list = componentSource('collection-table/collection-table-list.svelte');
	const recordsRegion = between(list, '<Scroll', '</Scroll>');

	assert.match(recordsRegion, /axis="y"/u);
	assert.match(recordsRegion, /name=\{t\('table\.recordsRegion'\)\}/u);
	assert.doesNotMatch(
		between(list, '<a', '</a>'),
		/<Scroll\b|overflow-y-(?:auto|scroll)|SCROLL_AXIS_CLASSES/u
	);
});

test('CollectionTable chooses exactly one responsive body from its own inline size', () => {
	const table = componentSource('collection-table/collection-table.svelte');

	assert.match(
		table,
		/:global\(\.collection-table-responsive\)\s*\{\s*container-type: inline-size;/u
	);
	assert.match(table, /:global\(\.collection-table-narrow\)\s*\{\s*display: none;/u);
	assert.match(
		table,
		/@container \(max-width: 47\.999rem\)[\s\S]*?:global\(\.collection-table-wide\)[\s\S]*?display: none;[\s\S]*?:global\(\.collection-table-narrow\)[\s\S]*?display: grid;/u
	);
});

test('list and Kanban cards render the shared record-warning leading accent', () => {
	const list = componentSource('collection-table/collection-table-list.svelte');
	const board = componentSource('collection-kanban/collection-kanban.svelte');
	const lane = componentSource('collection-kanban/collection-kanban-lane.svelte');

	assert.match(list, /collectionRecordLeadingAccent\(metadata\)/u);
	assert.match(
		list,
		/class=\{cn\('absolute inset-y-0 left-0 z-10', leadingAccent\.markerClass\)\}/u
	);

	assert.match(board, /collectionRecordLeadingAccent\(metadataById\.get\(recordId\) \?\? \[\]\)/u);
	assert.match(board, /getLeadingAccent=\{leadingAccentFor\}/u);
	assert.match(
		lane,
		/class=\{cn\('absolute inset-y-0 left-0 z-10', leadingAccent\.markerClass\)\}/u
	);
});

test('Kanban moves wait for authoritative settlement before reporting success', () => {
	const board = componentSource('collection-kanban/collection-kanban.svelte');
	const commit = between(board, 'function commitCardMove(', '\n\tfunction moveRecord(');

	assert.match(commit, /mutation\.settlement\.wait\(\)/u);
	assert.match(commit, /settlement\.kind === 'accepted' \|\| settlement\.kind === 'rebased'/u);
	assert.match(commit, /settlement\.kind === 'rejected' \? settlement\.message/u);
});

test('tinted warning surfaces keep readable text in both color schemes', () => {
	const metadata = componentSource('collection-record-metadata/collection-record-metadata.svelte');
	const alert = componentSource('alert/alert.svelte');
	const detail = componentSource('collection-table/collection-record-detail.svelte');

	assert.match(
		metadata,
		/border-warning\/40 bg-warning\/10 text-warning-foreground dark:text-warning/u
	);
	assert.match(
		alert,
		/border-warning\/50 bg-warning\/10 text-warning-foreground dark:bg-warning\/30 dark:text-warning/u
	);
	assert.equal(
		detail.match(/bg-warning\/15 text-warning-foreground dark:text-warning/gu)?.length,
		2,
		'both changes-requested warning tints use the dark-mode warning foreground'
	);
});

test('an unbounded CollectionTable yields vertical scrolling to its record-detail parent', () => {
	const types = componentSource('collection-table/collection-table.types.ts');
	const table = componentSource('collection-table/collection-table.svelte');
	const list = componentSource('collection-table/collection-table-list.svelte');
	const grid = componentSource('collection-table/internal/collection-grid.svelte');

	assert.match(types, /bounded\?: boolean/u);
	assert.match(table, /bounded = true/u);
	assert.match(table, /data-collection-table-bounded=\{bounded \? 'true' : 'false'\}/u);
	assert.equal(table.match(/\{bounded\}/gu)?.length, 2, 'both responsive bodies receive bounded');

	assert.match(grid, /axis=\{bounded \? 'both' : 'x'\}/u);
	assert.match(grid, /style=\{bounded \? undefined : 'height: auto; max-height: none;'\}/u);
	assert.match(list, /\{#if bounded\}[\s\S]*?<Scroll axis="y"[\s\S]*?\{:else\}/u);
	const boundedListChoice = between(list, '{#if bounded}', '{/if}');
	const unboundedList = between(boundedListChoice, '{:else}', '{/if}');
	assert.doesNotMatch(unboundedList, /<Scroll\b|overflow-y-(?:auto|scroll)/u);
});

test('CollectionTable paginates a growing live window instead of requiring a first-page cursor', () => {
	const table = componentSource('collection-table/collection-table.svelte');

	assert.match(table, /collectionTablePageWindow\(queryState\.pageIndex, queryState\.pageSize\)/u);
	assert.match(table, /limit: pageWindow\.limit/u);
	assert.match(table, /after: undefined/u);
	assert.match(table, /collectionTablePageRows\(rowsQuery\?\.current, pageWindow\)/u);
	assert.doesNotMatch(table, /rowsQuery\?\.nextCursor/u);
});
