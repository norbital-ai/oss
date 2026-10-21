// @vitest-environment happy-dom
// The real workspace shell over the handler and a test-kit workspace on PGlite (§5.10): the hero renders a page's
// AppShell identity and actions; a generated form's file field uploads to `<collection>.<field>` and the submit waits
// for it; the sweep mounts every representation in the record sheet, whose module imports `$bolt`.
import './setup-happy-dom.js';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import {
	Clock,
	Context,
	Deferred,
	Effect,
	FiberSet,
	Layer,
	Option,
	Predicate,
	Redacted,
	Result,
	Schema
} from 'effect';
import { randomBytes, randomUUID } from 'node:crypto';
import { flushSync, type Component } from 'svelte';
import { afterEach, describe, expect, it, vi } from '@effect/vitest';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import type { EventSourceLike } from '../src/page/stream.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { credentials } from '../src/engine/integrations/credentials.ts';
import type { Provider } from '../src/engine/integrations/driver.ts';
import { integrationLinks, type LinkManager } from '../src/engine/integrations/links.ts';
import { Secrets } from '../src/engine/secrets.ts';
import { Approvals } from '../src/engine/services.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { IntegrationManager, integrationRoutes } from '../src/protocol/integrations.ts';
import { mountShell, type ShellMountConfig } from '../src/shell/mount.ts';
import { sweep, visit } from '../src/test/browser.ts';
import {
	KitInvalid,
	TestWorkspace,
	type Kit,
	type TestOptions,
	type WorkspaceServices
} from '../src/test/index.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { sse } from './support/live-bolt.ts';
import Hero from './support/shell-hero.svelte';
import Upload from './support/shell-upload.svelte';
import PageTabs from './support/shell-tabs.svelte';
import Rep from './support/shell-rep.svelte';
import NoisyRep from './support/shell-rep-noisy.svelte';
import BadRead from './support/shell-bad-read.svelte';
import ScopedPage from './support/shell-scoped-page.svelte';
import ScopedShellPage from './support/shell-scoped-shell-page.svelte';
import ScopedRep from './support/shell-scoped-rep.svelte';

const ORIGIN = 'http://localhost';
const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en', apps: ['desk'], agent: { triage: false } }, // hook:decisions
		models: {
			docs: {
				description: 'A document',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					scan: { kind: 'file', accept: ['text/plain'], max: '1MiB', optional: true }
				}
			}
		},
		relationships: {},
		collections: {
			docs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'scan'] } } }
		},
		policies: {
			clerk: {
				description: 'Files documents',
				capabilities: { apps: ['desk'] },
				grants: { docs: { read: true, create: true } }
			}
		},
		apps: {
			desk: {
				title: 'Desk',
				description: 'd',
				icon: 'i',
				pages: { hero: { title: 'Hero' }, upload: { title: 'Upload' } }
			}
		},
		agent: { skills: {} },
		integrations: {},
		pipelines: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		customFields: {}
	})
);
const page =
	<P extends Record<string, unknown>>(component: Component<P>) =>
	async () => ({ default: component });
const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value.');
	return value;
};
const resize = (width: number, height = 768) => {
	if (
		!('happyDOM' in window) ||
		!Predicate.isObject(window.happyDOM) ||
		!('setWindowSize' in window.happyDOM) ||
		typeof window.happyDOM.setWindowSize !== 'function'
	)
		throw new Error('Missing happy-dom viewport.');
	window.happyDOM.setWindowSize({ width, height });
};
afterEach(() => {
	resize(1024);
	vi.unstubAllGlobals();
});
const tick = Effect.sleep('5 millis').pipe(Effect.andThen(Effect.sync(flushSync)));
const until = <E = never, R = never>(ok: () => boolean | Effect.Effect<boolean, E, R>, n = 600) =>
	Effect.gen(function* () {
		const check = Effect.suspend(() => {
			const value = ok();
			return typeof value === 'boolean' ? Effect.succeed(value) : value;
		});
		for (let i = 0; i < n && !(yield* check); i++) yield* tick;
		expect(yield* check).toBe(true);
	});
const workspace = (options: TestOptions) =>
	Effect.gen(function* () {
		return yield* Layer.build(
			TestWorkspace.layer({
				...options,
				now: new Date(yield* Clock.currentTimeMillis).toISOString(),
				host: { workspace: { name: 'Acme', handle: 'acme' }, ...options.host }
			})
		);
	});
const mountAt = (path: string, config: ShellMountConfig) =>
	Effect.gen(function* () {
		history.replaceState(null, '', path);
		const target = yield* Effect.acquireRelease(
			Effect.sync(() => {
				const target = document.createElement('div');
				document.body.append(target);
				return target;
			}),
			(target) => Effect.sync(() => target.remove())
		);
		yield* Effect.acquireRelease(
			Effect.try({
				try: () => mountShell(target, config),
				catch: (error) => new KitInvalid({ message: String(error) })
			}),
			(dispose) =>
				Effect.tryPromise({
					try: dispose,
					catch: (error) => new KitInvalid({ message: String(error) })
				}).pipe(Effect.orDie)
		);
		return target;
	});

/** Native scoped visits; custom upload gates and release frames stay at the browser fetch/EventSource ABI. */
const open = (
	context: Context.Context<TestWorkspace | WorkspaceServices>,
	path: string,
	pages: ShellMountConfig['pages'],
	gate?: Deferred.Deferred<void>,
	representations?: ShellMountConfig['representations'],
	live = false,
	capture = false,
	manager?: LinkManager
) =>
	Effect.gen(function* () {
		const t = Context.get(context, TestWorkspace);
		const who = t.member([], { admin: true, email: `ada-${randomUUID()}@x.test` });
		yield* t.db.write({
			text: 'UPDATE sys_user SET name = $2 WHERE id = $1',
			params: [who.id, 'Ada']
		});
		const puts: string[] = [],
			sources: EventSourceLike[] = [];
		if (gate === undefined && !capture && manager === undefined) {
			const mounted = yield* visit(path, who, {
				pages,
				...(representations === undefined ? {} : { representations })
			}).pipe(Effect.provide(context));
			return { target: mounted.target, puts, sources };
		}
		const cookie = yield* t.session(who.id);
		const run = yield* FiberSet.makeRuntimePromise();
		const dispatch = (request: Request) =>
			Effect.gen(function* () {
				request.headers.set('cookie', cookie);
				if (request.method === 'PUT') {
					puts.push(decodeURIComponent(new URL(request.url).pathname));
					if (gate !== undefined) yield* Deferred.await(gate);
				}
				if (manager !== undefined) {
					const response = yield* integrationRoutes(HttpServerRequest.fromWeb(request)).pipe(
						Effect.provideService(IntegrationManager, Option.some(manager)),
						Effect.provide(context)
					);
					if (Option.isSome(response)) return HttpServerResponse.toWeb(response.value, { context });
				}
				return yield* t.handle(request, { address: '203.0.113.9' });
			});
		const fetch: typeof globalThis.fetch = (input, init = {}) => {
			const request = new Request(
				new URL(input instanceof Request ? input.url : String(input), ORIGIN),
				input instanceof Request ? input : init
			);
			return run(dispatch(request), { signal: request.signal });
		};
		const stream = yield* sse((url) => dispatch(new Request(new URL(url, ORIGIN))));
		const target = yield* mountAt(path, {
			manifest: t.manifest,
			pages,
			fetch,
			openStream: (url) => {
				const source: EventSourceLike =
					live || !capture ? stream(url) : { onmessage: null, onerror: null, close() {} };
				sources.push(source);
				return source;
			},
			...(representations === undefined ? {} : { representations })
		});
		return { target, puts, sources };
	});

describe('the shell renders a page (§5.10)', () => {
	it.live('leaves links marked for document reload to native browser navigation', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* workspace({ manifest });
				const { target } = yield* open(context, '/app/desk/hero', { 'desk/hero': page(Hero) });
				yield* until(() => target.querySelector('[data-export]') !== null);
				const handoff = document.createElement('a');
				handoff.href = '#host-handoff';
				handoff.setAttribute('data-sveltekit-reload', '');
				present(target.firstElementChild).append(handoff);
				const click = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
				handoff.dispatchEvent(click);
				expect(click.defaultPrevented).toBe(false);
				expect(location.pathname).toBe('/app/desk/hero');
				expect(location.hash).toBe('#host-handoff');
			})
		)
	);

	for (const dirty of [false, true])
		it.live(`a release reloads a clean page and preserves an unsaved form (dirty=${dirty})`, () =>
			Effect.scoped(
				Effect.gen(function* () {
					const reload = vi.spyOn(location, 'reload').mockImplementation(() => {});
					yield* Effect.addFinalizer(() => Effect.sync(() => reload.mockRestore()));
					const context = yield* workspace({ manifest });
					const { target, sources } = yield* open(
						context,
						'/app/desk/upload',
						{
							'desk/upload': page(Upload)
						},
						undefined,
						undefined,
						false,
						true
					);
					yield* until(() => target.querySelector('input') !== null && sources.length > 0);
					if (dirty) {
						const title = present(target.querySelector<HTMLInputElement>('input[type=text]'));
						title.value = 'Unsaved title';
						title.dispatchEvent(new Event('input', { bubbles: true }));
						yield* tick;
					}
					present(present(sources.at(-1)).onmessage)(
						new MessageEvent('message', {
							data: JSON.stringify({ t: 'close', release: 'new-release' })
						})
					);
					yield* tick;
					expect(reload).toHaveBeenCalledTimes(dirty ? 0 : 1);
					if (dirty) {
						expect(target.textContent).toContain('This workspace was updated');
						expect(present(target.querySelector<HTMLInputElement>('input[type=text]')).value).toBe(
							'Unsaved title'
						);
					}
				})
			)
		);

	it.live(
		'a phone shows one top bar carrying the identity, bell and scope; the desktop hero returns on resize',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const mobileResize = (width: number) => resize(width, 812);
					mobileResize(375);
					const context = yield* workspace({ manifest });
					const { target } = yield* open(context, '/app/desk/hero', { 'desk/hero': page(Hero) });
					yield* until(() => target.querySelector('[data-export]') !== null);
					// Prime happy-dom's change listener at its initial matching viewport before resizing away.
					window.dispatchEvent(new Event('resize'));
					const heroes = () => target.querySelectorAll('[data-layout=app-media-header]');
					const bar = () => target.querySelector('main header[data-layout=app-media-header]');
					yield* until(() => bar() !== null);
					// one header: no second hero below it, and the scope controls sit in its lane
					expect(heroes()).toHaveLength(1);
					expect(target.querySelectorAll('main header')).toHaveLength(1);
					expect(present(bar()).textContent).toContain('Dispatch board');
					expect(present(bar()).textContent).toContain('Every job due today');
					expect(present(bar()).querySelector('[data-app-actions] [data-export]')).not.toBeNull();
					expect(
						present(bar()).querySelector('[data-app-actions]')?.getAttribute('aria-label')
					).toBe('Page scope');
					expect(present(bar()).querySelector('[aria-label="Open navigation"]')).not.toBeNull();
					expect(present(bar()).querySelector('[data-testid=notification-bell]')).not.toBeNull();
					present(target.querySelector<HTMLButtonElement>('[data-export]')).click();
					yield* until(() => present(present(bar()).textContent).includes('Dispatch overview'));
					expect(present(bar()).textContent).toContain('All jobs this week');
					expect(target.textContent).not.toContain('Every job due today');
					expect(heroes()).toHaveLength(1);
					mobileResize(1024);
					yield* until(() => bar() === null);
					expect(heroes()).toHaveLength(1);
					expect(present(heroes()[0]).textContent).toContain('Dispatch overview');
					expect(present(heroes()[0]).textContent).toContain('All jobs this week');
					mobileResize(375);
					yield* until(() => bar() !== null);
					expect(present(bar()).textContent).toContain('Dispatch overview');
					expect(present(bar()).textContent).toContain('All jobs this week');
					expect(heroes()).toHaveLength(1);
					expect(present(bar()).querySelector('[data-app-actions] [data-export]')).not.toBeNull();
				})
			)
	);

	it.live('shows the AppShell identity and its actions in the hero above the page', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* workspace({ manifest });
				const { target } = yield* open(context, '/app/desk/hero', { 'desk/hero': page(Hero) });
				yield* until(() => target.querySelector('[data-body]') !== null);
				yield* until(() => target.querySelector('[data-layout=app-media-header]') !== null);
				const hero = present(target.querySelector('[data-layout=app-media-header]'));
				expect(hero.textContent).toContain('Dispatch board');
				expect(hero.textContent).toContain('Every job due today');
				expect(hero.querySelector('[data-export]')).not.toBeNull();
				// the actions read the dark tokens on the scrim (A7); a phone shows two lines of description (A15)
				expect(present(hero.querySelector('[data-export]')).closest('.dark')).not.toBeNull();
				expect(
					present(
						[...hero.querySelectorAll('p')].find((p) =>
							p.textContent?.includes('Every job due today')
						)
					).classList
				).toContain('line-clamp-2');
				expect(hero.querySelector('[data-layout=frame]')).not.toBeNull(); // the icon chip
			})
		)
	);

	it.live(
		'switching app pages keeps the banner, tabs and current page until the next page loads',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* workspace({ manifest });
					const chunk = yield* Deferred.make<void>();
					const { target } = yield* open(context, '/app/desk/hero', {
						'desk/hero': page(Hero),
						'desk/upload': () =>
							Effect.runPromise(Deferred.await(chunk)).then(() => ({ default: Upload }))
					});
					yield* until(() => target.querySelector('[data-layout=app-media-header]') !== null);
					present(
						[...target.querySelectorAll<HTMLAnchorElement>('nav[aria-label=Pages] a')].find((a) =>
							a.href.endsWith('/app/desk/upload')
						)
					).click();
					yield* until(() => location.pathname.endsWith('/app/desk/upload'));
					flushSync();
					expect(target.textContent).not.toContain('Loading…');
					expect(target.querySelector('nav[aria-label=Pages]')).not.toBeNull();
					expect(target.querySelector('[data-layout=app-media-header]')).not.toBeNull();
					yield* Deferred.succeed(chunk, undefined);
					yield* until(() => target.querySelector('form') !== null);
					expect(target.querySelector('nav[aria-label=Pages]')).not.toBeNull();
				})
			)
	);

	it.live("a page's own Tabs render at level 2 under the app pages strip (A8)", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* workspace({ manifest });
				const { target } = yield* open(context, '/app/desk/upload', {
					'desk/upload': page(PageTabs)
				});
				yield* until(() => target.querySelector('[data-body]') !== null);
				expect(target.querySelector('nav[aria-label=Pages]')).not.toBeNull();
				expect(
					present(target.querySelector('[data-tabs-variant]')).getAttribute('data-tabs-variant')
				).toBe('underline');
			})
		)
	);

	it.live('keeps the app banner and tabs mounted while its first page chunk loads', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* workspace({ manifest });
				const chunk = yield* Deferred.make<void>();
				const { target } = yield* open(context, '/app/desk/hero', {
					'desk/hero': () =>
						Effect.runPromise(Deferred.await(chunk)).then(() => ({ default: Hero }))
				});
				yield* until(() => target.querySelector('nav[aria-label=Pages]') !== null);
				const tabs = target.querySelector('nav[aria-label=Pages]');
				const banner = target.querySelector('[data-layout=app-media-header]');
				expect(banner).not.toBeNull();
				expect(target.querySelector('[data-body]')).toBeNull();
				yield* Deferred.succeed(chunk, undefined);
				yield* until(() => target.querySelector('[data-body]') !== null);
				expect(target.querySelector('nav[aria-label=Pages]')).toBe(tabs);
				expect(target.querySelector('[data-layout=app-media-header]')).toBe(banner);
			})
		)
	);

	it.live(
		'a generated form uploads a file to <collection>.<field>, and its submit waits for the upload',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* workspace({ manifest });
					const t = Context.get(context, TestWorkspace);
					const gate = yield* Deferred.make<void>();
					const { target, puts } = yield* open(
						context,
						'/app/desk/upload',
						{ 'desk/upload': page(Upload) },
						gate
					);
					yield* until(() => target.querySelector('input[type=file]') !== null);
					const title = present(target.querySelector<HTMLInputElement>('[data-field=title] input'));
					title.value = 'Lease';
					title.dispatchEvent(new Event('input', { bubbles: true }));
					const input = present(target.querySelector<HTMLInputElement>('input[type=file]'));
					Object.defineProperty(input, 'files', {
						configurable: true,
						value: [new File(['signed'], 'lease.txt', { type: 'text/plain' })]
					});
					input.dispatchEvent(new Event('change', { bubbles: true }));
					yield* until(() => puts.length === 1);
					expect(puts).toEqual(['/__bolt/files/docs.scan']);
					// submitted while the upload is in flight: the act carries the stored file, never a draft without it
					present(target.querySelector<HTMLFormElement>('form')).requestSubmit();
					yield* tick;
					yield* Deferred.succeed(gate, undefined);
					const rows = () =>
						t.db
							.read([{ text: 'SELECT title, scan FROM docs', params: [] }])
							.pipe(Effect.map((results) => present(results[0]).rows));
					yield* until(() =>
						Effect.gen(function* () {
							return (yield* rows()).length === 1;
						})
					);
					const [row] = yield* rows();
					expect(present(row)['title']).toBe('Lease');
					expect(present(row)['scan']).toMatchObject({ name: 'lease.txt', mime: 'text/plain' });
				})
			)
	);
});

describe("the record sheet keeps the opening page's create scope", () => {
	it.live("a Table's New opens the sheet with the page's contexts above its representation", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* workspace({ manifest });
				const { target } = yield* open(
					context,
					'/app/desk/hero',
					{ 'desk/hero': page(ScopedPage) },
					undefined,
					{ docs: page(ScopedRep) }
				);
				yield* until(
					() =>
						target.querySelector('[data-view-new]') !== null ||
						[...target.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'New')
				);
				const button =
					target.querySelector<HTMLButtonElement>('[data-view-new]') ??
					present(
						[...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New')
					);
				button.click();
				yield* until(() => target.querySelector('[data-scoped-rep]') !== null);
				expect(present(target.querySelector('[data-scoped-rep]')).textContent).toBe(
					'create: Scoped lease'
				);
			})
		)
	);

	it.live(
		'a sheet opened by the URL (a reload, a link) takes the scope of the page it opens over',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* workspace({ manifest });
					const { target } = yield* open(
						context,
						'/app/desk/hero?record=docs/new',
						{ 'desk/hero': page(ScopedPage) },
						undefined,
						{ docs: page(ScopedRep) }
					);
					yield* until(
						() => target.querySelector('[data-scoped-rep]')?.textContent === 'create: Scoped lease'
					);
				})
			)
	);

	it.live(
		"the page's own AppShell carries its scope when no view of the collection is on screen",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* workspace({ manifest });
					const { target } = yield* open(
						context,
						'/app/desk/hero?record=docs/new',
						{ 'desk/hero': page(ScopedShellPage) },
						undefined,
						{ docs: page(ScopedRep) }
					);
					yield* until(
						() => target.querySelector('[data-scoped-rep]')?.textContent === 'create: Scoped lease'
					);
				})
			)
	);
});

describe('a record sheet closes through its ?record= entry', () => {
	it.live(
		'Esc pops only the top sheet and its ?record= entry; a later URL read never reopens it',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const doc = randomUUID();
					const context = yield* workspace({
						manifest,
						seed: { docs: [{ id: doc, title: 'Lease' }] }
					});
					const { target } = yield* open(
						context,
						`/app/desk/hero?record=docs/${doc}&record=docs/new`,
						{
							'desk/hero': page(Hero)
						}
					);
					const sheets = () => target.querySelectorAll('[data-sheet-side]').length;
					const stack = () => new URL(location.href).searchParams.getAll('record');
					yield* until(() => sheets() === 2);
					const esc = new KeyboardEvent('keydown', {
						key: 'Escape',
						bubbles: true,
						cancelable: true
					});
					window.dispatchEvent(esc);
					expect(esc.defaultPrevented).toBe(true);
					yield* until(() => sheets() === 1);
					expect(stack()).toEqual([`docs/${doc}`]);
					window.dispatchEvent(
						new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
					);
					yield* until(() => sheets() === 0);
					expect(stack()).toEqual([]);
					// the next navigation reads the URL again (openRecord's popstate): nothing reopens
					window.dispatchEvent(new PopStateEvent('popstate'));
					yield* tick;
					expect(sheets()).toBe(0);
				})
			)
	);

	it.live(
		"a phone drawer's grabber expands it on a tap, resizes it on a drag, and closes it dragged low",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* workspace({ manifest });
					const { target } = yield* open(context, '/app/desk/hero?record=docs/new', {
						'desk/hero': page(Hero)
					});
					const sheet = () => target.querySelector<HTMLElement>('[data-sheet-side]');
					yield* until(() => sheet() !== null);
					const grab = present(present(sheet()).querySelector<HTMLElement>('[data-sheet-grabber]'));
					grab.click();
					flushSync();
					expect(present(sheet()).dataset['fullscreen']).toBe('true');
					const drag = (dy: number) => {
						grab.dispatchEvent(
							new PointerEvent('pointerdown', { button: 0, clientY: 600, bubbles: true })
						);
						window.dispatchEvent(new PointerEvent('pointermove', { clientY: 600 + dy }));
						window.dispatchEvent(new PointerEvent('pointerup', {}));
						grab.click(); // the click after a drag is no tap
						flushSync();
					};
					drag(-300);
					expect(present(sheet()).dataset['fullscreen']).toBeUndefined();
					expect(present(sheet()).style.getPropertyValue('--sheet-h')).toBe('300px');
					drag(100);
					yield* until(() => sheet() === null);
				})
			)
	);
});

describe('sweep() mounts representations (§3.7, X-20)', () => {
	it.live(
		'opens a new and a stored record of each represented collection; a representation importing $bolt boots',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const doc = randomUUID();
					const context = yield* workspace({
						manifest,
						seed: { docs: [{ id: doc, title: 'Lease' }] }
					});
					const t = Context.get(context, TestWorkspace);
					const route = yield* routeFixture(context);
					const reply = yield* qReply(route, t.as(t.admin).authority, {
						reads: [{ m: 'read', a: ['docs', { select: { id: true }, limit: 1 }] }]
					});
					const stored = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ rows: Schema.Array(Schema.Struct({ id: Schema.String })) })
					)(reply.answers[0]);
					expect(stored.rows.map((row) => row.id)).toEqual([doc]);
					const report = yield* sweep({
						as: [{ admin: true }],
						pages: { 'desk/hero': page(Hero), 'desk/upload': page(Upload) },
						representations: { docs: page(Rep) }
					}).pipe(Effect.provide(context));
					expect(report.visited.map((v) => v.path)).toEqual(
						expect.arrayContaining([
							`/app/desk/hero?record=docs/new`,
							`/app/desk/hero?record=docs/${doc}`
						])
					);
					expect(report.findings).toEqual([]);
				})
			)
	);

	it.live('finds a live read the host refuses as malformed, which no console shows', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* workspace({ manifest });
				expect(
					yield* Effect.flip(
						sweep({
							as: [{ admin: true }],
							pages: { 'desk/hero': page(BadRead), 'desk/upload': page(Hero) }
						}).pipe(Effect.provide(context))
					)
				).toMatchObject({
					message: expect.stringMatching(/administrator \/app\/desk\/hero read: .*invalid/)
				});
			})
		)
	);

	it.live('finds what a representation logs', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* workspace({ manifest });
				expect(
					yield* Effect.flip(
						sweep({
							as: [{ admin: true }],
							pages: { 'desk/hero': page(Hero) },
							representations: { docs: page(NoisyRep) }
						}).pipe(Effect.provide(context))
					)
				).toMatchObject({
					message: expect.stringMatching(
						/administrator \/app\/desk\/hero\?record=docs\/new console: representation mounted: create/
					)
				});
			})
		)
	);
});

describe("system collections render in ui's Table (Settings, Automations, Inbox)", () => {
	const button = (root: ParentNode, text: string) =>
		[...root.querySelectorAll<HTMLButtonElement>('button')].find(
			(b) => b.textContent?.trim() === text
		);
	const press = (b: HTMLElement) => {
		b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
		b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		b.click();
	};

	it.live('the inbox follows a request submitted and withdrawn in another session', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const source = Result.getOrThrow(
					decodeManifest({
						...manifest,
						teams: { clerks: ['clerk'], reviewers: [] },
						policies: {
							clerk: {
								description: 'Clerk',
								capabilities: { apps: ['desk'] },
								grants: { docs: { read: true, approval: { create: [{ steps: [['reviewers']] }] } } }
							}
						}
					})
				);
				const context = yield* workspace({ manifest: source });
				const t = Context.get(context, TestWorkspace);
				const member = t.member(['clerk']);
				yield* t.db.write({
					text: 'UPDATE sys_user SET team = $2 WHERE id = $1',
					params: [member.id, 'clerks']
				});
				const caller = yield* new Authorities(source, 'inbox-ui').member(t.db, member.id);
				if (caller === null) throw new Error('Missing proposal requestor.');
				const { target } = yield* open(context, '/inbox', {}, undefined, undefined, true);
				yield* until(() => target.textContent?.includes('Nothing waits on you.') === true);
				const route = yield* routeFixture(context);
				const outcome = (yield* actReply(route, caller, {
					callable: 'docs.create',
					input: { title: 'A prospective document' },
					issuedAt: t.clock.now()
				})).outcome;
				if (outcome.kind !== 'pendingApproval') throw new Error('Expected a proposal.');
				yield* until(() => button(target, 'Supersede') !== undefined);
				expect(target.querySelector('[data-view=table]')?.textContent).toContain('New');
				expect(target.querySelector('[data-view=table]')?.textContent).not.toContain(
					'A prospective document'
				);
				expect(
					yield* Context.get(context, Approvals).process({
						requestId: outcome.requestId,
						status: 'WITHDRAWN',
						authority: caller,
						now: t.clock.now()
					})
				).toMatchObject({ kind: 'decided' });
				yield* until(() => target.textContent?.includes('Nothing waits on you.') === true);
				expect(button(target, 'Supersede')).toBeUndefined();
				expect((yield* t.db.read([{ text: 'SELECT id FROM docs', params: [] }]))[0]?.rows).toEqual(
					[]
				);
			})
		)
	);

	it.live(
		'the inbox requests changes through a labeled reason dialog and keeps the full reason',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					vi.stubGlobal('prompt', () => {
						throw new Error('Native prompts are not part of the approval flow.');
					});
					const source = Result.getOrThrow(
						decodeManifest({
							...manifest,
							teams: { clerks: ['clerk'], reviewers: [] },
							policies: {
								clerk: {
									description: 'Clerk',
									capabilities: { apps: ['desk'] },
									grants: {
										docs: { read: true, approval: { create: [{ steps: [['reviewers']] }] } }
									}
								}
							}
						})
					);
					const context = yield* workspace({ manifest: source });
					const t = Context.get(context, TestWorkspace);
					const member = t.member(['clerk']);
					const reviewer = t.member([]);
					for (const [id, team] of [
						[member.id, 'clerks'],
						[reviewer.id, 'reviewers']
					] as const) {
						yield* t.db.write({
							text: 'UPDATE sys_user SET team = $2 WHERE id = $1',
							params: [id, team]
						});
					}
					const caller = yield* new Authorities(source, 'inbox-reason-ui').member(t.db, member.id);
					if (caller === null) throw new Error('Missing proposal requester.');
					const route = yield* routeFixture(context);
					const outcome = (yield* actReply(route, caller, {
						callable: 'docs.create',
						input: { title: 'A prospective document' },
						issuedAt: t.clock.now()
					})).outcome;
					if (outcome.kind !== 'pendingApproval') throw new Error('Expected a proposal.');
					const { target } = yield* visit('/inbox', reviewer, { pages: {} }).pipe(
						Effect.provide(context)
					);
					yield* until(() => target.querySelector('[aria-label="More actions"]') !== null);
					press(present(target.querySelector<HTMLElement>('[aria-label="More actions"]')));
					yield* until(() => button(document.body, 'Request changes') !== undefined);
					press(present(button(document.body, 'Request changes')));
					yield* until(() => document.body.querySelector('[role=dialog] textarea') !== null);
					const note = present(
						document.body.querySelector<HTMLTextAreaElement>('[role=dialog] textarea')
					);
					const dialog = present(note.closest<HTMLElement>('[role=dialog]'));
					expect(dialog.querySelector('label')?.htmlFor).toBe(note.id);
					expect(present(button(dialog, 'Request changes')).disabled).toBe(true);
					note.value = 'Add the quote.\nInclude the installation date.';
					note.dispatchEvent(new Event('input', { bubbles: true }));
					present(dialog.querySelector<HTMLFormElement>('form')).requestSubmit();
					yield* until(() =>
						Effect.gen(function* () {
							return (
								(yield* t.db.read([
									{
										text: 'SELECT state FROM bolt_approvals WHERE id = $1',
										params: [outcome.requestId]
									}
								]))[0]?.rows[0]?.['state'] === 'ChangesRequested'
							);
						})
					);
					const [result] = yield* t.db.read([
						{
							text: "SELECT log->-1->>'reason' reason FROM bolt_approvals WHERE id = $1",
							params: [outcome.requestId]
						}
					]);
					expect(result?.rows[0]?.['reason']).toBe(
						'Add the quote.\nInclude the installation date.'
					);
					yield* until(() => document.body.querySelector('[role=dialog] textarea') === null);
				})
			)
	);

	it.live(
		'Settings → Automations renders declared file outputs with native downloads and keeps the result',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const source = Result.getOrThrow(
						decodeManifest({
							...manifest,
							automations: {
								package: {
									description: 'Build a delivery package',
									runAs: ['clerk'],
									output: {
										kind: 'object',
										fields: {
											delivery: {
												kind: 'object',
												fields: {
													documents: {
														kind: 'file',
														accept: ['application/octet-stream'],
														max: '1MiB',
														multiple: true
													}
												}
											},
											count: { kind: 'number' },
											notes: { kind: 'json' }
										}
									}
								}
							}
						})
					);
					const documents = [
						{ id: randomUUID(), name: 'delivery.zip', mime: 'application/octet-stream' },
						{ id: randomUUID(), name: 'register.bin', mime: 'application/octet-stream' }
					];
					const context = yield* workspace({ manifest: source });
					const t = Context.get(context, TestWorkspace);
					yield* t.db.write({
						text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, state, output)
							VALUES ('r-files', 'package', '{}', now(), 'manual', 0, 'succeeded', $1)`,
						params: [
							JSON.stringify({
								delivery: { documents },
								count: 2,
								notes: { id: randomUUID(), name: 'not-a-file.zip', mime: 'application/zip' }
							})
						]
					});
					yield* open(context, '/settings/automations?run=r-files', {});
					yield* until(
						() =>
							document.body.querySelectorAll('[data-run-output-files] [data-file-chip]').length ===
							2
					);
					const output = present(document.body.querySelector('[data-run-output-files]'));
					expect(output.textContent).toContain('delivery.zip');
					expect(output.textContent).toContain('register.bin');
					expect(output.textContent).not.toContain('not-a-file.zip');
					expect(
						[...document.body.querySelectorAll('[role=dialog] pre')].some((value) =>
							value.textContent?.includes('"count": 2')
						)
					).toBe(true);
					press(present(output.querySelector<HTMLElement>('[data-file-chip]')));
					yield* until(() => document.body.querySelector('a[download="delivery.zip"]') !== null);
					expect(
						document.body.querySelector('a[download="delivery.zip"]')?.getAttribute('href')
					).toBe(`/__bolt/files/${documents[0]?.id}`);
				})
			)
	);

	it.live(
		'Settings → Automations lists runs and a Stop failure survives the next list refresh',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* workspace({ manifest });
					const t = Context.get(context, TestWorkspace);
					yield* t.db.write({
						text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES ('r1', 'nightly', '{}', now(), 'schedule', 0)`,
						params: []
					});
					const { target } = yield* open(context, '/settings/automations', {});
					yield* until(
						() => target.querySelector('[data-view=table] [data-status=queued]') !== null
					);
					expect(present(target.querySelector('[data-view=table]')).textContent).toContain(
						'nightly'
					);
					expect(button(target, 'Stop')).toBeDefined();
					yield* t.db.write({ text: 'DELETE FROM sys_run WHERE id = $1', params: ['r1'] });
					press(present(button(target, 'Stop')));
					yield* until(
						() =>
							target
								.querySelector('[role=alert]')
								?.textContent?.includes('Not found or no access.') === true
					);
					yield* Effect.sleep('3 seconds');
					yield* until(() => target.textContent?.includes('No runs yet.') === true);
					expect(target.querySelector('[role=alert]')?.textContent).toContain(
						'Not found or no access.'
					);
				})
			)
	);

	it.live('Integrations issues an API key for a source team and shows the secret once', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* workspace({
					manifest: { ...manifest, teams: { api: { name: 'API access', policies: ['clerk'] } } }
				});
				const t = Context.get(context, TestWorkspace);
				const { target } = yield* open(context, '/settings/integrations', {});
				const keys = () =>
					[...target.querySelectorAll<HTMLElement>('[data-view=table]')].find((table) =>
						table.textContent?.includes('API keys')
					);
				yield* until(() => keys() !== undefined && button(present(keys()), 'New') !== undefined);
				const issue = button(present(keys()), 'New');
				if (issue === undefined) throw new Error('Missing key issuance action.');
				issue.click();
				yield* until(
					() => document.body.querySelector<HTMLInputElement>('[role=dialog] input') !== null
				);
				const name = present(document.body.querySelector<HTMLInputElement>('[role=dialog] input'));
				name.value = 'CI';
				name.dispatchEvent(new Event('input', { bubbles: true }));
				const team = document.body.querySelector<HTMLElement>(
					'[role=dialog] [role=combobox][aria-label=Team]'
				);
				if (team === null) throw new Error('Missing API-key source-team selector.');
				press(team);
				yield* until(
					() => document.body.querySelector('[role=option][data-value=api] button') !== null
				);
				const choice = document.body.querySelector<HTMLButtonElement>(
					'[role=option][data-value=api] button'
				);
				if (choice === null) throw new Error('Missing API source-team choice.');
				press(choice);
				yield* until(() => team.textContent?.trim() === 'API access');
				present(document.body.querySelector<HTMLFormElement>('[role=dialog] form')).requestSubmit();
				yield* until(() =>
					(document.body.querySelector('[role=dialog]')?.textContent ?? '').includes('nbk_')
				);
				yield* until(() =>
					[...target.querySelectorAll('[data-view=table]')].some((x) =>
						x.textContent?.includes('CI')
					)
				);
				const [key] = present(
					(yield* t.db.read([
						{ text: `SELECT name, team, revoked_at FROM sys_api_key`, params: [] }
					]))[0]
				).rows;
				expect(key).toMatchObject({ name: 'CI', team: 'api', revoked_at: null });
			})
		)
	);

	it.live('Settings creates an integration instance through its native collection form', () =>
		Effect.scoped(
			Effect.gen(function* () {
				vi.stubGlobal(
					'EventSource',
					class {
						onmessage = null;
						onerror = null;
						close() {}
					}
				);
				const context = yield* workspace({
					manifest: {
						...manifest,
						integrations: {
							erp: {
								description: 'ERP endpoint',
								driver: 'http',
								http: { baseUrl: 'https://erp.example' }
							}
						}
					}
				});
				const t = Context.get(context, TestWorkspace);
				const { target } = yield* open(context, '/settings/integrations', {});
				yield* until(() => target.querySelector('[data-integration-connections]') !== null);
				const connections = present(
					target.querySelector<HTMLElement>('[data-integration-connections]')
				);
				expect(connections.querySelector('[data-view=table]')).toBeNull();
				const create = button(connections, 'New connection');
				if (create === undefined) throw new Error('Missing instance creation action');
				create.click();
				yield* until(
					() =>
						document.body.querySelector(
							'[role=dialog] [role=combobox][aria-label="Integration definition"]'
						) !== null
				);
				const definition = document.body.querySelector<HTMLElement>(
					'[role=dialog] [role=combobox][aria-label="Integration definition"]'
				);
				if (definition === null) throw new Error('Missing definition selector');
				press(definition);
				yield* until(
					() => document.body.querySelector('[role=option][data-value=erp] button') !== null
				);
				const choice = document.body.querySelector<HTMLButtonElement>(
					'[role=option][data-value=erp] button'
				);
				if (choice === null) throw new Error('Missing source definition');
				press(choice);
				const dialog = document.body.querySelector('[role=dialog]');
				const name = dialog?.querySelector('[data-field=name] input');
				if (!(name instanceof HTMLInputElement)) throw new Error('Missing native name field');
				name.value = 'ERP account';
				name.dispatchEvent(new Event('input', { bubbles: true }));
				const form = dialog?.querySelector<HTMLFormElement>('form');
				if (form === null || form === undefined) throw new Error('Missing native creation form');
				form.requestSubmit();
				yield* until(() =>
					Effect.gen(function* () {
						return (
							(yield* t.db.read([
								{ text: 'SELECT name FROM sys_integration WHERE integration = $1', params: ['erp'] }
							]))[0]?.rows.length === 1
						);
					})
				);
				const [result] = yield* t.db.read([
					{
						text: 'SELECT name, integration, configuration, named, owner FROM sys_integration WHERE integration = $1',
						params: ['erp']
					}
				]);
				expect(result?.rows).toEqual([
					{ name: 'ERP account', integration: 'erp', configuration: {}, named: false, owner: null }
				]);
			})
		)
	);

	describe('Settings → Integrations over sys_integration', () => {
		const source = Result.getOrThrow(
			decodeManifest({
				...manifest,
				integrations: {
					erp: {
						description: 'ERP endpoint',
						driver: 'http',
						http: { baseUrl: 'https://erp.example' },
						configuration: {
							region: { kind: 'text', label: 'Region', help: 'The ledger region code' },
							lag: { kind: 'int', default: 15 }
						}
					}
				},
				connections: { desk: { integration: 'whatsapp' } },
				envoys: {
					service: {
						name: 'Service desk',
						audience: 'private',
						policies: ['clerk'],
						delegation: 'disabled',
						task: 'Answer.'
					}
				}
			})
		);
		/** A WhatsApp provider that pairs on `{ key }` and reports the key as the account. */
		const provider: Provider = {
			driver: 'whatsapp',
			id: 'fake',
			label: 'Fake WhatsApp',
			setup: {
				kind: 'form',
				steps: [{ text: 'Paste the key' }],
				fields: [{ name: 'key', label: 'Key', secret: true }]
			},
			async open(ctx) {
				return {
					async pair(input) {
						const key = Predicate.isObject(input) ? input['key'] : null;
						if (typeof key !== 'string') throw new Error('a key is required');
						await ctx.credentials.write(new Map([['credential', { key }]]));
						await ctx.status({ state: 'connected', account: key });
					},
					async unpair() {
						logouts++;
					},
					async close() {}
				};
			}
		};
		/** How often the provider was asked to forget this host (a linked device logging out). */
		let logouts = 0;
		const boot = () =>
			Effect.gen(function* () {
				vi.stubGlobal(
					'EventSource',
					class {
						onmessage = null;
						onerror = null;
						close() {}
					}
				);
				const context = yield* workspace({
					manifest: source,
					secretsKey: Redacted.make(randomBytes(32))
				});
				const t = Context.get(context, TestWorkspace);
				const manager = yield* integrationLinks({
					providers: [provider],
					enter: (work) => work.pipe(Effect.provide(context)),
					credentials: yield* credentials(t.db, Context.get(context, Secrets)).pipe(
						Effect.provide(NodeCrypto.layer)
					),
					publicUrl: ORIGIN
				}).pipe(Effect.provide(NodeCrypto.layer));
				yield* t.db.write({
					text: `INSERT INTO sys_user (id, email, name, kind) VALUES ('u2', 'bo@x.test', 'Bo', 'staff')`,
					params: []
				});
				const erp = yield* t.as(t.admin).act('sys_integration.create', {
					integration: 'erp',
					name: 'Ledger',
					configuration: { region: 'sg' }
				});
				const user = yield* t.storedRead('sys_user', {
					where: { email: { eq: 'bo@x.test' } },
					all: true
				});
				const owner = present(user.rows[0]).id;
				const phone = yield* t.as(t.admin).act('sys_integration.create', {
					integration: 'whatsapp',
					name: 'Bo’s phone',
					owner
				});
				if (erp.kind !== 'committed' || phone.kind !== 'committed')
					throw new Error('instances were not created');
				return { t, context, manager, erp: present(erp.records[0]).id };
			});
		const instances = (target: HTMLElement) =>
			target.querySelector<HTMLElement>('[data-integration-connections] [data-view=table]') ??
			undefined;
		// happy-dom lays out no rows of the virtual wide table, so the row is its card
		const row = (target: HTMLElement, name: string) =>
			[...(instances(target)?.querySelectorAll<HTMLElement>('[data-row-card]') ?? [])].find((x) =>
				x.textContent?.includes(name)
			);
		const sheet = () => [...document.body.querySelectorAll<HTMLElement>('[role=dialog]')].at(-1);
		const fields = () => sheet()?.querySelector('[data-field=name]')?.closest('form') ?? undefined;
		const tab = (name: string) =>
			[...(sheet()?.querySelectorAll<HTMLElement>('[role=tab]') ?? [])].find(
				(x) => x.textContent?.trim() === name
			);
		const instance = (t: Kit, id: string) =>
			t.db
				.read([
					{
						text: 'SELECT name, envoy, active, configuration, status FROM sys_integration WHERE id = $1',
						params: [id]
					}
				])
				.pipe(Effect.map((results) => present(results[0]).rows[0]));

		it.live(
			'lists each connection once and manages a named agent channel through the same sheet',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { t, context, manager } = yield* boot();
						const { target } = yield* open(
							context,
							'/settings/integrations',
							{},
							undefined,
							undefined,
							true,
							false,
							manager
						);
						yield* until(
							() =>
								row(target, 'Bo’s phone') !== undefined &&
								row(target, 'desk') !== undefined &&
								row(target, 'Ledger') !== undefined
						);
						expect(present(row(target, 'Bo’s phone')).textContent).toContain('Bo'); // used by: the member whose own account it is
						expect(present(row(target, 'desk')).textContent).toContain('Not paired');
						expect(present(row(target, 'Ledger')).textContent).toContain('erp'); // each instance names its definition
						present(row(target, 'desk')).click();
						// a named connection is the source's: no Delete
						yield* until(
							() =>
								sheet()?.querySelector('[data-setup-form]') !== null &&
								sheet()?.querySelector('[data-setup-form]') !== undefined
						);
						expect(button(present(sheet()), 'Delete')).toBeUndefined();
						expect(present(sheet()).textContent).toContain('Fake WhatsApp');
						const key = present(
							present(sheet()).querySelector<HTMLInputElement>('[data-setup-form] input[name=key]')
						);
						expect(key.type).toBe('password');
						key.value = 'k1';
						key.dispatchEvent(new Event('input', { bubbles: true }));
						present(
							present(sheet()).querySelector<HTMLFormElement>('[data-setup-form]')
						).requestSubmit();
						yield* until(
							() =>
								sheet()?.querySelector('[data-connection-state]')?.textContent === 'Connected as k1'
						);
						expect(yield* instance(t, 'desk')).toMatchObject({
							status: { state: 'connected', account: 'k1' }
						});
						expect(button(present(sheet()), 'Test connection')).toBeUndefined(); // the provider offers no test message
						press(present(tab('Configuration')));
						yield* until(
							() =>
								sheet()?.querySelector('[role=combobox][aria-label=Envoy]') !== null &&
								sheet()?.querySelector('[role=combobox][aria-label=Envoy]') !== undefined
						);
						press(
							present(
								present(sheet()).querySelector<HTMLElement>('[role=combobox][aria-label=Envoy]')
							)
						);
						yield* until(
							() => document.body.querySelector('[role=option][data-value=service] button') !== null
						);
						press(
							present(
								document.body.querySelector<HTMLButtonElement>(
									'[role=option][data-value=service] button'
								)
							)
						);
						present(fields()).requestSubmit();
						yield* until(() =>
							Effect.gen(function* () {
								return (yield* instance(t, 'desk'))?.['envoy'] === 'service';
							})
						);
						yield* until(() => row(target, 'desk') === undefined);
						const channels = present(target.querySelector<HTMLElement>('[data-envoys]'));
						expect(channels.textContent).toContain('Agent channels');
						expect(channels.textContent).toContain('Service desk');
						expect(instances(target)?.textContent).toContain('Other connections');
						expect(channels.querySelectorAll('[data-connector=whatsapp]')).toHaveLength(1);
						const backup = yield* t.as(t.admin).act('sys_integration.create', {
							integration: 'whatsapp',
							name: 'Backup line',
							envoy: 'service'
						});
						if (backup.kind !== 'committed') throw new Error('Backup channel was not created.');
						yield* until(() => channels.querySelectorAll('[data-envoy-channel]').length === 2);
						expect(channels.textContent).toContain('Backup line');
						expect(channels.querySelectorAll('[data-connector=whatsapp]')).toHaveLength(2);
						expect(row(target, 'Backup line')).toBeUndefined();
						press(present(present(sheet()).querySelector<HTMLElement>('[data-sheet-close]')));
						yield* until(() => sheet() === undefined);
						press(
							present(
								channels.querySelector<HTMLElement>('[data-envoy-channel=desk] [data-settings]')
							)
						);
						yield* until(() => tab('Configuration') !== undefined && tab('Messages') !== undefined);
						expect(present(sheet()).textContent).toContain('desk');
						expect(button(present(sheet()), 'Delete')).toBeUndefined();
						// the channel's card owns its connection: the sheet does not draw a second one
						expect(tab('Connection')).toBeUndefined();
					})
				)
		);

		it.live(
			"an agent channel's Disconnect asks in-app, logs the provider out, drops the credentials and shows Not paired",
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { t, context, manager } = yield* boot();
						// a WebView answers `window.confirm` false at once; the card must not depend on it
						const native = vi.fn(() => false);
						vi.stubGlobal('confirm', native);
						logouts = 0;
						yield* t.db.write({
							text: `UPDATE sys_integration SET envoy = 'service' WHERE id = 'desk'`,
							params: []
						});
						yield* manager.pair('desk', { key: 'k1' });
						const { target } = yield* open(
							context,
							'/settings/integrations',
							{},
							undefined,
							undefined,
							true,
							false,
							manager
						);
						const card = () =>
							target.querySelector<HTMLElement>('[data-envoy-channel=desk] [data-connector]') ??
							undefined;
						const state = () =>
							card()?.querySelector('[data-connector-state]')?.textContent?.trim();
						yield* until(() => state() === 'Connected as k1');
						expect(card()?.textContent?.match(/k1/g)).toHaveLength(1); // the account once
						press(present(card()?.querySelector<HTMLElement>('[data-disconnect]')));
						yield* until(() => document.body.querySelector('[data-confirm-dialog]') !== null);
						expect(logouts).toBe(0); // nothing happens before the answer
						press(present(document.body.querySelector<HTMLElement>('[data-confirm-accept]')));
						yield* until(() => state() === 'Not paired');
						expect(logouts).toBe(1);
						expect(native).not.toHaveBeenCalled();
						expect(yield* instance(t, 'desk')).toMatchObject({
							status: { state: 'unpaired', account: null }
						});
						const [stored] = yield* t.db.read([
							{ text: 'SELECT name FROM bolt_credential WHERE instance = $1', params: ['desk'] }
						]);
						expect(present(stored).rows).toEqual([]);
						expect(card()?.querySelector('[data-connect]')).not.toBeNull();
					})
				)
		);

		it.live(
			"saves an instance's configuration by its definition's fields, pauses it, and deletes one made here",
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { t, context, manager, erp } = yield* boot();
						const { target } = yield* open(
							context,
							'/settings/integrations',
							{},
							undefined,
							undefined,
							true,
							false,
							manager
						);
						yield* until(() => row(target, 'Ledger') !== undefined);
						present(row(target, 'Ledger')).click();
						yield* until(() => tab('Configuration') !== undefined);
						expect(tab('Messages')).toBeUndefined(); // an http instance carries no conversation
						press(present(tab('Configuration')));
						yield* until(
							() =>
								sheet()?.querySelector('[data-field=configuration]') !== null &&
								sheet()?.querySelector('[data-field=configuration]') !== undefined
						);
						const field = present(
							present(sheet()).querySelector<HTMLElement>('[data-field=configuration]')
						);
						expect(field.textContent).toContain('Region');
						expect(field.textContent).toContain('The ledger region code'); // a field's help, as every form shows it
						expect(present(sheet()).querySelector('[role=combobox][aria-label=Envoy]')).toBeNull(); // no envoy answers an http instance
						const region = present(field.querySelector<HTMLInputElement>('input[id$=-region]'));
						expect(region.value).toBe('sg');
						// the stored configuration, its default filled when the instance was made: nothing shown that is not stored
						expect(present(field.querySelector<HTMLInputElement>('input[id$=-lag]')).value).toBe(
							'15'
						);
						region.value = 'my';
						region.dispatchEvent(new Event('input', { bubbles: true }));
						const active = present(
							present(sheet()).querySelector<HTMLElement>(
								'[data-field=active] [role=checkbox], [data-field=active] input[type=checkbox]'
							)
						);
						press(active);
						present(fields()).requestSubmit();

						yield* until(() =>
							Effect.gen(function* () {
								return (yield* instance(t, erp))?.['active'] === false;
							})
						);
						expect(yield* instance(t, erp)).toMatchObject({
							active: false,
							configuration: { region: 'my', lag: 15 }
						});
						yield* until(
							() => row(target, 'Ledger')?.textContent?.includes('Paused') === true,
							200
						);
						press(present(button(present(sheet()), 'Delete')));
						yield* until(() => document.body.querySelector('[data-confirm-accept]') !== null);
						press(present(document.body.querySelector<HTMLElement>('[data-confirm-accept]')));
						yield* until(() =>
							Effect.gen(function* () {
								return (
									present(
										(yield* t.db.read([
											{ text: 'SELECT id FROM sys_integration WHERE id = $1', params: [erp] }
										]))[0]
									).rows.length === 0
								);
							})
						);
						yield* until(() => row(target, 'Ledger') === undefined);
					})
				)
		);
	});

	it.live(
		'Settings → People reads a role by its label and a last-seen instant without seconds',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* workspace({ manifest });
					const t = Context.get(context, TestWorkspace);
					yield* t.db.write({
						text: `INSERT INTO sys_user (id, email, name, kind) VALUES ('u2', 'bo@x.test', 'Bo', 'external')`,
						params: []
					});
					const { target } = yield* open(
						context,
						'/settings/people',
						{},
						undefined,
						undefined,
						true
					);
					yield* until(() =>
						(target.querySelector('[data-view=table]')?.textContent ?? '').includes('Bo')
					);
					const text = present(present(target.querySelector('[data-view=table]')).textContent);
					expect(text).toContain('Staff');
					expect(text).toContain('External');
					expect(text).not.toMatch(/\bstaff\b|\bexternal\b/);
					expect(text).toContain(String(new Date(yield* Clock.currentTimeMillis).getFullYear())); // Ada's session: her last-seen time is drawn
					expect(text).not.toMatch(/\d:\d\d:\d\d/);
				})
			)
	);

	it.live('Settings → People invites a batch from the system collection table', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* workspace({ manifest });
				const t = Context.get(context, TestWorkspace);
				const { target } = yield* open(context, '/settings/people', {}, undefined, undefined, true);
				yield* until(() => button(target, 'New') !== undefined);
				present(button(target, 'New')).click();
				yield* until(
					() => document.body.querySelector<HTMLTextAreaElement>('[role=dialog] textarea') !== null
				);
				const addresses = present(
					document.body.querySelector<HTMLTextAreaElement>('[role=dialog] textarea')
				);
				addresses.value = 'bulk-one@example.com\nbulk-two@example.com';
				addresses.dispatchEvent(new Event('input', { bubbles: true }));
				yield* tick;
				present(document.body.querySelector<HTMLFormElement>('[role=dialog] form')).requestSubmit();
				yield* until(() =>
					Effect.gen(function* () {
						return (
							present(
								(yield* t.db.read([{ text: 'SELECT id FROM sys_invitation', params: [] }]))[0]
							).rows.length === 2
						);
					})
				);
				yield* until(() => document.body.querySelector('[role=dialog]') === null);
			})
		)
	);

	it.live(
		'People has no access-definition editors and invites into source-defined team choices',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* workspace({
						manifest: {
							...manifest,
							teams: {
								ops: { name: 'Operations', policies: ['clerk'] },
								hr: { name: 'HR', parent: 'ops', policies: [] }
							}
						}
					});
					const t = Context.get(context, TestWorkspace);
					const { target } = yield* open(
						context,
						'/settings/people',
						{},
						undefined,
						undefined,
						true
					);
					yield* until(() => button(target, 'New') !== undefined);
					expect(
						[...target.querySelectorAll('[role=tab]')].map((tab) => tab.textContent?.trim())
					).toEqual(['Members', 'Invitations']);
					expect(button(target, 'Create team')).toBeUndefined();
					expect(target.querySelector('.svelte-flow')).toBeNull();
					const invite = button(target, 'New');
					if (invite === undefined) throw new Error('Missing invitation action.');
					invite.click();
					yield* until(
						() =>
							document.body.querySelector('[role=dialog] [role=combobox][aria-label=Team]') !== null
					);
					const team = document.body.querySelector<HTMLElement>(
						'[role=dialog] [role=combobox][aria-label=Team]'
					);
					if (team === null) throw new Error('Missing source-team selector.');
					press(team);
					yield* until(() => document.body.querySelector('[role=option]') !== null);
					const choices = [...document.body.querySelectorAll<HTMLElement>('[role=option]')];
					expect(choices.map((choice) => choice.textContent?.trim())).toEqual(['HR', 'Operations']);
					const operation = choices
						.find((choice) => choice.textContent?.trim() === 'Operations')
						?.querySelector<HTMLButtonElement>('button');
					if (operation === null || operation === undefined)
						throw new Error('Missing Operations choice.');
					press(operation);
					yield* until(() => team.textContent?.trim() === 'Operations');
					const email = document.body.querySelector<HTMLInputElement>(
						'[role=dialog] input[type=email]'
					);
					if (email === null) throw new Error('Missing invitation email.');
					email.value = 'team-member@example.com';
					email.dispatchEvent(new Event('input', { bubbles: true }));
					yield* tick;
					const form = document.body.querySelector<HTMLFormElement>('[role=dialog] form');
					if (form === null) throw new Error('Missing invitation form.');
					form.requestSubmit();
					yield* until(() =>
						Effect.gen(function* () {
							return (
								(yield* t.db.read([
									{
										text: "SELECT team FROM sys_invitation WHERE email = 'team-member@example.com'",
										params: []
									}
								]))[0]?.rows.length === 1
							);
						})
					);
					expect(
						(yield* t.db.read([
							{
								text: "SELECT team FROM sys_invitation WHERE email = 'team-member@example.com'",
								params: []
							}
						]))[0]?.rows
					).toEqual([{ team: 'ops' }]);
				})
			)
	);
});

describe('workspace boot error recovery', () => {
	it.live(
		'names the workspace before boot and retains its access card and footer when boot arrives',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const boot = yield* Deferred.make<void>();
					const fetch: typeof globalThis.fetch = async (input) => {
						const url = new URL(
							typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
							ORIGIN
						);
						if (url.pathname === '/__bolt/session/methods')
							return Response.json({
								value: { email: true, phone: false, whatsapp: false, signup: [], locale: 'en' }
							});
						await Effect.runPromise(Deferred.await(boot));
						return Response.json(
							{
								error: {
									code: 'unauthenticated',
									message: 'Sign in first.',
									workspace: {
										name: 'Acme',
										handle: 'acme',
										locale: 'en',
										tz: 'UTC',
										apex: '/workspaces'
									}
								}
							},
							{ status: 401 }
						);
					};
					const target = yield* mountAt('/sign-in', {
						manifest,
						workspaceName: 'Acme',
						pages: {},
						fetch
					});
					yield* until(() => target.querySelector('#bolt-email') !== null);
					const panel = target.querySelector('.access-panel');
					const identity = target.querySelector('.access-sign-in > header');
					const footer = target.querySelector('.access-switch');
					expect(identity?.textContent).toContain('Acme');
					expect(footer).not.toBeNull();
					expect(footer?.querySelector('a')).toBeNull();
					yield* Deferred.succeed(boot, undefined);
					yield* until(() => target.querySelector('.access-switch a') !== null);
					expect(target.querySelector('.access-panel')).toBe(panel);
					expect(target.querySelector('.access-sign-in > header')).toBe(identity);
					expect(target.querySelector('.access-switch')).toBe(footer);
				})
			)
	);

	for (const status of [403, 404, 429, 500, 503])
		it.live(`shows the reason and retry control for HTTP ${status}`, () =>
			Effect.scoped(
				Effect.gen(function* () {
					const target = yield* mountAt('/app/desk/hero', {
						manifest,
						pages: {},
						fetch: async () => new Response('proxy error', { status })
					});
					yield* until(() => target.querySelector('[role=alert]') !== null);
					expect(target.textContent).toContain(`HTTP ${status}`);
					expect(target.textContent).toContain('Unable to open the workspace');
					expect(target.textContent).not.toContain('could not be reached');
					expect(
						[...target.querySelectorAll('button')].some((button) =>
							button.textContent?.includes('Try again')
						)
					).toBe(true);
				})
			)
		);

	it.live('a signed-out /sign-in keeps the access card, not the workspace-failure screen', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const workspace = { name: 'Acme', handle: 'acme', locale: 'en', tz: 'UTC' };
				const fetch: typeof globalThis.fetch = async (input) => {
					const url = new URL(
						typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
						ORIGIN
					);
					if (url.pathname === '/__bolt/session/methods') {
						return new Response(
							JSON.stringify({
								value: { email: true, phone: false, whatsapp: false, signup: [], locale: 'en' }
							}),
							{
								status: 200,
								headers: { 'content-type': 'application/json' }
							}
						);
					}
					return new Response(
						JSON.stringify({
							error: { code: 'unauthenticated', message: 'Sign in first.', workspace }
						}),
						{
							status: 401,
							headers: { 'content-type': 'application/json' }
						}
					);
				};
				const target = yield* mountAt('/sign-in', { manifest, pages: {}, fetch });
				// The real form is present before boot; this assertion needs the signed-out boot's metadata.
				yield* until(
					() =>
						target
							.querySelector('.access-sign-in > header')
							?.textContent?.includes(workspace.name) === true
				);
				expect(target.querySelector('#bolt-email')).not.toBeNull();
				expect(target.textContent).not.toContain('Unable to open the workspace');
				expect(target.textContent).toContain('Sign in');
				expect(target.textContent).toContain('Acme');
			})
		)
	);
});
