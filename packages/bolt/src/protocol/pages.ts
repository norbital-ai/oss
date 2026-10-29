import {
	Context,
	Crypto,
	Effect,
	Fiber,
	FiberSet,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema
} from 'effect';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import type { Artifact } from '../engine/artifact/read.ts';
import type { CrossAnswer } from '../engine/contracts.ts';
import { Activation, Guest, GuestLimits, Manifest, Reads } from '../engine/services.ts';
import { ShellHandler, type PublicPageRoute } from '../shell/host.ts';
import { audienceOf, framePolicy, route, type ShellManifest } from '../shell/nav.ts';
import { BoltError } from './errors.ts';
import {
	bindings,
	rateLimitedResponse,
	readAdmitted,
	requestReadRate,
	requestUrl,
	responseError,
	RateLimits
} from './http.ts';
import { PublicBoot, PublicHydration, toPublicBoot } from './public-page.ts';

type PageMode = PublicPageRoute & { readonly key: string };

/** Route eligibility is pure and uses the same resolver as browser navigation. */
export function renderMode(manifest: ShellManifest, path: string): PageMode | null {
	const selected = route(manifest, new URL(path, 'http://bolt.local'));
	if (selected.kind === 'page' && audienceOf(manifest.apps[selected.app]) !== 'members')
		return { kind: 'app', app: selected.app, key: `app/${selected.app}/${selected.page}` };
	if (
		selected.kind === 'kiosk' &&
		(manifest.kiosks?.[selected.kiosk]?.auth ?? 'members') !== 'members'
	)
		return {
			kind: 'kiosk',
			kiosk: selected.kiosk,
			key: `kiosk/${selected.kiosk}/${selected.page}`
		};
	return null;
}

const PageOutput = Schema.Struct({
	body: Schema.String,
	head: Schema.String,
	data: Schema.Json,
	messages: Schema.Record(Schema.String, Schema.String)
});
const json = (value: unknown) =>
	JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
		switch (character) {
			case '<':
				return '\\u003c';
			case '>':
				return '\\u003e';
			case '&':
				return '\\u0026';
			case '\u2028':
				return '\\u2028';
			default:
				return '\\u2029';
		}
	});
const attribute = (value: string) =>
	value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
const denied = (message: string): CrossAnswer => ({
	ok: false,
	error: { kind: 'bolt', code: 'forbidden', message }
});

export class PublicPages extends Context.Service<
	PublicPages,
	{
		readonly render: (
			request: HttpServerRequest.HttpServerRequest
		) => Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>>;
	}
>()('bolt/PublicPages') {}

/** Programs and documents are verified artifact data; tenant modules never enter the host's module graph. */
export const publicPages = (artifact: Artifact) =>
	Layer.effect(
		PublicPages,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const { join } = yield* Path.Path;
			const documents = new Map(
				yield* Effect.forEach(Object.keys(artifact.pages), (key) =>
					fs
						.readFileString(join(artifact.client, 'public', key, 'index.html'))
						.pipe(Effect.map((document) => [key, document] as const))
				)
			);
			const shell = yield* ShellHandler;
			const guest = yield* Guest;
			const reads = yield* Reads;
			const manifest = yield* Manifest;
			const activation = yield* Activation;
			const limits = yield* GuestLimits;
			const rates = yield* RateLimits;
			const crypto = yield* Crypto.Crypto;
			const requests = yield* FiberSet.make();
			const render = Effect.fn('protocol.publicPage')(function* (
				request: HttpServerRequest.HttpServerRequest
			) {
				if (request.method !== 'GET' && request.method !== 'HEAD') return Option.none();
				const url = requestUrl(request);
				const selected = renderMode(manifest, url.pathname);
				if (selected === null) return Option.none();
				const page = artifact.pages[selected.key];
				const document = documents.get(selected.key);
				if (page === undefined || document === undefined)
					return yield* Effect.fail(
						BoltError.make(
							'missingBody',
							'admission',
							'The public page is absent from this release.'
						)
					);
				const caller = yield* shell.publicPage(request, selected);
				if (caller._tag === 'Refused') return Option.some(caller.response);
				const rate = yield* requestReadRate(caller.request, caller.authority).pipe(
					Effect.provideService(RateLimits, rates)
				);
				if (!rate.ok) return Option.some(rateLimitedResponse(rate.retryAfter));
				const boot = yield* toPublicBoot(caller.boot, {
					base: caller.base,
					kiosk: selected.kind === 'kiosk' ? selected.kiosk : null,
					messages: {}
				});
				const encodedBoot = yield* Schema.encodeEffect(Schema.toCodecJson(PublicBoot))(boot);
				const bound = yield* bindings.pipe(Effect.provideService(Manifest, manifest));
				const id = yield* crypto.randomUUIDv4();
				const outcome = yield* guest.invokeProgram(
					page.program,
					{
						id,
						kind: 'page',
						target: selected.key,
						input: { request: { pathname: url.pathname, search: url.search }, boot: encodedBoot },
						ctx: {
							actor: caller.authority.actor,
							now: bound.now,
							today: bound.today,
							tz: bound.tz,
							seed: id,
							admin: caller.authority.admin,
							policies: caller.authority.policies
						},
						budget: {
							crossings: limits.crossings.sync,
							readBytes: limits.readBytes
						}
					},
					{
						cross: (calls) =>
							Effect.forEach(calls, (call): Effect.Effect<CrossAnswer> => {
								if (call._tag !== 'read')
									return Effect.succeed(denied('Public page loaders may only read.'));
								if (!readAdmitted(caller.authority, call.read))
									return Effect.succeed(denied('Visitors may not do this.'));
								return reads
									.run([call.read], { as: 'caller', authority: caller.authority }, bound)
									.pipe(
										Effect.flatMap((answers) =>
											answers.length === 1 && answers[0] !== undefined
												? Effect.succeed<CrossAnswer>({ ok: true, value: answers[0] })
												: Effect.fail(
														BoltError.make(
															'badAnswer',
															'deliver',
															'The reader omitted a public page answer.'
														)
													)
										),
										Effect.catch((error) =>
											Effect.succeed<CrossAnswer>({
												ok: false,
												error: {
													kind: 'bolt',
													code: error instanceof BoltError ? error.code : 'internal',
													message: error instanceof Error ? error.message : String(error)
												}
											})
										)
									);
							})
					}
				);
				if (outcome.kind === 'failed') return yield* Effect.fail(outcome.error);
				if (outcome.kind === 'refused')
					return yield* Effect.fail(BoltError.make('guestRefused', 'guest', outcome.message));
				const output = yield* Schema.decodeUnknownEffect(PageOutput)(outcome.output);
				const hydration = yield* Schema.encodeEffect(Schema.toCodecJson(PublicHydration))({
					route: selected.key,
					release: activation.release,
					locale: boot.workspace.locale,
					boot: { ...boot, messages: output.messages },
					data: output.data
				});
				const html = document
					.replace(
						/\b(src|href)="\/(?!\/)/g,
						(_match, name: string) => `${name}="${attribute(caller.base)}/`
					)
					.replace(
						/__BOLT_PUBLIC_RELEASE__|__BOLT_PUBLIC_LOCALE__|<!--bolt-public-head-->|<!--bolt-public-body-->|__BOLT_PUBLIC_HYDRATION__/g,
						(marker) => {
							switch (marker) {
								case '__BOLT_PUBLIC_RELEASE__':
									return attribute(activation.release);
								case '__BOLT_PUBLIC_LOCALE__':
									return attribute(boot.workspace.locale);
								case '<!--bolt-public-head-->':
									return output.head;
								case '<!--bolt-public-body-->':
									return output.body;
								default:
									return json(hydration);
							}
						}
					);
				return Option.some(
					HttpServerResponse.text(html, {
						headers: {
							...caller.headers,
							'content-type': 'text/html; charset=utf-8',
							'cache-control': 'private, no-store',
							'content-security-policy': framePolicy(manifest, url.pathname),
							vary: 'Cookie, Authorization'
						}
					})
				);
			});
			return {
				render: (request) =>
					FiberSet.run(
						requests,
						render(request).pipe(
							Effect.catch((error) => Effect.succeed(Option.some(responseError(error))))
						)
					).pipe(
						Effect.flatMap((fiber) =>
							Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))
						),
						Effect.map(
							Option.map((response) => {
								const privateResponse = HttpServerResponse.setHeader(
									response,
									'cache-control',
									'private, no-store'
								);
								return request.method === 'HEAD'
									? HttpServerResponse.empty({
											status: privateResponse.status,
											statusText: privateResponse.statusText,
											headers: privateResponse.headers,
											cookies: privateResponse.cookies
										})
									: privateResponse;
							})
						)
					)
			};
		})
	);
