import { Effect, Result, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import type { AuthoredIntegrationBinding } from '#lib/authoring/integration-introspection.js';
import type {
	HttpConnection,
	IntegrationDeclaration,
	IntegrationPullDeclaration
} from '#lib/authoring/workspace-schema.js';
import { absorbRecords, type AbsorbDependencies } from '#lib/runtime/integrations/absorb.js';
import { isNumber, isObjectLike, isRecord as isObject, isString } from '#lib/schema-decode.js';
import {
	IntegrationHttpRequest,
	isRetryableStatus,
	nextLink,
	retryDelayMs
} from '#lib/runtime/integrations/http.js';

/**
 * One binding's run, from request to rows.
 *
 * Split out of the service so the loop reads as the sequence it is — plan a request, ask the host to
 * perform it, select the records, decode each one, write the rows, advance the cursor — rather than
 * as five nested `Effect.gen`s inside a `Layer.effect`.
 */

/** What one run of one binding did. Returned to the caller and recorded in the cursor row. */
export type BindingReport = Readonly<{
	readonly binding: string;
	readonly pages: number;
	readonly fetched: number;
	readonly created: number;
	readonly updated: number;
	readonly rejected: ReadonlyArray<{ readonly index: number; readonly reason: string }>;
	readonly cursor: string | null;
}>;

const MAX_PAGES_DEFAULT = 50;
const REJECTIONS_REPORTED = 20;

/** The read side of a response, narrowed to what the paging and cursor rules actually consult. */
type Fetched = Readonly<{
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Schema.Json;
}>;

export type PullDependencies = AbsorbDependencies &
	Readonly<{
		/** Performs one planned request through the host's connector facility. */
		readonly request: (
			effectId: EffectId,
			connector: string,
			descriptor: Schema.Schema.Type<typeof IntegrationHttpRequest>
		) => Effect.Effect<Fetched, { readonly message: string; readonly retryable: boolean }>;
		/** Reads a declared secret, or fails naming the variable that has no value. */
		readonly secret: (
			effectId: EffectId,
			name: string
		) => Effect.Effect<string, { readonly message: string }>;
		readonly sleep: (milliseconds: number) => Effect.Effect<void>;
		readonly now: Effect.Effect<number>;
	}>;

/**
 * Walks a body down a path of object keys, stopping at the first step that is not an object.
 *
 * One walker rather than two, because the records and the next-cursor are found the same way and
 * only differ in what they expect at the bottom. They did differ once: the cursor read was
 * top-level-only, so an enveloped `next-cursor` came back `undefined` and the paging loop treated a
 * source with more pages as a source with one. Webhook deliveries walk their bodies the same way
 * and import this one — a second copy is how the two paths forget each other again.
 */
export const walk = (body: Schema.Json, path: ReadonlyArray<string>): unknown => {
	let cursor: unknown = body;
	for (const step of path) {
		if (!isObject(cursor)) return undefined;
		cursor = Reflect.get(cursor, step);
	}
	return cursor;
};

/** Where the records live, as a path — `undefined` means the body itself is the array. */
const recordsPath = (records: IntegrationPullDeclaration['records']): ReadonlyArray<string> =>
	records === undefined ? [] : 'field' in records ? [records.field] : records.path;

const selectRecords = (
	body: Schema.Json,
	records: IntegrationPullDeclaration['records']
): ReadonlyArray<unknown> => {
	const found = walk(body, recordsPath(records));
	return Array.isArray(found) ? found : [];
};

/** Reads a next-cursor out of a body, at whatever depth the source buried it. */
const bodyValue = (
	body: Schema.Json,
	next: { readonly field: string } | { readonly path: ReadonlyArray<string> }
): string | undefined => {
	const value = walk(body, 'field' in next ? [next.field] : next.path);
	return isString(value) && value !== '' ? value : isNumber(value) ? String(value) : undefined;
};

/**
 * The greatest value of one field across the records just read — the `updated_at` watermark.
 *
 * Numbers are compared as numbers, not as their decimal text. That is a correctness fix rather than
 * a refinement: a numeric id cursor is a real and common shape — GitHub's `?since=` is exactly one —
 * and lexicographically `"98" > "371"`, so a run that had genuinely read up to id 371 persisted a
 * watermark of 98 and the run after it re-read 73 records it already held. Nothing failed; the
 * mirror just quietly stopped making progress at the rate it appeared to. ISO-8601 timestamps, the
 * case this was written for, order identically under either comparison.
 */
const watermark = (records: ReadonlyArray<unknown>, field: string): string | undefined => {
	let highest: string | number | undefined;
	for (const record of records) {
		if (!isObjectLike(record)) continue;
		const value: unknown = Reflect.get(record, field);
		if (!isString(value) && !isNumber(value)) continue;
		const greater =
			highest === undefined ||
			(isNumber(value) && isNumber(highest) ? value > highest : String(value) > String(highest));
		if (greater) highest = value;
	}
	return highest === undefined ? undefined : String(highest);
};

const describe = (cause: unknown): string =>
	cause instanceof Error && cause.message !== '' ? cause.message : String(cause);

/**
 * Asks the host to perform one request, retrying the answers that are worth asking again.
 *
 * A retry costs the source a request, so the policy is deliberately narrow: a transport failure the
 * facility marked retryable, or a 429/5xx. Everything else — a 401, a 404, a 422 — comes straight
 * back, because repeating it changes nothing and a wrong credential should surface as a wrong
 * credential rather than four minutes of backoff.
 */
const fetchWithRetry = (
	dependencies: PullDependencies,
	effectId: EffectId,
	connector: string,
	descriptor: Schema.Schema.Type<typeof IntegrationHttpRequest>,
	retry: IntegrationPullDeclaration['retry']
): Effect.Effect<Fetched, { readonly message: string }> =>
	Effect.gen(function* () {
		const attempts = Math.max(retry?.attempts ?? 1, 1);
		const backoff = {
			initialDelayMs: retry?.initialDelayMs ?? 250,
			maxDelayMs: retry?.maxDelayMs ?? 30_000
		};
		let last = `${descriptor.method} ${descriptor.url} was never attempted`;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const outcome = yield* Effect.result(dependencies.request(effectId, connector, descriptor));
			const retryable = Result.isFailure(outcome)
				? outcome.failure.retryable
				: isRetryableStatus(outcome.success.status);
			if (Result.isSuccess(outcome) && outcome.success.status < 400) return outcome.success;
			last = Result.isFailure(outcome)
				? outcome.failure.message
				: `${descriptor.method} ${descriptor.url} answered ${outcome.success.status}`;
			if (!retryable || attempt + 1 === attempts) return yield* Effect.fail({ message: last });
			// `Retry-After` belongs to the response that just arrived, so it is read here rather than at
			// the top of the next turn — the source is the only party that knows when it will be ready.
			const after = Result.isSuccess(outcome) ? outcome.success.headers['retry-after'] : undefined;
			yield* dependencies.sleep(retryDelayMs(attempt, backoff, after, yield* dependencies.now));
		}
		return yield* Effect.fail({ message: last });
	});

/** Builds the request URL for one page: declared query, plus whatever the cursor and paging add. */
const pageUrl = (
	connection: HttpConnection,
	binding: IntegrationPullDeclaration,
	cursor: string | null,
	page: {
		readonly index: number;
		readonly absoluteUrl: string | undefined;
		readonly token: string | undefined;
	}
): string => {
	if (page.absoluteUrl !== undefined) return page.absoluteUrl;
	const url = new URL(
		`${connection.baseUrl}${binding.path.startsWith('/') ? '' : '/'}${binding.path}`
	);
	for (const [key, value] of Object.entries(binding.query ?? {})) url.searchParams.set(key, value);
	const cursorQuery =
		binding.cursor === undefined ? undefined : Reflect.get(binding.cursor.send, 'query');
	if (cursor !== null && isString(cursorQuery)) {
		url.searchParams.set(cursorQuery, cursor);
	}
	const pages = binding.pages;
	if (pages !== undefined) {
		if (pages.style === 'page') {
			url.searchParams.set(pages.pageQuery, String((pages.firstPage ?? 1) + page.index));
			if (pages.sizeQuery !== undefined && pages.size !== undefined)
				url.searchParams.set(pages.sizeQuery, String(pages.size));
		}
		if (pages.style === 'offset') {
			url.searchParams.set(pages.offsetQuery, String(page.index * pages.size));
			url.searchParams.set(pages.limitQuery, String(pages.size));
		}
		if (pages.style === 'cursor' && page.token !== undefined)
			url.searchParams.set(pages.query, page.token);
	}
	return url.toString();
};

/**
 * Resolves the connection's credential reference into the header it becomes.
 *
 * Exported and typed on the one dependency it uses rather than on `PullDependencies`, because the
 * outbound path presents the same credential to the same connection and there must not be a second
 * function that decides what `{ type: 'bearer', token: { env } }` means. A second one is how a
 * header-authenticated connection ends up working for a pull and not for a send.
 */
export const authenticationHeaders = (
	secret: (effectId: EffectId, name: string) => Effect.Effect<string, { readonly message: string }>,
	effectId: EffectId,
	connection: HttpConnection
): Effect.Effect<Readonly<Record<string, string>>, { readonly message: string }> =>
	Effect.gen(function* () {
		const authentication = connection.authentication;
		if (authentication === undefined) return {};
		if (authentication.type === 'bearer') {
			const token = yield* secret(effectId, authentication.token.env);
			return { authorization: `Bearer ${token}` };
		}
		const value = yield* secret(effectId, authentication.value.env);
		return { [authentication.header]: value };
	});

/** What the next page should ask for, and whether there is one. */
const advance = (
	pageSpec: NonNullable<IntegrationPullDeclaration['pages']>,
	response: Fetched,
	rawLength: number
): Readonly<{ pageToken?: string; absoluteUrl?: string; stop: boolean }> => {
	// It is checked first because it is the only one that decides nothing: one complete page is a
	// complete state, and a source with one answer is not a source with one page.
	if (pageSpec.style === 'cursor') {
		const token =
			'header' in pageSpec.next
				? response.headers[pageSpec.next.header.toLowerCase()]
				: bodyValue(response.body, pageSpec.next);
		if (token === undefined || token === '') return { stop: true };
		return { pageToken: token, stop: false };
	}
	if (pageSpec.style === 'link-header') {
		const absoluteUrl = nextLink(response.headers['link']);
		if (absoluteUrl === undefined) return { stop: true };
		return { absoluteUrl, stop: false };
	}
	if (pageSpec.size !== undefined && rawLength < pageSpec.size) return { stop: true };
	return { stop: false };
};

/**
 * What the declaration says the next cursor is, read from one page's response.
 *
 * Owned beside `advance` because they are the two reads of one response — the paging rule and the
 * cursor rule — and a drift between them is how a multi-page source becomes a one-page source.
 */
const nextCursorFrom = (
	cursorSpec: NonNullable<IntegrationPullDeclaration['cursor']>,
	response: Fetched,
	records: ReadonlyArray<unknown>
): string | undefined => {
	const next =
		'header' in cursorSpec.next
			? response.headers[cursorSpec.next.header.toLowerCase()]
			: 'maxOf' in cursorSpec.next
				? watermark(records, cursorSpec.next.maxOf)
				: bodyValue(response.body, cursorSpec.next);
	return next === undefined || next === '' ? undefined : next;
};

/**
 * Runs one binding to completion.
 *
 * Pages are written as they arrive rather than accumulated and written at the end: a run that dies
 * on page nine has still landed pages one to eight, and because every write is keyed by the
 * external identity, the re-run that follows updates those rows instead of duplicating them. That
 * is the same property that makes the whole thing safe to run twice, applied to the inside of a
 * single run.
 */
export const runPullBinding = (
	dependencies: PullDependencies,
	effectId: EffectId,
	integration: IntegrationDeclaration,
	binding: IntegrationPullDeclaration,
	authored: AuthoredIntegrationBinding,
	storedCursor: string | null
): Effect.Effect<BindingReport, { readonly message: string }> =>
	Effect.gen(function* () {
		// `connection` is optional on the declaration because a webhook-only integration has nowhere to
		// send anything. A pull does, and `describeIntegrations` refuses to emit one without a
		// connection — so this refusal is the unreachable half of a guarantee made at compile time,
		// stated rather than asserted away.
		const connection = integration.connection;
		if (connection === undefined) {
			return yield* Effect.fail({
				message: `${integration.name}.${binding.name} is a pull with no connection: there is no baseUrl to request against.`
			});
		}
		const headers = {
			...(binding.headers ?? {}),
			...(yield* authenticationHeaders(dependencies.secret, effectId, connection))
		};
		const maxPages =
			binding.pages === undefined ? 1 : Math.max(binding.pages.max ?? MAX_PAGES_DEFAULT, 1);
		const rejected: Array<{ readonly index: number; readonly reason: string }> = [];
		let fetched = 0;
		let created = 0;
		let updated = 0;
		let pages = 0;
		let nextCursor: string | null = storedCursor;
		let pageToken: string | undefined;
		let absoluteUrl: string | undefined;
		for (let index = 0; index < maxPages; index += 1) {
			const url = pageUrl(connection, binding, storedCursor, {
				index,
				absoluteUrl,
				token: pageToken
			});
			const response = yield* fetchWithRetry(
				dependencies,
				effectId,
				integration.name,
				{ method: binding.method, url, headers },
				binding.retry
			);
			pages += 1;
			const raw = selectRecords(response.body, binding.records);
			fetched += raw.length;

			const absorbed = yield* absorbRecords(
				dependencies,
				effectId,
				{
					integration: integration.name,
					binding: binding.name,
					collection: integration.collection,
					identityColumn: binding.identityColumn
				},
				authored,
				raw,
				fetched - raw.length,
				Math.max(REJECTIONS_REPORTED - rejected.length, 0)
			);
			created += absorbed.created;
			updated += absorbed.updated;
			rejected.push(...absorbed.rejected);

			// The cursor advances from what this page said, so a run that stops early still resumes from
			// the last page it actually read rather than from the last page it asked for.
			if (binding.cursor !== undefined) {
				const next = nextCursorFrom(binding.cursor, response, absorbed.decoded);
				if (next !== undefined) nextCursor = next;
			}

			const pageSpec = binding.pages;
			if (pageSpec === undefined) break;
			if (raw.length === 0) break;
			const next = advance(pageSpec, response, raw.length);
			if (next.stop) break;
			if (next.pageToken !== undefined) pageToken = next.pageToken;
			if (next.absoluteUrl !== undefined) absoluteUrl = next.absoluteUrl;
		}
		return {
			binding: binding.name,
			pages,
			fetched,
			created,
			updated,
			rejected,
			cursor: nextCursor
		};
	});
