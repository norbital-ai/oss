// @vitest-environment happy-dom
// The real workspace shell over the handler and a test-kit workspace on PGlite (§5.10): control interactions,
// route lifetimes, authorization, and file uploads that settle before form submission.
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
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
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
import { visit } from '../src/test/browser.ts';
import {
	KitInvalid,
	TestWorkspace,
	type Kit,
	type TestOptions,
	type WorkspaceServices
} from '../src/test/index.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import { program } from './support/guest-fixture.ts';
import { sse } from './support/live-bolt.ts';
import Hero from './support/shell-hero.svelte';
import Upload from './support/shell-upload.svelte';
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
		exposures: {
			docs: { read: { docs: { fields: 'all' } }, create: { columns: { docs: ['title', 'scan'] } } }
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
afterEach(() => {
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
				host: { workspace: () => ({ name: 'Acme', handle: 'acme' }), ...options.host }
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
		"a preview opened outside its frame goes to the live workspace's Studio; framed, it renders",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
					yield* Effect.addFinalizer(() => Effect.sync(() => replace.mockRestore()));
					const context = yield* workspace({ manifest, host: { live: 'https://h.test/acme' } });
					const { target } = yield* open(context, '/app/desk/hero', { 'desk/hero': page(Hero) });
					yield* until(() => replace.mock.calls.length > 0);
					expect(replace).toHaveBeenCalledWith('https://h.test/acme/studio');
					expect(target.querySelector('[data-body]')).toBeNull();
					// Norbius's own browser marks its view of a preview: it sees the page itself
					const { target: framed } = yield* open(context, '/app/desk/hero?frame', {
						'desk/hero': page(Hero)
					});
					yield* until(() => framed.querySelector('[data-body]') !== null);
					expect(replace).toHaveBeenCalledTimes(1);
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
		'a generated form uploads a file to <model>.<field>, and its submit waits for the upload',
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
		"the page's own AppShell carries its scope when no view of the model is on screen",
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
					drag(100);
					yield* until(() => sheet() === null);
				})
			)
	);
});

describe("system models render in ui's Table (Settings, Automations, Inbox)", () => {
	const approvalGuest = program(`export default { policy: { clerk: { grants: { docs: {
		create: { check: function* (_, ctx) { return ctx.approve((flow) => flow.step('Review', {teams:['reviewers']})); } }
	} } } } };`);
	const button = (root: ParentNode, text: string) =>
		[...root.querySelectorAll<HTMLButtonElement>('button')].find(
			(b) => b.textContent?.trim() === text
		);
	const press = (b: HTMLElement) => {
		b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
		b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
		b.click();
	};

	it.live('the inbox follows a request submitted and rejected in another session', () =>
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
								grants: { docs: { read: true, create: { check: true } } }
							}
						}
					})
				);
				const context = yield* workspace({ manifest: source, guest: yield* approvalGuest });
				const t = Context.get(context, TestWorkspace);
				const member = t.member(['clerk']);
				yield* t.db.write({
					text: 'UPDATE sys_user SET team = $2 WHERE id = $1',
					params: [member.id, 'clerks']
				});
				const caller = yield* new Authorities(source, 'inbox-ui').member(t.db, member.id);
				if (caller === null) throw new Error('Missing proposal requestor.');
				const { target } = yield* open(context, '/inbox', {}, undefined, undefined, true);
				yield* until(() => target.textContent?.includes('No approvals yet') === true);
				const route = yield* routeFixture(context);
				const outcome = (yield* actReply(route, caller, {
					callable: 'docs.create',
					input: [{ title: 'A prospective document' }],
					issuedAt: t.clock.now()
				})).outcome;
				if (outcome.kind !== 'pendingApproval') throw new Error('Expected a proposal.');
				yield* until(() => button(target, 'Approve') !== undefined);
				expect(target.querySelector('[data-view=table]')?.textContent).toContain('New');
				expect(target.querySelector('[data-view=table]')?.textContent).not.toContain(
					'A prospective document'
				);
				expect(
					yield* Context.get(context, Approvals).decide({
						requestId: outcome.requestId,
						decision: 'reject',
						reason: 'No longer needed.',
						authority: t.as(t.admin).authority,
						now: t.clock.now()
					})
				).toMatchObject({ kind: 'decided' });
				yield* until(() => target.textContent?.includes('No approvals yet') === true);
				expect(button(target, 'Approve')).toBeUndefined();
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
										docs: { read: true, create: { check: true } }
									}
								}
							}
						})
					);
					const context = yield* workspace({ manifest: source, guest: yield* approvalGuest });
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
						input: [{ title: 'A prospective document' }],
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
					const result = present(
						document.body.querySelector('[data-detail-field="Result"] [data-detail-structured]')
					);
					expect(result.textContent).toContain('Count');
					expect(result.textContent).toContain('2');
					expect(result.querySelector('pre')).toBeNull();
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
				const tab = (name: string) =>
					[...target.querySelectorAll<HTMLElement>('[role=tab]')].find(
						(x) => x.textContent?.trim() === name
					);
				yield* until(() => tab('API keys') !== undefined);
				press(present(tab('API keys')));
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
					admit: (work) => work.pipe(Effect.provide(context)),
					credentials: yield* credentials(t.db, Context.get(context, Secrets)).pipe(
						Effect.provide(NodeCrypto.layer)
					),
					publicUrl: ORIGIN
				}).pipe(Effect.provide(NodeCrypto.layer));
				yield* t.db.write({
					text: `INSERT INTO sys_user (id, email, name, kind) VALUES ('u2', 'bo@x.test', 'Bo', 'staff')`,
					params: []
				});
				const erp = yield* t.as(t.admin).act('sys_integration.create', [{
					integration: 'erp',
					name: 'Ledger',
					configuration: { region: 'sg' }
				}]);
				const { sys_user } = yield* t.storedQuery({
					sys_user: { where: { email: { eq: 'bo@x.test' } } }
				});
				const owner = present(sys_user.rows[0]).id;
				const phone = yield* t.as(t.admin).act('sys_integration.create', [{
					integration: 'whatsapp',
					name: 'Bo’s phone',
					owner
				}]);
				if (erp.kind !== 'committed' || phone.kind !== 'committed')
					throw new Error('instances were not created');
				return { t, context, manager };
			});
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
						const row = () =>
							target.querySelector<HTMLElement>('[data-envoy-channel=service]') ?? undefined;
						const card = () =>
							[...document.body.querySelectorAll<HTMLElement>('[role=dialog]')]
								.at(-1)
								?.querySelector<HTMLElement>('[data-connector]') ?? undefined;
						const state = () =>
							card()?.querySelector('[data-connector-state]')?.textContent?.trim();
						yield* until(() => row() !== undefined);
						press(present(row()?.closest('tr') ?? undefined));
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

	it.live('Settings → People invites a batch from the system model table', () =>
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
