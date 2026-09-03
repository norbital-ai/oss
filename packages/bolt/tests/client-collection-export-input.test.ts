import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { CollectionQueryRequest } from '@norbital-ai/bolt-protocol';
import { collectionExportCommandInput } from '../src/client/ui/state/import-export.js';

describe('collectionExportCommandInput', () => {
	it('maps the browser aliases onto CollectionQueryRequest', () => {
		const input = collectionExportCommandInput({
			collection_name: 'payroll_runs',
			record_ids: ['run-1']
		});
		expect(input).toEqual({
			collection: 'payroll_runs',
			where: { id: { in: ['run-1'] } },
			limit: 1
		});
		expect(Schema.is(CollectionQueryRequest)(input)).toBe(true);
	});

	it('keeps an already-valid query and does not invent a where', () => {
		const input = collectionExportCommandInput({ collection: 'notes' });
		expect(input).toEqual({ collection: 'notes' });
		expect(Schema.is(CollectionQueryRequest)(input)).toBe(true);
	});

	it('forwards a CollectionQueryRequest where instead of dropping it', () => {
		const where = { id: { in: ['run-1'] } };
		const input = collectionExportCommandInput({
			collection: 'payroll_runs',
			where,
			limit: 1
		});
		expect(input).toEqual({ collection: 'payroll_runs', where, limit: 1 });
		expect(Schema.is(CollectionQueryRequest)(input)).toBe(true);
	});
});
