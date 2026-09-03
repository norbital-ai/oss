import { describe, expect, it } from 'vitest';
import { defineModel, file, text } from '../src/authoring/index.js';
import {
	collectionCatalogEntry,
	compileModel,
	describeModel
} from '../src/authoring/model-introspection.js';
import { collection } from '../src/authoring/workspace-schema.js';

/**
 * Two more options a workspace declared and the compiler discarded.
 *
 * Both had the same shape of failure as `text({ search: true })`: the declaration was accepted, so
 * nothing anywhere failed, and the effect simply never happened. Neither had a test, which is why
 * they lasted — `tests/authoring/metadata-witness.test.ts` is the structural answer to that.
 */

describe('file({ mimeTypes })', () => {
	/**
	 * The argument was `_options`, so four workspaces declared an accept list that no picker saw.
	 * It travels on the builder like `search` does, because the column stores a file id and there is
	 * nothing about the file for a database constraint to check.
	 */
	it('survives onto the column declaration', () => {
		const fields = describeModel(
			defineModel({
				contract: file({ mimeTypes: ['application/pdf'] }),
				evidence: file({ mimeTypes: ['image/jpeg', 'image/png'] }).notNull(),
				anything: file()
			})
		);
		expect(fields.contract?.mimeTypes).toEqual(['application/pdf']);
		expect(fields.evidence?.mimeTypes).toEqual(['image/jpeg', 'image/png']);
		expect(fields.evidence?.required).toBe(true);
		// A file column with no declared list must not claim an empty one: "any type" and "no type" are
		// different answers, and an empty `accept` would offer nothing at all.
		expect(fields.anything).not.toHaveProperty('mimeTypes');
	});

	/** A json column either way — the accept list is a rendering concern, never a storage one. */
	it('changes nothing about the column it declares', () => {
		const fields = describeModel(
			defineModel({ contract: file({ mimeTypes: ['application/pdf'] }) })
		);
		expect(fields.contract?.type).toBe('json');
	});

	it('projects the accept list into the client catalog', () => {
		const compiled = compileModel(
			collection({ name: 'documents', fields: {} }),
			defineModel({ contract: file({ mimeTypes: ['application/pdf'] }) })
		);
		expect(collectionCatalogEntry(compiled, []).fields[0]?.mimeTypes).toEqual([
			'application/pdf'
		]);
	});
});

describe('recordLabel', () => {
	const catalogFor = (label: string | ReadonlyArray<string>) =>
		collectionCatalogEntry(
			compileModel(
				collection({ name: 'payslips', fields: {} }),
				defineModel({ code: text(), name: text() }, { recordLabel: label })
			),
			[]
		).recordLabel;

	/**
	 * The pattern required a quote straight after the colon, which only the single-column form
	 * satisfies — so `recordLabel: ['currency', 'net']`, a form `ModelMetadata` has always permitted
	 * and ten payroll models use, produced no label at all and left those tables titling rows from
	 * whichever column came first.
	 */
	it('recovers the multi-column form its own type permits', () => {
		expect(catalogFor(['code', 'name'])).toBe("code + ' · ' + name");
	});

	/**
	 * The joined form is not decorative: `resolveRecordLabel` splits a label on exactly this
	 * separator and evaluates each term alone, so one empty column costs its own term instead of the
	 * whole title. A bare list would reach it as one expression it cannot parse.
	 */
	it('joins terms the way the resolver splits them', () => {
		expect(/\s\+\s'\s·\s'\s\+\s/.test(catalogFor(['a', 'b', 'c']) ?? '')).toBe(true);
	});

	it('leaves the single-column form exactly as declared', () => {
		expect(catalogFor('month')).toBe('month');
	});

	it('reports no label when a model declares none', () => {
		const compiled = compileModel(
			collection({ name: 'payslips', fields: {} }),
			defineModel({ code: text() })
		);
		expect(collectionCatalogEntry(compiled, []).recordLabel).toBeUndefined();
	});
});
