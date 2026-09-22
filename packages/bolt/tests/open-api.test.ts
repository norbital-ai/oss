import { expect, it } from 'vitest';
import { collection, field } from '../src/authoring/workspace-schema.js';
import { apiSegments, openApiDocument } from '../src/runtime/open-api.js';

it('claims only its own three roots, under either mount', () => {
	expect(apiSegments('/api/openapi.json')).toEqual(['openapi.json']);
	expect(apiSegments('/__bolt/request/api/collections/products/abc?limit=2')).toEqual([
		'collections',
		'products',
		'abc'
	]);
	expect(apiSegments('/api/functions/set_status')).toEqual(['functions', 'set_status']);
	// Template media shares the `/api` prefix and must still reach the asset path.
	expect(apiSegments('/__bolt/request/api/template-seed-assets/x.webp')).toBeUndefined();
	expect(apiSegments('/api')).toBeUndefined();
});

it('describes every writable collection and every function', () => {
	// Only the name and the collections are read, so the rest of a definition is left out.
	const definition = {
		name: 'erp',
		collections: [
			{
				...collection({
					name: 'products',
					fields: { product: field.string({ required: true }), stock: field.number() }
				}),
				write: {
					create: { columns: { product: true } },
					update: { columns: { stock: true } },
					hasTransform: false
				}
			}
		]
	} as unknown as Parameters<typeof openApiDocument>[0];
	const document = openApiDocument(
		definition,
		[{ name: 'set_status', description: 'Sets it.', input: { type: 'object' } }],
		'/__bolt/request/api/openapi.json'
	) as { servers: Array<{ url: string }>; paths: Record<string, Record<string, unknown>> };
	expect(document.servers).toEqual([{ url: '/__bolt/request/api' }]);
	expect(Object.keys(document.paths)).toEqual([
		'/collections/products',
		'/collections/products/{id}',
		'/functions/set_status'
	]);
	expect(Object.keys(document.paths['/collections/products/{id}'] ?? {})).toEqual([
		'parameters',
		'get',
		'patch'
	]);
});
