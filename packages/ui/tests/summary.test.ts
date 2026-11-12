// A collapsed section's one line: the set values joined, a text's first words, a file count over every file field;
// ui's own words outside a catalog, the workspace's `ui.summary.*` inside one.
import './resolve.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
const { files_summary, joined_summary, notes_summary } = await import('../src/utilities/summary.ts');

const english = { t: (key: string) => key };

it.effect('summaries name what a closed section holds', () =>
	Effect.sync(() => {
		assert.equal(joined_summary(english, ['a@b.co', null, '', undefined, 'x.co']), 'a@b.co · x.co');
		assert.equal(joined_summary(english, [null]), 'Not set');
		assert.equal(notes_summary(english, '  short  '), 'short');
		assert.equal(notes_summary(english, 'x'.repeat(70)), `${'x'.repeat(60)}…`);
		assert.equal(notes_summary(english, null), 'None');
		const file = { id: 'f1', name: 'a.pdf', mime: 'application/pdf' };
		assert.deepEqual(
			[
				files_summary(english),
				files_summary(english, file, null),
				files_summary(english, [file, file], file)
			],
			['No files', '1 file', '3 files']
		);
		assert.equal(
			joined_summary(
				{ t: (key: string) => (key === 'ui.summary.notSet' ? 'Belum diisi' : key) },
				[]
			),
			'Belum diisi'
		);
	})
);
