// A collapsed section's one line: the set values joined, a text's first words, a file count over every file field;
// ui's own words outside a catalog, the workspace's `ui.summary.*` inside one.
import './resolve.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
const { filesSummary, joinedSummary, notesSummary } = await import('../src/utilities/summary.ts');

const english = { t: (key: string) => key };

it.effect('summaries name what a closed section holds', () =>
	Effect.sync(() => {
		assert.equal(joinedSummary(english, ['a@b.co', null, '', undefined, 'x.co']), 'a@b.co · x.co');
		assert.equal(joinedSummary(english, [null]), 'Not set');
		assert.equal(notesSummary(english, '  short  '), 'short');
		assert.equal(notesSummary(english, 'x'.repeat(70)), `${'x'.repeat(60)}…`);
		assert.equal(notesSummary(english, null), 'None');
		const file = { id: 'f1', name: 'a.pdf', mime: 'application/pdf' };
		assert.deepEqual(
			[
				filesSummary(english),
				filesSummary(english, file, null),
				filesSummary(english, [file, file], file)
			],
			['No files', '1 file', '3 files']
		);
		assert.equal(
			joinedSummary(
				{ t: (key: string) => (key === 'ui.summary.notSet' ? 'Belum diisi' : key) },
				[]
			),
			'Belum diisi'
		);
	})
);
