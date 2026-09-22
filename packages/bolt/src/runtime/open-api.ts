import { Effect, Schema } from 'effect';
import type { DispatchResponse, EffectId, Invocation } from '@norbital-ai/bolt-protocol';
import type { FieldDefinition } from '#lib/authoring/workspace-schema.js';
import { compileOrderTerms } from '#lib/runtime/access/effective-plan.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { encodeCollectionCursor } from '#lib/runtime/collections/read/cursor.js';
import { RemoteRegistry } from '#lib/runtime/collections/authored.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { DispatchError } from '#lib/runtime/workspace.js';

/**
 * Every workspace's collections and functions, as one plain HTTP API with an OpenAPI document.
 *
 * Nothing here is a second way to reach data: a list is `findMany`, a create is `write`, a function
 * call is the authored function — each run as the caller, so the caller's policies decide exactly
 * what a browser session with the same policies would be allowed. The shape follows what an ERP's
 * OData service offers an outside system, in plain REST:
 *
 * | ERP (OData)                         | Here                                              |
 * | ----------------------------------- | ------------------------------------------------- |
 * | `$metadata`                         | `GET  /api/openapi.json`                          |
 * | entity set read, `$top`/`$skiptoken` | `GET  /api/collections/{name}?limit=&after=`      |
 * | delta read, `LastChangeDateTime gt` | `GET  /api/collections/{name}?updated_since=`      |
 * | `$filter=Field eq 'x'`              | `GET  /api/collections/{name}?field=x`             |
 * | entity read by key                  | `GET  /api/collections/{name}/{id}`               |
 * | create / update / delete            | `POST` / `PATCH` / `DELETE` on the same paths     |
 * | function import / bound action      | `POST /api/functions/{name}`                      |
 * | communication user                  | an `apiKey` variable in `+env.ts`, as a bearer    |
 *
 * Mounted under the workspace's request prefix, so the public root is `<origin>/__bolt/request/api`.
 */

// Only these three roots: everything else under `/api` (template seed assets among them) is not this.
const API = /^(?:\/__bolt\/request)?\/api\/((?:openapi\.json|collections|functions)(?:\/.*)?)$/;
const RESERVED = new Set(['limit', 'after', 'order_by', 'updated_since']);
const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;

/** The segments after `/api`, or nothing when the request is not for this API. */
export const apiSegments = (url: string): ReadonlyArray<string> | undefined => {
	const match = API.exec(new URL(url, 'http://bolt.invalid').pathname);
	return match === null
		? undefined
		: (match[1] ?? '')
				.split('/')
				.filter((part) => part !== '')
				.map(decodeURIComponent);
};

const answer = (status: number, value?: Schema.Json): DispatchResponse => ({
	status,
	headers: { 'content-type': ['application/json'] },
	...(value === undefined ? {} : { value })
});

const notFound = (message: string) => new DispatchError({ code: 'not_found', message });

const jsonBody = (invocation: Extract<Invocation, { _tag: 'Request' }>) =>
	Effect.try({
		try: (): unknown =>
			invocation.body === undefined || invocation.body.byteLength === 0
				? {}
				: JSON.parse(new TextDecoder().decode(invocation.body)),
		catch: () => new DispatchError({ code: 'invalid_input', message: 'The body is not JSON.' })
	}).pipe(
		Effect.flatMap((body) =>
			typeof body === 'object' && body !== null && !Array.isArray(body)
				? Effect.succeed(body as Readonly<Record<string, unknown>>)
				: Effect.fail(
						new DispatchError({ code: 'invalid_input', message: 'The body must be a JSON object.' })
					)
		)
	);

/**
 * `field` or `-field`, comma-separated, into the query's `orderBy`. A delta read defaults to change
 * order, so a caller that keeps the greatest `updated_at` it saw as its watermark never skips a row.
 */
const orderByOf = (
	value: string | null,
	delta: boolean
): Readonly<Record<string, 'asc' | 'desc'>> =>
	Object.fromEntries(
		(value ?? (delta ? 'updated_at' : 'id'))
			.split(',')
			.filter((term) => term !== '')
			.map((term) => (term.startsWith('-') ? [term.slice(1), 'desc'] : [term, 'asc']))
	);

/** The temporal bookkeeping a history table carries is not part of the record. */
const publicRow = ({ sys_period: _period, ...row }: Readonly<Record<string, Schema.Json>>) => row;

/** Equality on declared columns, and the delta watermark on `updated_at`. */
const whereOf = (
	params: URLSearchParams,
	fields: Readonly<Record<string, FieldDefinition>>
): Readonly<Record<string, unknown>> => {
	const where: Record<string, unknown> = {};
	for (const [name, value] of params) {
		if (RESERVED.has(name)) continue;
		const field = fields[name];
		if (field === undefined) continue;
		where[name] =
			field.type === 'number' ? Number(value) : field.type === 'boolean' ? value === 'true' : value;
	}
	const since = params.get('updated_since');
	if (since !== null && since !== '') where['updated_at'] = { gt: since };
	return where;
};

const listCollection = Effect.fn('Bolt.api.list')(function* (
	effectId: EffectId,
	subject: Identity.Subject,
	collection: string,
	fields: Readonly<Record<string, FieldDefinition>>,
	params: URLSearchParams
) {
	const limit = Math.min(
		Math.max(Number(params.get('limit') ?? PAGE_DEFAULT) || PAGE_DEFAULT, 1),
		PAGE_MAX
	);
	const orderBy = orderByOf(params.get('order_by'), (params.get('updated_since') ?? '') !== '');
	const after = params.get('after');
	// One row more than the page says whether there is a next one, without a count.
	const rows = yield* (yield* Collections.Service).findMany(effectId, subject, {
		collection,
		where: whereOf(params, fields),
		orderBy,
		limit: limit + 1,
		...(after === null || after === '' ? {} : { after })
	});
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	const next =
		rows.length > limit && last !== undefined
			? encodeCollectionCursor(
					compileOrderTerms((yield* Workspace.Service).definition, collection, orderBy),
					last
				)
			: null;
	return answer(200, { value: page.map(publicRow), next });
});

const writeCollection = Effect.fn('Bolt.api.write')(function* (
	effectId: EffectId,
	subject: Identity.Subject,
	collection: string,
	action: 'create' | 'update' | 'delete',
	input: Readonly<Record<string, unknown>>
) {
	const commit = yield* (yield* Collections.Service).write(effectId, subject, [
		{ collection, action, inputs: [input] }
	]);
	if (commit.pendingApproval !== undefined)
		return answer(202, { pending: true, requestId: commit.pendingApproval.requestId });
	if (action === 'delete') return answer(204);
	return answer(
		action === 'create' ? 201 : 200,
		publicRow(
			Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(commit.records[0] ?? {})
		)
	);
});

/** Answers one request under `/api` as `subject`. */
export const answerApiRequest = Effect.fn('Bolt.api.answer')(function* (
	invocation: Extract<Invocation, { _tag: 'Request' }>,
	segments: ReadonlyArray<string>,
	effectId: EffectId,
	subject: Identity.Subject
) {
	const url = new URL(invocation.url, 'http://bolt.invalid');
	const method = invocation.method.toUpperCase();
	const definition = (yield* Workspace.Service).definition;
	const [kind, name, id, ...rest] = segments;
	if (rest.length > 0) return yield* notFound(`${url.pathname} is not an API path.`);

	if (kind === 'openapi.json' && method === 'GET')
		return answer(
			200,
			openApiDocument(definition, (yield* RemoteRegistry).describe(), url.pathname)
		);

	if (kind === 'functions' && name !== undefined && id === undefined && method === 'POST') {
		const registry = yield* RemoteRegistry;
		if (!registry.names.has(name)) return yield* notFound(`There is no function named ${name}.`);
		const output = yield* registry.invoke(name, yield* jsonBody(invocation), subject, effectId);
		return answer(200, { value: output });
	}

	const collection =
		kind === 'collections' && name !== undefined
			? definition.collections.find((candidate) => candidate.name === name)
			: undefined;
	if (collection === undefined) return yield* notFound(`${url.pathname} is not an API path.`);
	if (id === undefined) {
		if (method === 'GET')
			return yield* listCollection(
				effectId,
				subject,
				collection.name,
				collection.fields,
				url.searchParams
			);
		if (method === 'POST')
			return yield* writeCollection(
				effectId,
				subject,
				collection.name,
				'create',
				yield* jsonBody(invocation)
			);
	} else {
		if (method === 'GET') {
			const row = yield* (yield* Collections.Service).findFirst(effectId, subject, {
				collection: collection.name,
				where: { id }
			});
			return row === undefined
				? yield* notFound(`${collection.name} has no record ${id} you can read.`)
				: answer(200, publicRow(row));
		}
		if (method === 'PATCH')
			return yield* writeCollection(effectId, subject, collection.name, 'update', {
				...(yield* jsonBody(invocation)),
				id
			});
		if (method === 'DELETE')
			return yield* writeCollection(effectId, subject, collection.name, 'delete', { id });
	}
	return yield* new DispatchError({
		code: 'method_not_allowed',
		message: `${method} is not supported on ${url.pathname}.`
	});
});

/** One column as JSON Schema: what a reader gets back. */
const fieldSchema = (field: FieldDefinition): Record<string, Schema.Json> => {
	const base: Record<string, Schema.Json> =
		field.values !== undefined
			? { type: 'string', enum: [...field.values] }
			: field.type === 'number'
				? { type: 'number' }
				: field.type === 'boolean'
					? { type: 'boolean' }
					: field.type === 'instant'
						? { type: 'string', format: field.precision === 'day' ? 'date' : 'date-time' }
						: field.type === 'uuid' || field.type === 'reference'
							? { type: 'string', format: 'uuid' }
							: field.type === 'json'
								? {}
								: { type: 'string' };
	return field.required ? base : { anyOf: [base, { type: 'null' }] };
};

const writeSchema = (
	fields: Readonly<Record<string, FieldDefinition>>,
	columns: Readonly<Record<string, true>> | undefined
): Schema.Json => ({
	type: 'object',
	properties: Object.fromEntries(
		Object.keys(columns ?? {})
			.filter((name) => fields[name] !== undefined)
			.map((name) => [name, fieldSchema(fields[name] as FieldDefinition)])
	)
});

const json = { 'application/json': {} } as const;
const content = (schema: Schema.Json) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/**
 * The OpenAPI 3.1 document for this workspace: every collection that declares a write contract
 * (the ones an outside system can see through policies at all) and every authored function.
 */
export const openApiDocument = (
	definition: Workspace.Interface['definition'],
	functions: ReadonlyArray<{
		name: string;
		description: string | undefined;
		input: Schema.Json | undefined;
	}>,
	documentPath: string
): Schema.Json => {
	const collections = definition.collections.filter(
		(collection) => collection.write !== undefined && !collection.name.startsWith('bolt_')
	);
	const idParameter = {
		name: 'id',
		in: 'path',
		required: true,
		schema: { type: 'string', format: 'uuid' }
	};
	const paths: Record<string, Schema.Json> = {};
	const schemas: Record<string, Schema.Json> = {};
	for (const collection of collections) {
		const { name, fields, write } = collection;
		schemas[name] = {
			type: 'object',
			...(collection.description === undefined ? {} : { description: collection.description }),
			properties: {
				...Object.fromEntries(
					Object.entries(fields)
						.filter(([field]) => !field.startsWith('bolt_') && field !== 'search_document')
						.map(([field, definitionOf]) => [field, fieldSchema(definitionOf)])
				),
				id: { type: 'string', format: 'uuid' },
				created_at: { type: 'string', format: 'date-time' },
				updated_at: { type: 'string', format: 'date-time' },
				row_version: { type: 'integer' }
			}
		};
		const filters = Object.entries(fields)
			.filter(([field, spec]) => spec.indexed || spec.values !== undefined || field.endsWith('_id'))
			.map(([field, spec]) => ({ name: field, in: 'query', schema: fieldSchema(spec) }));
		paths[`/collections/${name}`] = {
			get: {
				operationId: `list_${name}`,
				tags: [name],
				summary: `List ${name}`,
				parameters: [
					{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: PAGE_MAX } },
					{
						name: 'after',
						in: 'query',
						description: 'The `next` of the previous page.',
						schema: { type: 'string' }
					},
					{
						name: 'order_by',
						in: 'query',
						description: '`field` or `-field`, comma-separated.',
						schema: { type: 'string' }
					},
					{
						name: 'updated_since',
						in: 'query',
						description: 'Only records changed after this instant: the delta read.',
						schema: { type: 'string', format: 'date-time' }
					},
					...filters
				],
				responses: {
					'200': {
						description: 'One page.',
						content: content({
							type: 'object',
							properties: {
								value: { type: 'array', items: ref(name) },
								next: { type: ['string', 'null'] }
							}
						})
					}
				}
			},
			...(write?.create === undefined
				? {}
				: {
						post: {
							operationId: `create_${name}`,
							tags: [name],
							requestBody: {
								required: true,
								content: content(writeSchema(fields, write.create.columns))
							},
							responses: {
								'201': { description: 'Created.', content: content(ref(name)) },
								'202': { description: 'Held for approval.', content: json }
							}
						}
					})
		};
		paths[`/collections/${name}/{id}`] = {
			parameters: [idParameter],
			get: {
				operationId: `get_${name}`,
				tags: [name],
				responses: { '200': { description: 'The record.', content: content(ref(name)) } }
			},
			...(write?.update === undefined
				? {}
				: {
						patch: {
							operationId: `update_${name}`,
							tags: [name],
							requestBody: {
								required: true,
								content: content(writeSchema(fields, write.update.columns))
							},
							responses: {
								'200': { description: 'Updated.', content: content(ref(name)) },
								'202': { description: 'Held for approval.', content: json }
							}
						}
					}),
			...(write?.delete === true
				? {
						delete: {
							operationId: `delete_${name}`,
							tags: [name],
							responses: { '204': { description: 'Deleted.' } }
						}
					}
				: {})
		};
	}
	for (const fn of functions)
		paths[`/functions/${fn.name}`] = {
			post: {
				operationId: fn.name,
				tags: ['functions'],
				...(fn.description === undefined ? {} : { summary: fn.description }),
				requestBody: { required: true, content: content(fn.input ?? { type: 'object' }) },
				responses: {
					'200': {
						description: 'The function answered.',
						content: content({ type: 'object', properties: { value: {} } })
					}
				}
			}
		};
	return {
		openapi: '3.1.0',
		info: { title: definition.name, version: '1' },
		servers: [{ url: documentPath.replace(/\/openapi\.json$/, '') }],
		security: [{ bearer: [] }],
		components: {
			securitySchemes: {
				bearer: {
					type: 'http',
					scheme: 'bearer',
					description:
						'A session token, or the value of an `apiKey` variable declared in `+env.ts`.'
				}
			},
			schemas
		},
		paths
	} as Schema.Json;
};
