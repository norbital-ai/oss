import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const boardSource = readFileSync(
	resolve('../ui/src/collection-kanban/collection-kanban.svelte'),
	'utf8'
);
const laneSource = readFileSync(
	resolve('../ui/src/collection-kanban/collection-kanban-lane.svelte'),
	'utf8'
);

describe('CollectionKanban layout boundary', () => {
	it('gives authored rows the bounded board height and keeps each lane independently scrollable', () => {
		expect(boardSource).toMatch(
			/<Scroll[\s\S]*name="Kanban lanes"[\s\S]*<Grid[\s\S]*class="h-full content-start pb-1"/
		);
		expect(laneSource).toMatch(/<Scroll[\s\S]*axis="y"[\s\S]*class="pr-1 pb-1"/);
	});
});
