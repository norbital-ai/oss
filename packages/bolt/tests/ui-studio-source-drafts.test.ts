import { describe, expect, it } from 'vitest';
import {
	settleSourceCommit,
	sourceCommitFiles,
	sourceDraftValue,
	updateSourceDrafts,
	type SourceDrafts
} from '../src/client/ui/studio/source-drafts.js';

describe('Studio source drafts', () => {
	it('preserves file A while editing file B and commits both working copies', () => {
		const sourceFiles = {
			'src/a.ts': 'export const a = 1;',
			'src/b.ts': 'export const b = 1;'
		};
		let drafts: SourceDrafts = {};

		drafts = updateSourceDrafts(drafts, sourceFiles, 'src/a.ts', 'export const a = 2;');
		expect(sourceDraftValue(drafts, sourceFiles, 'src/b.ts')).toBe('export const b = 1;');

		drafts = updateSourceDrafts(drafts, sourceFiles, 'src/b.ts', 'export const b = 2;');
		expect(sourceDraftValue(drafts, sourceFiles, 'src/a.ts')).toBe('export const a = 2;');
		expect(sourceCommitFiles(drafts)).toEqual({
			'src/a.ts': 'export const a = 2;',
			'src/b.ts': 'export const b = 2;'
		});
	});

	it('removes reverted drafts and keeps edits made while a commit is in flight', () => {
		const sourceFiles = { 'src/a.ts': 'one', 'src/b.ts': 'one' };
		let drafts = updateSourceDrafts({}, sourceFiles, 'src/a.ts', 'two');
		drafts = updateSourceDrafts(drafts, sourceFiles, 'src/b.ts', 'two');
		drafts = updateSourceDrafts(drafts, sourceFiles, 'src/b.ts', 'one');
		const committedFiles = sourceCommitFiles(drafts);

		drafts = updateSourceDrafts(drafts, sourceFiles, 'src/a.ts', 'three');
		expect(settleSourceCommit(drafts, committedFiles)).toEqual({ 'src/a.ts': 'three' });
	});
});
