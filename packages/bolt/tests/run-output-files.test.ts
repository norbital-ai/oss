import { expect, it } from 'vitest';
import type { InputKind } from '../src/decl/fields.ts';
import { outputFiles } from '../src/engine/runs/output-files.ts';

const file = { kind: 'file', accept: ['*/*'], max: '20MiB' } satisfies InputKind;
const ref = (id: string) => ({ id, name: `${id}.csv`, mime: 'text/csv' });

it('collects declared output files through structured and custom kinds, once per id', () => {
	const kind: InputKind = {
		kind: 'object',
		fields: {
			direct: file,
			multiple: { ...file, multiple: true },
			list: { kind: 'list', of: file },
			record: { kind: 'record', of: file },
			tagged: { kind: 'union', by: 'status', arms: { ready: { report: file } } },
			shaped: { kind: 'json', shape: file },
			custom: { kind: 'custom', of: 'report', many: true },
			builtin: { kind: 'custom', of: 'file' },
			opaque: { kind: 'json' }
		},
		rest: file
	};
	expect(
		outputFiles(
			kind,
			{
				direct: { ...ref('direct'), bytes: 3, sha256: 'abc' },
				multiple: [ref('direct'), ref('multiple')],
				list: [ref('list')],
				record: { first: ref('record') },
				tagged: { status: 'ready', report: ref('tagged') },
				shaped: ref('shaped'),
				custom: [{ document: ref('custom') }],
				builtin: ref('builtin'),
				opaque: ref('opaque'),
				extra: ref('extra')
			},
			{
				report: {
					description: 'A report',
					shape: { kind: 'object', fields: { document: file } }
				}
			}
		)
	).toEqual(
		['direct', 'multiple', 'list', 'record', 'tagged', 'shaped', 'custom', 'builtin', 'extra'].map(
			ref
		)
	);
});

it('ignores opaque, undeclared, malformed and wrong-cardinality references', () => {
	for (const kind of [undefined, { kind: 'json' }, { kind: 'custom', of: 'missing' }] satisfies (
		InputKind | undefined
	)[])
		expect(outputFiles(kind, ref('opaque'))).toEqual([]);
	for (const value of [
		{ ...ref('forged'), path: '/private/secret' },
		{ ...ref('bad-mime'), mime: 1 },
		{ ...ref('bad-size'), bytes: '3' },
		{ ...ref('empty'), id: '' },
		[ref('array')]
	])
		expect(outputFiles(file, value)).toEqual([]);
	expect(outputFiles({ ...file, multiple: true }, ref('scalar'))).toEqual([]);
	expect(outputFiles({ kind: 'record', of: file }, [ref('wrong-container')])).toEqual([]);
	expect(outputFiles({ kind: 'object', fields: {}, rest: file }, [ref('wrong-container')])).toEqual(
		[]
	);
	expect(
		outputFiles(
			{ kind: 'union', by: 'status', arms: { ready: { report: file } } },
			{ status: 'other', report: ref('wrong-arm') }
		)
	).toEqual([]);
	expect(
		outputFiles(
			{
				kind: 'object',
				fields: { id: { kind: 'text' }, name: { kind: 'text' }, mime: { kind: 'text' } }
			},
			ref('lookalike')
		)
	).toEqual([]);
});

it('stops recursive custom aliases without treating their contents as undeclared files', () => {
	expect(
		outputFiles(
			{ kind: 'custom', of: 'recursive' },
			{ report: ref('recursive') },
			{
				recursive: {
					description: 'Recursive alias',
					shape: { kind: 'object', fields: { report: { kind: 'custom', of: 'recursive' } } }
				}
			}
		)
	).toEqual([]);
});
