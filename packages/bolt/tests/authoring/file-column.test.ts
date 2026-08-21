import { describe, expect, it } from 'vitest';
import { file } from '../../src/authoring/models-schema.js';
import { describeModelColumns } from '../../src/authoring/model-introspection.js';

/**
 * What a `file()` column is, and the one way of declaring several that works.
 *
 * The column used to be a bare `uuid` naming a `document_asset` row. Nothing enforced the tie — no
 * foreign key, no validation on write — and the upload path never wrote the row, so every file
 * uploaded at runtime resolved against nothing and rendered empty. Inline, the value *is* the file,
 * so it arrives with the record, inherits its row predicate and field mask, and there is no id to
 * forge.
 *
 * The `.array()` case is the one worth a test rather than a comment. It reads as the obvious way to
 * hold several files and it is silently wrong: `describeModelColumns` records only `dimensions` for
 * a dimensioned builder and drops the scalar type, so `isJsonColumn` answers false and the write
 * binds a JSON array as a Postgres array — a failure that surfaces at insert time in a template,
 * nowhere near the declaration that caused it. Throwing at declaration puts it back where it
 * belongs.
 */
describe('file()', () => {
	it('is a jsonb column, so the file travels with the record that owns it', () => {
		const columns = describeModelColumns({ photo: file() });
		expect(columns['photo']?.type).toBe('json');
	});

	it('carries its mime restriction and its multiplicity into introspection', () => {
		const single = describeModelColumns({ photo: file({ mimeTypes: ['image/png'] }) });
		expect(single['photo']?.file).toBe(true);
		expect(single['photo']?.mimeTypes).toEqual(['image/png']);
		expect(single['photo']?.fileMultiple).toBeUndefined();

		const many = describeModelColumns({ attachments: file({ multiple: true }) });
		expect(many['attachments']?.type).toBe('json');
		expect(many['attachments']?.fileMultiple).toBe(true);
	});

	it('refuses .array(), which would bind a JSON array as a Postgres array', () => {
		expect(() => file().array()).toThrowError(/multiple: true/);
	});
});
