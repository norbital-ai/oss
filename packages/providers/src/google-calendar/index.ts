// Calendar feeds keep snapshot/sync cursors and sealed watch identities across renewals. Writes are the driver's `call`:
// an http-shaped op on one calendar's events through this standing link, answered `{ status, body }` for the definition's
// outbound run to read (a 412 its conflict). A sign-in sealed before it could write keeps importing and says to reconnect.
import { Clock, Effect, Option, Schema, Predicate, Semaphore } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';
import { Instant, PlainDate } from '@norbital-ai/std/date';
import type { CalendarEvent } from '@norbital-ai/bolt';
import {
	OAUTH_CALLBACK,
	type DriverOpen,
	type DriverPage,
	type Json,
	type LinkStatus
} from '@norbital-ai/bolt/engine';
import type { ProviderDef } from '../abi.ts';
import { answerFailure, LinkClosed, PairingInvalid, ProviderUnavailable } from '../errors.ts';
import {
	attempt,
	authorizeUrl,
	callbackCompletion,
	grant,
	revoke,
	STATE_MS,
	tokenHolder,
	Tokens,
	type OAuthApp
} from '../oauth.ts';
import { hostCall, same, str, withFetch, type Obj } from '../util.ts';

const API = 'https://www.googleapis.com/calendar/v3';
const READ = 'https://www.googleapis.com/auth/calendar.readonly',
	WRITE = 'https://www.googleapis.com/auth/calendar.events';
const SCOPES = [READ, WRITE];
const RECONSENT =
	'Reconnect this calendar to let Norbital update its events; until then it only imports them.';
const Watch = Schema.Struct({
	id: Schema.NonEmptyString,
	token: Schema.NonEmptyString,
	calendar: Schema.NonEmptyString,
	resource: Schema.NullOr(Schema.NonEmptyString),
	expiration: Schema.Number,
	phase: Schema.Literals(['pending', 'active', 'stopping']),
	reconcile: Schema.optionalKey(Schema.Boolean)
});
type Watch = Schema.Schema.Type<typeof Watch>;
const State = Schema.Struct({
	watches: Schema.Array(Watch),
	account: Schema.optionalKey(Schema.String)
});
type State = Schema.Schema.Type<typeof State>;
const Events = Schema.Struct({
	items: Schema.optionalKey(Schema.Array(Schema.JsonObject)),
	nextPageToken: Schema.optionalKey(Schema.NonEmptyString),
	nextSyncToken: Schema.optionalKey(Schema.NonEmptyString)
});
const Calendars = Schema.Struct({
	items: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				id: Schema.NonEmptyString,
				summary: Schema.String,
				primary: Schema.optionalKey(Schema.Boolean)
			})
		)
	),
	nextPageToken: Schema.optionalKey(Schema.NonEmptyString)
});
const Registered = Schema.Struct({
	id: Schema.NonEmptyString,
	resourceId: Schema.NonEmptyString,
	expiration: Schema.NonEmptyString
});
/** Where a feed partition's read is: mid-pagination (`page`, with `sync` for an incremental read) or at rest (`sync`). */
const Cursor = Schema.Struct({
	sync: Schema.optionalKey(Schema.String),
	page: Schema.optionalKey(Schema.String)
});
type ApiCall = {
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	path: string;
	query?: { readonly [k: string]: string };
	headers?: { readonly [k: string]: string };
	body?: Json;
};
const Scalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
/** What `ctx.request` hands a calendar: an http op on one calendar's events (insert, get, patch, delete). */
const CallOp = Schema.Struct({
	method: Schema.Literals(['GET', 'POST', 'PATCH', 'DELETE']),
	// encoded segments only, never a dot segment: the path stays on one calendar's events
	path: Schema.String.check(
		Schema.isPattern(/^\/calendars\/[^/?#.][^/?#]*\/events(\/[^/?#.][^/?#]*)?$/)
	),
	query: Schema.optionalKey(Schema.Record(Schema.String, Scalar)),
	headers: Schema.optionalKey(Schema.Struct({ 'if-match': Schema.optionalKey(Schema.String) })),
	body: Schema.optionalKey(Schema.Json)
});

export function googleCalendar(): ProviderDef {
	return {
		_tag: 'ProviderDef',
		driver: 'calendar',
		personal: true,
		id: 'google',
		name: 'Google Calendar',
		icon: 'logos:google-calendar',
		label: { en: 'Google Calendar (sign in with Google)', zh: 'Google 日历（使用 Google 登录）' },
		description: { en: 'Sync events from your calendars', zh: '同步日历中的日程' },
		setup: { kind: 'oauth', steps: [] },
		oauth: 'google',
		open
	};
}

const open = Effect.fn('GoogleCalendar.open')(function* (ctx: DriverOpen) {
	const oauth = ctx.definition.oauth;
	const app: OAuthApp = {
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		revokeUrl: 'https://oauth2.googleapis.com/revoke',
		scopes: oauth?.scopes ?? SCOPES,
		params: { access_type: 'offline', prompt: 'consent' }
	};
	const client = () =>
		Effect.suspend(() => {
			const configured = ctx.oauthClient('google');
			return configured === undefined
				? Effect.fail(
						new ProviderUnavailable({ message: 'this host has no Google sign-in configured' })
					)
				: Effect.succeed(configured);
		});
	const stored = yield* hostCall('read calendar credentials', () => ctx.credentials.load());
	const decodedToken = Option.getOrNull(Schema.decodeUnknownOption(Tokens)(stored.get('token')));
	// a sign-in sealed before its scopes were recorded asked only to read
	let tokens =
		decodedToken === null || decodedToken.scope !== undefined
			? decodedToken
			: { ...decodedToken, scope: READ };
	const writable = () => tokens?.scope?.split(' ').includes(WRITE) === true;
	const connected = (): LinkStatus => ({
		state: 'connected',
		account: state.account ?? null,
		...(writable() ? {} : { detail: RECONSENT })
	});
	let state: State = stored.has('state')
		? yield* Schema.decodeUnknownEffect(State)(stored.get('state')).pipe(
				Effect.mapError(
					() => new ProviderUnavailable({ message: 'Calendar stored watches are malformed' })
				)
			)
		: { watches: [] };
	let pending: { state: string; verifier: string; at: number; returnTo: string | null } | null =
		null;
	const completion = yield* callbackCompletion;
	let closed = false;
	const writes = yield* Semaphore.make(1);
	const holder = yield* tokenHolder(app, client, tokens, (next) =>
		hostCall('store refreshed calendar token', () =>
			ctx.credentials.write(new Map([['token', next]]))
		).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					tokens = next;
				})
			)
		)
	);
	const feeds = Object.entries(ctx.definition.feeds ?? {}).filter(
		([, feed]) => feed.from === 'driver'
	);
	const calendars = (): string[] => {
		const configuration = Predicate.isObject(ctx.configuration) ? ctx.configuration : {};
		return [
			...new Set(
				feeds.flatMap(([, feed]) => {
					if (feed.partitions === undefined) return ['primary'];
					const partitions = configuration[feed.partitions];
					return Array.isArray(partitions)
						? partitions.filter(
								(value): value is string => typeof value === 'string' && value !== ''
							)
						: [];
				})
			)
		];
	};
	const save = (watches: readonly Watch[]) =>
		writes.withPermit(
			Effect.gen(function* () {
				const next: State = { ...state, watches };
				yield* hostCall('store calendar watches', () =>
					ctx.credentials.write(new Map([['state', next]]))
				);
				state = next;
			})
		);
	const access = () =>
		withFetch(ctx, holder.get()).pipe(
			Effect.map((value) => value.access),
			Effect.tapError((error) =>
				error._tag === 'OAuthRefused' && error.revoked
					? hostCall('report calendar sign-in', () =>
							ctx.status({
								state: 'error',
								code: 'loggedOut',
								error: `Google refused the sign-in (${error.message}). Sign in again.`
							})
						)
					: Effect.void
			)
		);
	const call = Effect.fn('GoogleCalendar.request')(function* (request: ApiCall, token?: string) {
		if (closed || ctx.signal.aborted)
			return yield* Effect.fail(new LinkClosed({ message: 'Google Calendar link is closed' }));
		const bearer = token ?? (yield* access());
		const http = HttpClientRequest.make(request.method)(`${API}${request.path}`, {
			headers: { ...request.headers, authorization: `Bearer ${bearer}` },
			urlParams: request.query
		});
		const response = yield* withFetch(
			ctx,
			HttpClient.execute(
				request.body === undefined
					? http
					: http.pipe(HttpClientRequest.bodyJsonUnsafe(request.body))
			)
		).pipe(
			Effect.mapError(
				() => new ProviderUnavailable({ message: 'Google Calendar operation failed' })
			)
		);
		const body =
			response.status === 204
				? null
				: yield* HttpClientResponse.schemaBodyJson(Schema.Json)(response).pipe(
						Effect.catch(() =>
							response.status >= 200 && response.status < 300
								? Effect.fail(
										new ProviderUnavailable({ message: 'Google Calendar response is not JSON' })
									)
								: Effect.succeed(null)
						)
					);
		return { status: response.status, body };
	});
	const ok = (status: number) =>
		status >= 200 && status < 300
			? Effect.void
			: Effect.fail(answerFailure(`Google Calendar answered ${status}`, status));
	const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError(
				() => new ProviderUnavailable({ message: 'Google Calendar response failed validation' })
			)
		);
	const list = Effect.fn('GoogleCalendar.discover')(function* (token?: string) {
		const result: { id: string; label: string; primary: boolean }[] = [];
		for (let page: string | undefined, n = 0; n < 20; n++) {
			const response = yield* call(
				{
					method: 'GET',
					path: '/users/me/calendarList',
					query: {
						maxResults: '100',
						showHidden: 'true',
						...(page === undefined ? {} : { pageToken: page })
					}
				},
				token
			);
			yield* ok(response.status);
			const calendars = yield* decode(Calendars, response.body);
			result.push(
				...(calendars.items ?? []).map((value) => ({
					id: value.id,
					label: value.summary,
					primary: value.primary === true
				}))
			);
			page = calendars.nextPageToken;
			if (page === undefined) break;
		}
		return result;
	});
	const request = Effect.fn('GoogleCalendar.call')(function* (op: Json) {
		const decoded = Schema.decodeUnknownOption(CallOp)(op, { onExcessProperty: 'error' });
		if (Option.isNone(decoded))
			return {
				status: 400,
				body: 'A calendar call is { method, path: /calendars/<id>/events[/<event>], query?, headers?: { if-match }, body? }.'
			};
		const { method, path, query, headers, body } = decoded.value;
		if (method !== 'GET' && !writable()) return { status: 403, body: RECONSENT };
		return yield* call({
			method,
			path,
			...(query === undefined
				? {}
				: { query: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) }),
			...(headers?.['if-match'] === undefined
				? {}
				: { headers: { 'if-match': headers['if-match'] } }),
			...(body === undefined ? {} : { body })
		});
	});
	const read = Effect.fn('GoogleCalendar.read')(function* (
		_feed: string,
		partition: string,
		cursor: Json | null
	): Effect.fn.Return<DriverPage, import('../errors.ts').ProviderFailure> {
		const at = yield* decode(Cursor, cursor ?? {});
		const calendar = partition === '' ? 'primary' : partition;
		const response = yield* call({
			method: 'GET',
			path: `/calendars/${encodeURIComponent(calendar)}/events`,
			query: {
				maxResults: '250',
				showDeleted: 'true',
				showHiddenInvitations: 'true',
				singleEvents: 'true',
				...(at.sync === undefined ? {} : { syncToken: at.sync }),
				...(at.page === undefined ? {} : { pageToken: at.page })
			}
		});
		if (response.status === 410) return { items: [], cursor: null, more: false, retained: false };
		yield* ok(response.status);
		const page = yield* decode(Events, response.body);
		if ((page.nextPageToken === undefined) === (page.nextSyncToken === undefined))
			return yield* Effect.fail(
				new ProviderUnavailable({
					message: 'Calendar supplied no distinct pagination or synchronization token'
				})
			);
		const items: Json[] = [];
		for (const event of page.items ?? []) {
			const item = yield* Effect.try({
				try: () => calendarEvent(event),
				catch: () => new ProviderUnavailable({ message: 'Calendar event has no start or end' })
			});
			if (item === null)
				return yield* Effect.fail(
					new ProviderUnavailable({ message: 'Calendar event has no identity' })
				);
			items.push(
				yield* Schema.decodeUnknownEffect(Schema.Json)(item).pipe(
					Effect.mapError(
						() => new ProviderUnavailable({ message: 'Calendar event failed wire validation' })
					)
				)
			);
		}
		if (page.nextPageToken !== undefined)
			return {
				items,
				cursor: { ...(at.sync === undefined ? {} : { sync: at.sync }), page: page.nextPageToken },
				more: true
			};
		if (page.nextSyncToken === undefined)
			return yield* Effect.fail(
				new ProviderUnavailable({ message: 'Calendar supplied no synchronization token' })
			);
		return {
			items,
			cursor: { sync: page.nextSyncToken },
			more: false,
			...(at.sync === undefined ? { snapshot: 'end' } : {})
		};
	});
	const invalidate = (calendar: string) =>
		Effect.forEach(
			feeds,
			([feed, definition]) =>
				hostCall('queue calendar feed', () =>
					ctx.emit({
						kind: 'invalidate',
						feed,
						partition: definition.partitions === undefined ? '' : calendar
					})
				),
			{ concurrency: 1 }
		).pipe(Effect.asVoid);
	const stop = Effect.fn('GoogleCalendar.stopWatch')(function* (watch: Watch) {
		if (watch.resource === null) return;
		yield* save(
			state.watches.map((value) =>
				value.id === watch.id ? { ...value, phase: 'stopping' } : value
			)
		);
		const response = yield* call({
			method: 'POST',
			path: '/channels/stop',
			body: { id: watch.id, resourceId: watch.resource }
		});
		if (response.status !== 404 && response.status !== 410) yield* ok(response.status);
		yield* save(state.watches.filter((value) => value.id !== watch.id));
	});
	const reconcile = Effect.fn('GoogleCalendar.reconcileWatch')(function* (watch: Watch) {
		yield* invalidate(watch.calendar);
		yield* save(
			state.watches.map((value) => (value.id === watch.id ? { ...value, reconcile: false } : value))
		);
	});
	const renew = Effect.fn('GoogleCalendar.renew')(function* () {
		const now = yield* Clock.currentTimeMillis;
		if (closed) return null;
		if (tokens === null)
			return pending !== null && now - pending.at <= STATE_MS
				? new Date(now + 15000).toISOString()
				: null;
		const hook = new URL(ctx.webhookUrl),
			wanted = calendars();
		if (
			hook.protocol === 'http:' &&
			(hook.hostname.endsWith('.localhost') ||
				['localhost', '127.0.0.1', '[::1]'].includes(hook.hostname))
		) {
			for (const calendar of wanted) yield* invalidate(calendar);
			return wanted.length === 0 ? null : new Date(now + 300000).toISOString();
		}
		if (hook.protocol !== 'https:')
			return yield* Effect.fail(
				new ProviderUnavailable({ message: 'Calendar notifications require HTTPS' })
			);
		for (const watch of [...state.watches]) {
			if (watch.phase === 'stopping' || !wanted.includes(watch.calendar)) yield* stop(watch);
			else if (watch.reconcile) yield* reconcile(watch);
		}
		yield* save(state.watches.filter((watch) => watch.expiration > now));
		for (const calendar of wanted) {
			if (
				state.watches.some(
					(watch) =>
						watch.calendar === calendar &&
						watch.phase === 'active' &&
						watch.expiration > now + 300000
				)
			)
				continue;
			if (
				state.watches.filter((watch) => watch.calendar === calendar && watch.phase === 'pending')
					.length >= 4
			)
				return yield* Effect.fail(
					new ProviderUnavailable({ message: 'Calendar watch registration needs reconciliation' })
				);
			const watch: Watch = {
				id: ctx.state(),
				token: ctx.state(),
				calendar,
				resource: null,
				expiration: now + 86400000,
				phase: 'pending'
			};
			yield* save([...state.watches, watch]);
			const response = yield* call({
				method: 'POST',
				path: `/calendars/${encodeURIComponent(calendar)}/events/watch`,
				body: {
					id: watch.id,
					token: watch.token,
					type: 'web_hook',
					address: ctx.webhookUrl,
					expiration: String(watch.expiration)
				}
			});
			yield* ok(response.status);
			const registered = yield* decode(Registered, response.body),
				expiration = Number(registered.expiration);
			const found = state.watches.find((value) => value.id === watch.id);
			if (
				registered.id !== watch.id ||
				found === undefined ||
				(found.resource !== null && found.resource !== registered.resourceId) ||
				!Number.isSafeInteger(expiration) ||
				expiration <= (yield* Clock.currentTimeMillis) + 60000
			)
				return yield* Effect.fail(
					new ProviderUnavailable({
						message: 'Calendar watch registration identity or expiration is invalid'
					})
				);
			yield* save(
				state.watches.map((value) =>
					value.id === watch.id
						? {
								...value,
								resource: registered.resourceId,
								expiration,
								phase: 'active',
								reconcile: true
							}
						: value
				)
			);
			yield* reconcile(watch);
		}
		const deadlines = state.watches.map((watch) => Math.max(now + 1000, watch.expiration - 300000));
		return deadlines.length === 0 ? null : new Date(Math.min(...deadlines)).toISOString();
	});
	const notification = Effect.fn('GoogleCalendar.notification')(function* (request: Request) {
		if (closed || request.method !== 'POST') return new Response(null, { status: 405 });
		const now = yield* Clock.currentTimeMillis;
		const id = request.headers.get('x-goog-channel-id'),
			resource = request.headers.get('x-goog-resource-id'),
			number = request.headers.get('x-goog-message-number'),
			kind = request.headers.get('x-goog-resource-state');
		const watch = state.watches.find((value) => value.id === id && value.expiration > now);
		if (
			watch === undefined ||
			watch.phase === 'stopping' ||
			!same(request.headers.get('x-goog-channel-token') ?? '', watch.token) ||
			!resource ||
			!number ||
			!/^[0-9]+$/.test(number) ||
			!['sync', 'exists', 'not_exists'].includes(kind ?? '') ||
			(watch.resource !== null && watch.resource !== resource) ||
			(watch.resource === null && (kind !== 'sync' || number !== '1'))
		)
			return new Response(null, { status: 403 });
		if (watch.resource === null)
			yield* save(
				state.watches.map((value) => (value.id === watch.id ? { ...value, resource } : value))
			);
		yield* invalidate(watch.calendar);
		return new Response(null, { status: 204 });
	});
	const callback = (query: URLSearchParams) =>
		completion.run(
			query.get('state') ?? '',
			() => pending,
			() =>
				new Response('This sign-in is unknown or has expired; start it again.', {
					status: 400
				}),
			(pairing) =>
				Effect.gen(function* () {
					pending = null;
					return yield* Effect.gen(function* () {
						const error = query.get('error');
						if (error !== null)
							return yield* Effect.fail(
								new ProviderUnavailable({ message: `the sign-in was refused (${error})` })
							);
						const granted = yield* withFetch(
							ctx,
							grant(app, yield* client(), {
								grant_type: 'authorization_code',
								code: query.get('code') ?? '',
								redirect_uri: ctx.redirectUrl,
								code_verifier: pairing.verifier
							})
						);
						// a grant that names no scope gave the ones asked for (RFC 6749 §5.1)
						const sealed =
							granted.scope === undefined ? { ...granted, scope: app.scopes.join(' ') } : granted;
						const account = (yield* list(granted.access)).find((calendar) => calendar.primary)?.id;
						const next: State = { watches: [], ...(account === undefined ? {} : { account }) };
						// Host persistence cannot be canceled; finish adoption before disconnect can wipe its keys.
						yield* Effect.gen(function* () {
							yield* hostCall('store calendar pairing', () =>
								ctx.credentials.write(
									new Map<string, Json>([
										['token', sealed],
										['state', next]
									])
								)
							);
							tokens = sealed;
							state = next;
							yield* holder.set(sealed);
							yield* hostCall('report calendar pairing', () => ctx.status(connected()));
							for (const calendar of calendars()) yield* invalidate(calendar);
						}).pipe(Effect.uninterruptible);
						return pairing.returnTo === null
							? new Response('Signed in. You can close this window.', {
									headers: { 'content-type': 'text/plain; charset=utf-8' }
								})
							: Response.redirect(pairing.returnTo, 303);
					}).pipe(
						Effect.catch((error) =>
							hostCall('report calendar pairing', () =>
								ctx.status({
									state: 'error',
									error: `${error.message}. Check the OAuth client and sign in again.`
								})
							).pipe(
								Effect.as(new Response(`Not connected: ${error.message}`, { status: 400 })),
								Effect.uninterruptible
							)
						)
					);
				})
		);
	yield* hostCall('report calendar status', () =>
		ctx.status(tokens === null ? { state: 'unpaired' } : connected())
	);
	return {
		pair: (input: Json) =>
			completion.reset(
				Effect.gen(function* () {
					pending = null;
					const pairing = attempt(ctx.state()),
						account = yield* client();
					const url = authorizeUrl(
						app,
						account.id,
						ctx.redirectUrl,
						pairing.state,
						pairing.challenge
					);
					const path =
						Predicate.isObject(input) && typeof input['returnTo'] === 'string'
							? input['returnTo']
							: null;
					const target =
						path === null
							? null
							: yield* Effect.try({
									try: () => new URL(path, ctx.webhookUrl),
									catch: () => new PairingInvalid({ message: 'The return URL is invalid' })
								});
					pending = {
						state: pairing.state,
						verifier: pairing.verifier,
						at: yield* Clock.currentTimeMillis,
						returnTo: target?.origin === new URL(ctx.webhookUrl).origin ? target.href : null
					};
					yield* Effect.sync(() =>
						ctx.pairing({ kind: 'oauth', value: url, label: 'Sign in with Google' })
					);
					yield* hostCall('report calendar pairing', () => ctx.status({ state: 'pairing' }));
				})
			),
		test: (_input: Json) => list().pipe(Effect.asVoid),
		discover: () =>
			list().pipe(Effect.map((calendars) => calendars.map(({ id, label }) => ({ id, label })))),
		request,
		read,
		renew,
		webhook: (request: Request) =>
			request.method === 'GET' && new URL(request.url).pathname.endsWith(OAUTH_CALLBACK)
				? callback(new URL(request.url).searchParams)
				: notification(request),
		unpair: () =>
			completion.reset(
				Effect.gen(function* () {
					pending = null;
					for (const watch of [...state.watches]) yield* stop(watch);
					const now = yield* Clock.currentTimeMillis;
					if (state.watches.some((watch) => watch.resource === null && watch.expiration > now))
						return yield* Effect.fail(
							new ProviderUnavailable({
								message: 'A pending calendar watch must reconcile or expire before disconnect'
							})
						);
					yield* withFetch(ctx, revoke(app, tokens));
					tokens = null;
					state = { watches: [] };
					yield* holder.set(null);
				})
			),
		close: writes.withPermit(
			Effect.sync(() => {
				closed = true;
			})
		)
	};
});

/** One Google event → the driver's `CalendarEvent`, or `null` without an id. */
export function calendarEvent(e: Obj): CalendarEvent | null {
	type Time = CalendarEvent['start'];
	const id = str(e['id']);
	if (id === null) return null;
	const time = (t: Json | undefined): Time | null =>
		!Predicate.isObject(t)
			? null
			: typeof t['date'] === 'string'
				? { date: PlainDate(t['date']) }
				: typeof t['dateTime'] === 'string'
					? { at: Instant(t['dateTime']), zone: str(t['timeZone']) }
					: null;
	const status =
		e['status'] === 'cancelled' || e['status'] === 'tentative' ? e['status'] : 'confirmed';
	const eventStart = time(e['start']),
		eventEnd = time(e['end']);
	if (status !== 'cancelled' && (eventStart === null || eventEnd === null))
		throw new Error('Calendar event has no start or end');
	// a cancellation Google reports by its id alone carries no times: its original start, else the epoch (its feed's map removes it)
	const start = eventStart ?? time(e['originalStartTime']) ?? { date: PlainDate('1970-01-01') };
	return {
		id,
		summary: str(e['summary']),
		description: str(e['description']),
		location: str(e['location']),
		url: str(e['htmlLink']),
		status,
		start,
		end: eventEnd ?? start,
		source: e
	};
}
