import { describe, expect, it } from 'vitest';
import { impact_lines } from '../src/protocol/migration-impact.ts';

describe('what a person reads before a merge', () => {
	it('names every step that wrote rows, the downtime and what a rollback costs, and no bookkeeping', () => {
		expect(
			impact_lines({
				duration_ms: 1400,
				steps: [
					{ id: 'create:column:notes.level', hazard: 'additive', rows: 7, summary: '' },
					{ id: 'create:column:notes.size', hazard: 'additive', rows: 0, summary: '' },
					{ id: 'replace:history:current', hazard: 'additive', rows: 1, summary: '' },
					{ id: 'data:notes.level', hazard: 'data', rows: 3, summary: '' }
				]
			})
		).toEqual([
			'Writes 7 rows (create:column:notes.level)',
			'Writes 3 rows (data:notes.level)',
			'Expected downtime about 1 s (measured on the preview)',
			'Rolling back later would lose anything written after this merge'
		]);
	});
});
