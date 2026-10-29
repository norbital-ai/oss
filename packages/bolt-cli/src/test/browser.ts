// Internal pages mount the real shell; public pages validate native SSR documents without executing their scripts.
import {
	Cause,
	Clock,
	Effect,
	Fiber,
	FiberSet,
	Option,
	Schedule,
	Schema,
	type Scope,
	Stream
} from 'effect';
import { Sse } from 'effect/encoding';
import { Cookies } from 'effect/http';
import type { EventSourceLike, Holder, Authority, Json } from '@norbital-ai/bolt/tooling/browser';
import {
	teams as manifestTeams,
	Frame,
	LiveReply,
	QReply,
	PATHS,
	renderMode,
	decodePublicHydration,
	PUBLIC_HYDRATION_ID,
	mountShell,
	type ShellMountConfig,
	audienceOf,
	nav,
	surfaces,
	type NavNode
} from '@norbital-ai/bolt/tooling/browser';
import { KitInvalid, type KitFailure, TestWorkspace } from './effect.ts';
export { mountShell, type ShellMountConfig };

export type SweepActor =
	| { team: string; external?: boolean }
	| { policies: readonly string[]; external?: boolean }
	| { visitor: string }
	| { admin: true };
export type SweepOptions = {
	pages?: ShellMountConfig['pages'];
	/** Public routes validate their real isolated SSR document and decoded data; browser interactivity needs a compiled browser probe. */
	publicPages?: Readonly<Record<string, Schema.Codec<unknown, Json>>>;
	messages?: ShellMountConfig['messages'];
	representations?: ShellMountConfig['representations'];
	as?: readonly SweepActor[];
	apps?: readonly string[];
	quietMs?: number;
};
export type SweepFinding = {
	who: string;
	path: string;
	kind: 'console' | 'error' | 'budget' | 'read';
	message: string;
};
export type SweepReport = {
	visited: { who: string; path: string; mode: 'spa' | 'ssr' }[];
	findings: SweepFinding[];
};
const Finding = Schema.Struct({
	who: Schema.String,
	path: Schema.String,
	kind: Schema.Literals(['console', 'error', 'budget', 'read']),
	message: Schema.String
});
const Report = Schema.Struct({
	visited: Schema.Array(
		Schema.Struct({
			who: Schema.String,
			path: Schema.String,
			mode: Schema.Literals(['spa', 'ssr'])
		})
	),
	findings: Schema.Array(Finding)
});
export class SweepFailed extends Schema.TaggedError<SweepFailed>()('SweepFailed', {
	message: Schema.String,
	report: Report
}) {}
const ORIGIN = 'http://localhost';
const BUDGET = new Set(['subscriptionTooLarge', 'tooManySubscriptions', 'cellBudget']);
const refusal = (code: string) =>
	BUDGET.has(code) ? ('budget' as const) : code === 'invalid' ? ('read' as const) : null;
const flat = (nodes: readonly NavNode[]): string[] =>
	nodes.flatMap((node) =>
		node.kind === 'group' ? flat(node.children) : node.pages.map((page) => page.href)
	);
const label = (actor: SweepActor) =>
	'visitor' in actor
		? `visitor of ${actor.visitor}`
		: 'admin' in actor
			? 'administrator'
			: `${actor.external ? 'external' : 'member'} [${'team' in actor ? actor.team : actor.policies.join(', ')}]`;
const milliseconds = Effect.map(Clock.monotonicTimeNanos, (value) => Number(value / 1_000_000n));
const quiet = (state: { inflight: number; last: number }, budget: number) =>
	Effect.gen(function* () {
		const start = yield* milliseconds;
		yield* Effect.sleep('20 millis');
		const idle = Effect.map(milliseconds, (now) => ({
			idle: state.inflight === 0 && now - state.last >= 50,
			expired: now - start >= budget
		}));
		const done = yield* idle.pipe(
			Effect.repeat({
				schedule: Schedule.spaced('10 millis'),
				until: (value) => value.idle || value.expired,
				times: Math.ceil(budget / 10) + 1
			})
		);
		return done.idle;
	});
type VisitOptions = Pick<SweepOptions, 'pages' | 'publicPages' | 'messages' | 'representations'> & {
	readonly onRequest?: (request: Request) => void;
};
type VisitActor = (Holder & { readonly id: string }) | { readonly visitor: string } | null;
const mountVisit = (
	path: string,
	who: VisitActor,
	options: VisitOptions,
	finding: (kind: SweepFinding['kind'], message: string) => void
) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace;
		const run = yield* FiberSet.makeRuntimePromise();
		const fibers = yield* FiberSet.make<void, never>();
		const traffic: string[] = [],
			state = { inflight: 0, last: yield* milliseconds };
		let jar = Cookies.empty;
		if (who !== null && !('visitor' in who)) jar = Cookies.fromSetCookie(yield* t.session(who.id));
		const fetch: typeof globalThis.fetch = (input, init = {}) =>
			run(
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						state.inflight++;
						return yield* restore(
							Effect.gen(function* () {
								const url = new URL(
									typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
									ORIGIN
								);
								const request = new Request(url, input instanceof Request ? input : init);
								if (!Cookies.isEmpty(jar))
									request.headers.set('cookie', Cookies.toCookieHeader(jar));
								options.onRequest?.(request);
								traffic.push(`${request.method} ${url.pathname}`);
								const response = yield* t.handle(request);
								jar = Cookies.merge(jar, Cookies.fromSetCookie(response.headers.getSetCookie()));
								if (url.pathname === PATHS.live && request.method === 'POST' && response.ok) {
									const raw = yield* Effect.tryPromise({
										try: (): Promise<unknown> => response.clone().json(),
										catch: (error) => new KitInvalid({ message: String(error) })
									});
									const reply = yield* Schema.decodeUnknownEffect(LiveReply)(raw).pipe(
										Effect.mapError((error) => new KitInvalid({ message: error.message }))
									);
									for (const error of reply.errors) {
										const kind = refusal(error.code);
										if (kind !== null)
											finding(
												kind,
												`${error.view}: ${error.code}${kind === 'read' ? ` ${error.message}` : ''}`
											);
									}
								}
								return response;
							})
						).pipe(
							Effect.ensuring(
								Effect.gen(function* () {
									state.inflight--;
									state.last = yield* milliseconds;
								})
							)
						);
					})
				),
				{ signal: init.signal ?? (input instanceof Request ? input.signal : undefined) }
			);
		const openStream = (url: string): EventSourceLike => {
			let fiber: Fiber.Fiber<void, never> | undefined,
				closed = false;
			const source: EventSourceLike = {
				onmessage: null,
				onerror: null,
				close: () => {
					closed = true;
					if (fiber !== undefined) void run(Fiber.interrupt(fiber));
				}
			};
			const consume = Effect.gen(function* () {
				const response = yield* Effect.tryPromise({
					try: () => fetch(url),
					catch: (error) => new KitInvalid({ message: String(error) })
				});
				if (response.body === null)
					return yield* Effect.fail(new KitInvalid({ message: 'the live response has no body' }));
				const body = response.body;
				yield* Stream.fromReadableStream({
					evaluate: () => body,
					onError: (error) => new KitInvalid({ message: String(error) })
				}).pipe(
					Stream.decodeText(),
					Stream.pipeThroughChannel(Sse.decode()),
					Stream.runForEach((event) =>
						Effect.sync(() => {
							const frame = Schema.decodeUnknownOption(Schema.fromJsonString(Frame))(event.data);
							if (Option.isSome(frame) && frame.value.t === 'error') {
								const kind = refusal(frame.value.code);
								if (kind !== null)
									finding(
										kind,
										`${frame.value.view}: ${frame.value.code}${kind === 'read' ? ` ${frame.value.message}` : ''}`
									);
							}
							source.onmessage?.(new MessageEvent('message', { data: event.data }));
						})
					)
				);
			}).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.void
						: Effect.logWarning(cause).pipe(
								Effect.andThen(
									Effect.sync(() => {
										if (!closed) source.onerror?.(new Event('error'));
									})
								)
							)
				)
			);
			void run(FiberSet.run(fibers, consume)).then((started) => {
				fiber = started;
				if (closed) void run(Fiber.interrupt(started));
			});
			return source;
		};
		yield* Effect.acquireRelease(
			Effect.sync(() => {
				const original = console.error;
				const error = (event: ErrorEvent) => finding('error', event.message);
				console.error = (...args: unknown[]) => finding('console', args.map(String).join(' '));
				window.addEventListener('error', error);
				return { original, error };
			}),
			({ original, error }) =>
				Effect.sync(() => {
					console.error = original;
					window.removeEventListener('error', error);
				})
		);
		if (
			'happyDOM' in window &&
			typeof window.happyDOM === 'object' &&
			window.happyDOM !== null &&
			'setURL' in window.happyDOM &&
			typeof window.happyDOM.setURL === 'function'
		)
			window.happyDOM.setURL(`${ORIGIN}${path}`);
		else history.replaceState(null, '', path);
		const selected = renderMode(t.manifest, path);
		if (selected !== null) {
			const codec = options.publicPages?.[selected.key];
			if (codec === undefined)
				return yield* new KitInvalid({
					message: `sweep requires the shared data codec for public page ${selected.key}`
				});
			const response = yield* Effect.tryPromise({
				try: () => fetch(`${ORIGIN}${path}`),
				catch: (error) => new KitInvalid({ message: String(error) })
			});
			const html = yield* Effect.tryPromise({
				try: () => response.text(),
				catch: (error) => new KitInvalid({ message: String(error) })
			});
			const contentType = response.headers.get('content-type');
			if (response.status !== 200 || !contentType?.startsWith('text/html')) {
				const detail = html.replace(/\s+/g, ' ').trim().slice(0, 1_200);
				return yield* new KitInvalid({
					message: `Public page ${selected.key} did not return server-rendered HTML (HTTP ${response.status}, ${contentType ?? 'no content-type'}): ${detail || '(empty response)'}`
				});
			}
			// Template contents stay inert, including stylesheet/image fetching in DOM test environments.
			const parsed = yield* Effect.try({
				try: () => {
					const template = document.createElement('template');
					template.innerHTML = html;
					return template.content;
				},
				catch: (error) => new KitInvalid({ message: String(error) })
			});
			const target = parsed.getElementById('bolt');
			const metadata = parsed.getElementById(PUBLIC_HYDRATION_ID);
			const release = parsed.querySelector('meta[name="bolt-release"]')?.getAttribute('content');
			if (
				target === null ||
				target.childNodes.length === 0 ||
				metadata?.tagName !== 'SCRIPT' ||
				metadata.getAttribute('type') !== 'application/json' ||
				release !== t.release ||
				parsed.querySelector('script[type="module"][src]') === null
			)
				return yield* new KitInvalid({
					message: `Public page ${selected.key} omitted its rendered body, hydration envelope or matching release entry.`
				});
			yield* decodePublicHydration(metadata.textContent ?? '', codec, {
				route: selected.key,
				release: t.release
			}).pipe(Effect.mapError((error) => new KitInvalid({ message: error.message })));
			return { target, traffic, state };
		}
		const target = yield* Effect.acquireRelease(
			Effect.sync(() => {
				const node = document.createElement('div');
				document.body.append(node);
				return node;
			}),
			(node) =>
				Effect.sync(() => {
					node.remove();
					if ('happyDOM' in window) {
						document.adoptedStyleSheets = [...document.adoptedStyleSheets];
						const button = document.createElement('button');
						document.documentElement.append(button);
						button.focus();
						button.blur();
						button.remove();
					}
				})
		);
		yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					mountShell(target, {
						manifest: t.manifest,
						pages: options.pages ?? {},
						fetch,
						openStream,
						...(options.messages === undefined ? {} : { messages: options.messages }),
						...(options.representations === undefined
							? {}
							: { representations: options.representations })
					}),
				catch: (error) =>
					new KitInvalid({ message: error instanceof Error ? error.message : String(error) })
			}),
			(dispose) =>
				Effect.tryPromise({
					try: dispose,
					catch: (error) => new KitInvalid({ message: String(error) })
				}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
		);
		return { target, traffic, state };
	});
/** Public targets belong to an inert detached SSR document; interactive hydration is verified in compiled browser probes. */
export const visit = (
	path: string,
	who: VisitActor,
	options: VisitOptions = {}
): Effect.Effect<
	{ readonly target: HTMLElement; readonly traffic: readonly string[] },
	KitFailure,
	TestWorkspace | Scope.Scope
> =>
	mountVisit(path, who, options, () => {}).pipe(
		Effect.map(({ target, traffic }) => ({ target, traffic }))
	);

export const sweep = (
	options: SweepOptions = {}
): Effect.Effect<SweepReport, SweepFailed | KitFailure, TestWorkspace> =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace,
			manifest = t.manifest,
			teams = manifestTeams(manifest);
		const apps = Object.entries(manifest.apps).filter(
			([name]) => options.apps === undefined || options.apps.includes(name)
		);
		const external = apps.some(
			([, app]) => audienceOf(app) === 'external' || audienceOf(app) === 'all'
		);
		const actors: readonly SweepActor[] = options.as ?? [
			...Object.keys(teams).map((team) => ({ team })),
			...(external ? Object.keys(teams).map((team) => ({ team, external: true })) : []),
			...apps.filter(([, app]) => audienceOf(app) === 'public').map(([visitor]) => ({ visitor }))
		];
		const report: SweepReport = { visited: [], findings: [] };
		for (const actor of actors) {
			const name = label(actor);
			let who: VisitActor, auth: Authority;
			if ('visitor' in actor) {
				who = actor;
				auth = t.visitor(actor.visitor).authority;
			} else {
				const admin = 'admin' in actor;
				const team = admin
					? null
					: 'team' in actor
						? actor.team
						: actor.policies.length === 0
							? null
							: Object.entries(teams).find(
									([, entry]) =>
										entry.policies.length === actor.policies.length &&
										entry.policies.every((policy) => actor.policies.includes(policy))
								)?.[0];
				if (team === undefined || (team !== null && !Object.hasOwn(teams, team)))
					return yield* Effect.fail(
						new KitInvalid({ message: `sweep requires an authored source team for ${name}` })
					);
				const policies = team === null ? [] : (teams[team]?.policies ?? []);
				who = t.member(policies, {
					email: `sweep-${crypto.randomUUID()}@sweep.test`,
					admin,
					external: !admin && actor.external === true,
					teams: team === null ? [] : [team]
				});
				auth = t.as(who).authority;
			}
			const available = surfaces(manifest, auth.actor, auth.admin);
			const paths = [
				...flat(nav(manifest, auth)).filter(
					(path) =>
						options.apps === undefined ||
						options.apps.some((app) => path.startsWith(`/app/${app}/`))
				),
				...(available.inbox ? ['/inbox'] : []),
				...(available.settings ? ['/settings/organization'] : [])
			];
			// Record drawers belong to the internal shell; a public document has no record drawer to exercise.
			const recordBase = paths.find((path) => renderMode(manifest, path) === null);
			for (const model of 'visitor' in actor ? [] : Object.keys(options.representations ?? {})) {
				if (who === null || 'visitor' in who || recordBase === undefined) continue;
				const cookie = yield* t.session(who.id);
				// Representation names are runtime manifest data; their requests use the native route and session.
				const rows = yield* Effect.gen(function* () {
					const request = new Request(`${ORIGIN}${PATHS.q}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							reads: [{ m: 'query', a: [{ [model]: { fields: ['id'], limit: 1 } }] }]
						})
					});
					request.headers.set('cookie', cookie);
					const response = yield* t.handle(request);
					const body = yield* Effect.tryPromise({
						try: (): Promise<unknown> => response.json(),
						catch: (error) => new KitInvalid({ message: String(error) })
					});
					const reply = yield* Schema.decodeUnknownEffect(QReply)(body);
					const answer = yield* Schema.decodeUnknownEffect(
						Schema.Record(
							Schema.String,
							Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String })) })
						)
					)(reply.answers[0]);
					return answer[model] ?? { rows: [] };
				}).pipe(Effect.catch(() => Effect.succeed({ rows: [] })));
				const row = rows.rows[0];
				paths.push(
					...[`${model}/new`, ...(row === undefined ? [] : [`${model}/${row.id}`])].map(
						(record) => `${recordBase}?record=${record}`
					)
				);
			}
			for (const path of paths) {
				const finding = (kind: SweepFinding['kind'], message: string) => {
					report.findings.push({ who: name, path, kind, message });
				};
				yield* Effect.scoped(
					Effect.gen(function* () {
						const mounted = yield* mountVisit(path, who, options, finding);
						if (!(yield* quiet(mounted.state, options.quietMs ?? 2_000)))
							finding('error', `page did not settle within ${options.quietMs ?? 2_000} ms`);
						if (location.pathname.startsWith('/sign-in'))
							finding('error', `redirected to ${location.pathname}`);
					})
				).pipe(Effect.catch((error) => Effect.sync(() => finding('error', error.message))));
				report.visited.push({
					who: name,
					path,
					mode: renderMode(manifest, path) === null ? 'spa' : 'ssr'
				});
			}
		}
		if (report.findings.length > 0)
			return yield* Effect.fail(
				new SweepFailed({
					report,
					message: `sweep found ${report.findings.length} problem(s):\n${report.findings.map((finding) => `  ${finding.who} ${finding.path} ${finding.kind}: ${finding.message}`).join('\n')}`
				})
			);
		return report;
	});
