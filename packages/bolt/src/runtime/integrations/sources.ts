import { Effect, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { HttpConnection } from '#lib/authoring/contracts-schema.js';
import type { HttpRecordsSpec, PageSpec } from '#lib/authoring/integrations-schema.js';
import type { ConnectorInterface } from '#lib/runtime/facilities/services.js';
import {
	connectionUrl,
	nextLink,
	performRequest,
	walk,
	type Fetched,
	type HttpFailure,
	type ResolvedConnection
} from '#lib/runtime/integrations/http.js';

/**
 * The source contract as the engine calls it (integrations.md §5). A capability a provider lacks is
 * simply absent; the engine never special-cases a provider.
 */
export type SourceFailure = Readonly<{
	readonly message: string;
	readonly retryable: boolean;
	readonly status?: number;
	/** The source refused a conditional write because its version moved. */
	readonly conflict?: boolean;
}>;

export type Page = Readonly<{
	readonly records: ReadonlyArray<unknown>;
	/** Opaque: handed back to read the next page; absent on the last. */
	readonly next?: string;
	/** A `changes` run's new cursor, known once its last page is read. */
	readonly cursor?: string;
}>;

export type SourceAdapter = Readonly<{
	readonly list: (effectId: EffectId, page: string | undefined) => Effect.Effect<Page, SourceFailure>;
	readonly changes?: (
		effectId: EffectId,
		cursor: string | null,
		page: string | undefined
	) => Effect.Effect<Page, SourceFailure>;
	readonly get?: (effectId: EffectId, identity: string) => Effect.Effect<unknown, SourceFailure>;
	readonly create?: (
		effectId: EffectId,
		body: Readonly<Record<string, unknown>>,
		key: string
	) => Effect.Effect<unknown, SourceFailure>;
	readonly update?: (
		effectId: EffectId,
		identity: string,
		body: Readonly<Record<string, unknown>>,
		ifVersion: string | null
	) => Effect.Effect<unknown, SourceFailure>;
	readonly delete?: (
		effectId: EffectId,
		identity: string,
		ifVersion: string | null
	) => Effect.Effect<'deleted' | 'missing', SourceFailure>;
}>;

/** One page's position, serialised into the opaque `next` the engine persists per page. */
const PageState = Schema.Struct({
	index: Schema.Number,
	token: Schema.optionalKey(Schema.String),
	url: Schema.optionalKey(Schema.String),
	watermark: Schema.optionalKey(Schema.String)
});
type PageState = typeof PageState.Type;
const decodePageState = Schema.decodeUnknownSync(Schema.fromJsonString(PageState));
const pageState = (value: string | undefined): PageState =>
	value === undefined ? { index: 0 } : decodePageState(value);

const DEFAULT_MAX_PAGES = 50;

const asFailure = (failure: HttpFailure): SourceFailure => ({
	message: failure.message,
	retryable: failure.retryable,
	...(failure.status === undefined ? {} : { status: failure.status }),
	conflict: failure.status === 409 || failure.status === 412
});

const text = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : undefined;

/**
 * The greatest value of one field across records — the `updated_at` watermark. Numbers compare as
 * numbers, not as their decimal text (lexically `"98" > "371"`).
 */
const watermark = (records: ReadonlyArray<unknown>, field: string, floor: string | undefined): string | undefined => {
	let highest: string | number | undefined = floor;
	for (const record of records) {
		const value = walk(record, field);
		if (typeof value !== 'string' && typeof value !== 'number') continue;
		const greater =
			highest === undefined ||
			(typeof value === 'number' && !Number.isNaN(Number(highest))
				? value > Number(highest)
				: String(value) > String(highest));
		if (greater) highest = value;
	}
	return highest === undefined ? undefined : String(highest);
};

type RequestSpec = HttpRecordsSpec<unknown>['list'];

/** An HTTP source over one resolved connection, asking the host to perform every request. */
export const httpSource = (
	connector: ConnectorInterface,
	resolve: (effectId: EffectId) => Effect.Effect<ResolvedConnection, { readonly message: string }>,
	spec: HttpRecordsSpec<unknown> & { readonly connection: HttpConnection }
): SourceAdapter => {
	const connection = (effectId: EffectId) =>
		resolve(effectId).pipe(Effect.mapError((error): SourceFailure => ({ message: error.message, retryable: false })));

	const request = (
		effectId: EffectId,
		method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
		url: string,
		headers: Readonly<Record<string, string>>,
		body: unknown,
		retry: RequestSpec['retry']
	): Effect.Effect<Fetched, SourceFailure> =>
		performRequest(
			connector,
			effectId,
			{ method, url, headers, ...(body === undefined ? {} : { body: body as Schema.Json }) },
			retry
		).pipe(Effect.mapError(asFailure));

	const readPage = (
		effectId: EffectId,
		declared: RequestSpec,
		state: PageState,
		extra: Readonly<{ query?: Readonly<Record<string, string>>; headers?: Readonly<Record<string, string>> }>
	) =>
		Effect.gen(function* () {
			const resolved = yield* connection(effectId);
			let url: string;
			if (state.url !== undefined) url = state.url;
			else {
				const built = connectionUrl(resolved, declared.path);
				for (const [key, value] of Object.entries({ ...declared.query, ...extra.query }))
					built.searchParams.set(key, value);
				const paging: PageSpec | undefined = declared.page;
				if (paging !== undefined) {
					if ('pageQuery' in paging) {
						built.searchParams.set(paging.pageQuery, String((paging.firstPage ?? 1) + state.index));
						if (paging.sizeQuery !== undefined && paging.size !== undefined)
							built.searchParams.set(paging.sizeQuery, String(paging.size));
					} else if ('offsetQuery' in paging) {
						built.searchParams.set(paging.offsetQuery, String(state.index * paging.size));
						built.searchParams.set(paging.limitQuery, String(paging.size));
					} else if ('query' in paging && state.token !== undefined)
						built.searchParams.set(paging.query, state.token);
				}
				url = built.toString();
			}
			const response = yield* request(
				effectId,
				declared.method ?? 'GET',
				url,
				{ ...resolved.headers, ...declared.headers, ...extra.headers },
				declared.body,
				declared.retry
			);
			const found = walk(response.body, declared.records);
			const records = Array.isArray(found) ? found : [];
			const paging = declared.page;
			const max = paging?.max ?? DEFAULT_MAX_PAGES;
			let next: PageState | undefined;
			if (paging !== undefined && state.index + 1 < max && records.length > 0) {
				if ('linkHeader' in paging) {
					const link = nextLink(response.headers['link']);
					if (link !== undefined) next = { index: state.index + 1, url: link };
				} else if ('query' in paging) {
					const token =
						typeof paging.next === 'string'
							? text(walk(response.body, paging.next))
							: response.headers[paging.next.header.toLowerCase()];
					if (token !== undefined && token !== '') next = { index: state.index + 1, token };
				} else {
					const size = 'offsetQuery' in paging ? paging.size : paging.size;
					if (size === undefined || records.length >= size) next = { index: state.index + 1 };
				}
			}
			return { response, records, next };
		});

	const recordPath = (path: string, identity: string): string =>
		path.replaceAll(':id', encodeURIComponent(identity));

	const write = (
		effectId: EffectId,
		declared: NonNullable<HttpRecordsSpec<unknown>['create']>,
		method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
		identity: string | undefined,
		body: unknown,
		headers: Readonly<Record<string, string>>
	) =>
		Effect.gen(function* () {
			const resolved = yield* connection(effectId);
			const url = connectionUrl(resolved, identity === undefined ? declared.path : recordPath(declared.path, identity));
			return yield* request(effectId, declared.method ?? method, url.toString(), { ...resolved.headers, ...declared.headers, ...headers }, body, declared.retry);
		});

	/**
	 * A write to a record the source has changed since the last sync is a conflict, not an
	 * overwrite. `If-Match` says so to a source that honours it; one that ignores it would take the
	 * write silently, so when the source can read one record, its version is checked first.
	 */
	const unchangedSince = (effectId: EffectId, identity: string, ifVersion: string | null): Effect.Effect<void, SourceFailure> =>
		spec.get === undefined || spec.version === undefined || ifVersion === null
			? Effect.void
			: Effect.gen(function* () {
					const resolved = yield* connection(effectId);
					const url = connectionUrl(resolved, recordPath(spec.get!.path, identity));
					const current = yield* request(EffectId.make(`${effectId}:check`), 'GET', url.toString(), resolved.headers, undefined, undefined).pipe(
						Effect.map(({ body }) => body as unknown),
						Effect.catch((failure) => (failure.status === 404 ? Effect.succeed(undefined) : Effect.fail(failure)))
					);
					const version = current === undefined ? undefined : text(walk(current, spec.version!));
					if (version !== undefined && version !== ifVersion)
						return yield* Effect.fail<SourceFailure>({
							message: `the source changed ${identity} since the last sync`,
							retryable: false,
							status: 412,
							conflict: true
						});
				})

	return {
		list: (effectId, page) =>
			Effect.map(readPage(effectId, spec.list, pageState(page), {}), ({ records, next }) => ({
				records,
				...(next === undefined ? {} : { next: JSON.stringify(next) })
			})),
		...(spec.changes === undefined
			? {}
			: {
					changes: (effectId: EffectId, cursor: string | null, page: string | undefined) =>
						Effect.gen(function* () {
							const changes = spec.changes!;
							const state = pageState(page);
							const send = changes.cursor.send;
							const extra =
								cursor === null
									? {}
									: 'query' in send
										? { query: { [send.query]: cursor } }
										: { headers: { [send.header]: cursor } };
							const { response, records, next } = yield* readPage(effectId, changes, state, extra);
							const found = changes.cursor.next;
							const mark =
								'maxOf' in found ? watermark(records, found.maxOf, state.watermark) : undefined;
							const nextCursor =
								'header' in found
									? response.headers[found.header.toLowerCase()]
									: 'field' in found
										? text(walk(response.body, found.field))
										: mark;
							return {
								records,
								...(next === undefined
									? { ...(nextCursor === undefined || nextCursor === '' ? {} : { cursor: nextCursor }) }
									: { next: JSON.stringify({ ...next, ...(mark === undefined ? {} : { watermark: mark }) }) })
							};
						})
				}),
		...(spec.get === undefined
			? {}
			: {
					get: (effectId: EffectId, identity: string) =>
						Effect.gen(function* () {
							const resolved = yield* connection(effectId);
							const url = connectionUrl(resolved, recordPath(spec.get!.path, identity));
							return yield* request(effectId, 'GET', url.toString(), resolved.headers, undefined, undefined).pipe(
								Effect.map(({ body }) => body as unknown),
								Effect.catch((failure) =>
									failure.status === 404 ? Effect.succeed(undefined) : Effect.fail(failure)
								)
							);
						})
				}),
		...(spec.create === undefined
			? {}
			: {
					create: (effectId: EffectId, body: Readonly<Record<string, unknown>>, key: string) => {
						const idempotency = spec.idempotencyKey;
						const headers = idempotency !== undefined && 'header' in idempotency ? { [idempotency.header]: key } : {};
						const payload = idempotency !== undefined && 'field' in idempotency ? { ...body, [idempotency.field]: key } : body;
						return Effect.map(write(effectId, spec.create!, 'POST', undefined, payload, headers), ({ body }) => body as unknown);
					}
				}),
		...(spec.update === undefined
			? {}
			: {
					update: (effectId: EffectId, identity: string, body: Readonly<Record<string, unknown>>, ifVersion: string | null) =>
						unchangedSince(effectId, identity, ifVersion).pipe(
							Effect.andThen(
								write(effectId, spec.update!, 'PATCH', identity, body, spec.version !== undefined && ifVersion !== null ? { 'if-match': ifVersion } : {})
							),
							Effect.map(({ body }) => body as unknown)
						)
				}),
		...(spec.delete === undefined
			? {}
			: {
					delete: (effectId: EffectId, identity: string, ifVersion: string | null) =>
						unchangedSince(effectId, identity, ifVersion).pipe(
							Effect.andThen(
								write(effectId, spec.delete!, 'DELETE', identity, undefined, spec.version !== undefined && ifVersion !== null ? { 'if-match': ifVersion } : {})
							),
							Effect.as('deleted' as const),
							Effect.catch((failure) => (failure.status === 404 || failure.status === 410 ? Effect.succeed('missing' as const) : Effect.fail(failure)))
						)
				})
	};
};

/** Why a page read of one request failed, for the sync's `failed` state. */
export const describeSourceFailure = (failure: SourceFailure): string =>
	failure.status === undefined ? failure.message : `${failure.message} (${failure.status})`;

export const SOURCE_EFFECT = (effectId: EffectId, label: string): EffectId => EffectId.make(`${effectId}:${label}`);
