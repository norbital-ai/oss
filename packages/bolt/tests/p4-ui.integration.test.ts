// @vitest-environment happy-dom
// P4 and G5 in a DOM over the real handler and a test-kit workspace on PGlite: the shell's in-app agent panel (post,
// confirmation card, live settle, receipts); public SSR caller scope; the location picker with zero providers;
// Table paging and count; a 50-row Matrix page of a
// month within 300 KiB.
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { describe, expect, it } from '@effect/vitest';
import {
	Cause,
	Context,
	Effect,
	Fiber,
	FiberSet,
	FileSystem,
	Layer,
	ManagedRuntime,
	Result,
	Schema,
	Stream
} from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { Sse } from 'effect/encoding';
import type { Json } from '../src/decl/values.ts';
import { createBolt } from '../src/page/bolt.ts';
import type { EventSourceLike } from '../src/page/stream.ts';
import type { AiResponse } from '../src/engine/contracts.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { routeFixture } from './support/route-fixture.ts';
import { program } from './support/guest-fixture.ts';
import { PATHS } from '../src/protocol/wire.ts';
import { AgentRow } from '../src/protocol/schema.ts';
import Agent from '../src/shell/agent/Agent.svelte';
import { liveBolt } from './support/live-bolt.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { visit } from '../src/test/browser.ts';
import { KitInvalid, TestWorkspace, type TestOptions } from '../src/test/index.ts';
import { check } from '../src/compiler/check/index.ts';
import { discover } from '../src/compiler/discover.ts';
import { writeArtifact } from '../src/compiler/artifact/index.ts';
import { readArtifact } from '../src/engine/artifact/read.ts';
import { scratchRoot } from '../../../scripts/lib/scratch.ts';
import {
	DEFAULT_BASEMAP,
	photonGeocoder as DEFAULT_GEOCODER,
	type KindsHost
} from '@norbital-ai/ui';
import Point from './support/p4-point.svelte';
import Views from './support/p4-views.svelte';
import PublicData from './support/p4-public.page.data.ts';

const required = <T>(value: T | null | undefined): T => {
	if (value === null || value === undefined) throw new Error('fixture element missing');
	return value;
};
const show = <P extends Record<string, unknown>>(component: Component<P>, props: P) =>
	Effect.gen(function* () {
		yield* Effect.acquireRelease(
			Effect.sync(() => mountEdge(ManagedRuntime.make(Layer.empty))),
			(dispose) =>
				Effect.tryPromise({
					try: dispose,
					catch: (error) => new KitInvalid({ message: String(error) })
				}).pipe(Effect.orDie)
		);
		const target = yield* Effect.acquireRelease(
			Effect.sync(() => {
				const node = document.createElement('div');
				document.body.append(node);
				return node;
			}),
			(node) => Effect.sync(() => node.remove())
		);
		yield* Effect.acquireRelease(
			// Synthetic events follow the component's attachment setup, as browser interaction does.
			Effect.sync(() => flushSync(() => mount(component, { target, props }))),
			(view) =>
				Effect.tryPromise({
					try: () => unmount(view),
					catch: (error) => new KitInvalid({ message: String(error) })
				}).pipe(Effect.orDie)
		);
		return target;
	});
const tick = Effect.sleep('5 millis').pipe(Effect.tap(() => Effect.sync(() => flushSync())));
const until = (ok: () => boolean, n = 600) =>
	Effect.gen(function* () {
		for (let i = 0; i < n && !ok(); i++) yield* tick;
		expect(ok()).toBe(true);
	});
const sse = (fetch: (url: string) => Effect.Effect<Response>, bytes: { n: number }) =>
	Effect.gen(function* () {
		const run = yield* FiberSet.makeRuntime<never, void, never>();
		return (url: string): EventSourceLike => {
			let closed = false;
			const source: EventSourceLike = {
				onmessage: null,
				onerror: null,
				close: () => {
					closed = true;
					run(Fiber.interrupt(fiber));
				}
			};
			const fiber = run(
				Effect.gen(function* () {
					const response = yield* fetch(url);
					if (response.body === null) throw new Error('live response has no body');
					const body = response.body;
					yield* Stream.fromReadableStream({
						evaluate: () => body,
						onError: (error) => new KitInvalid({ message: String(error) })
					}).pipe(
						Stream.tap((chunk) =>
							Effect.sync(() => {
								bytes.n += chunk.byteLength;
							})
						),
						Stream.decodeText(),
						Stream.pipeThroughChannel(Sse.decode()),
						Stream.runForEach((event) =>
							Effect.sync(() => {
								if (!closed && event.data !== '')
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
				)
			);
			return source;
		};
	});
const fetchFor = (
	route: Effect.Success<ReturnType<typeof routeFixture>>,
	authority: import('../src/engine/contracts.ts').Authority
) =>
	Effect.gen(function* () {
		const run = yield* FiberSet.makeRuntimePromise();
		const fetch: typeof globalThis.fetch = (input, init) => {
			const url = new URL(
				typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
				'http://cell'
			);
			const request = new Request(url, input instanceof Request ? input : init);
			return run(route.handle(authority, request), { signal: request.signal });
		};
		return fetch;
	});

describe('the in-app agent panel (§5.9)', () => {
	it.live(
		'posts, confirms an automation start, and shows its queued receipt before the run executes',
		() =>
			Effect.gen(function* () {
				const manifest = Result.getOrThrow(
					decodeManifest({
						workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
						models: {
							quotes: {
								description: 'A quote',
								label: 'title',
								fields: { title: { kind: 'text' } }
							}
						},
						relationships: {},
						exposures: {
							quotes: {
								read: { quotes: { fields: 'all' } },
								create: { columns: { quotes: ['title'] } }
							}
						},
						policies: {
							rep: {
								description: 'Rep',
								grants: { quotes: { read: true, create: true } },
								automations: ['quotes_mark']
							}
						},
						agent: { internal: 'Staff brief.', skills: {} },
						integrations: {},
						teams: { rep: ['rep'] },
						automations: {
							quotes_mark: {
								description: 'Mark a quote',
								input: { title: { kind: 'text' } },
								output: { kind: 'text' },
								runAs: 'trigger',
								agent: 'confirm'
							}
						},
						connections: {},
						envoys: {},
						mcp: {},
						apps: {},
						customFields: {}
					})
				);
				const guest = {
					source: `export default { automation: { quotes_mark: { body: function* (input, ctx) {
						return (yield* ctx.act('quotes.create', [{ title: input.title }])).records[0].id;
					} } } };`
				};
				const steps: (() => AiResponse)[] = [
					() => ({
						content: '',
						toolCalls: [
							{
								id: 'k1',
								name: 'act',
								input: { callable: 'automation.quotes_mark', input: { title: 'Chair' } }
							}
						],
						finish: 'tool',
						usage: { input: 10, output: 5 }
					}),
					() => ({
						content: 'Marked the chair.',
						toolCalls: [],
						finish: 'stop',
						usage: { input: 10, output: 5 }
					})
				];
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest,
						guest: yield* program(guest.source),
						fakes: { ai: { cassette: { default: steps.map((step) => step()) } } }
					})
				);
				const t = Context.get(context, TestWorkspace);
				yield* t.db.write({
					text: `INSERT INTO sys_user (id, email, name) VALUES ('ann', 'ann@x.test', 'Ann')`,
					params: []
				});
				yield* t.db.write({
					text: `UPDATE sys_user SET team = 'rep', revision = revision + 1 WHERE id = 'ann'`,
					params: []
				});
				const ann = yield* new Authorities(manifest, 'test').member(t.db, 'ann');
				if (ann === null) throw new Error('member authority missing');
				const handle = yield* routeFixture(context),
					fetch = yield* fetchFor(handle, ann);
				const target = yield* show(Agent, {
					api: shellApi(fetch),
					bolt: yield* liveBolt(fetch),
					t: (key: string) => key,
					request: { prompt: 'mark a chair' },
					onClose: () => {}
				});
				required(target.querySelector<HTMLButtonElement>('button[type="submit"]')).click();
				yield* until(() => target.querySelector('[data-role="confirm"]') !== null);
				expect(target.querySelector('[data-role="user"] [data-text]')?.textContent).toBe(
					'mark a chair'
				);
				required(
					[...target.querySelectorAll<HTMLButtonElement>('[data-role="confirm"] button')].find(
						(b) => b.textContent?.trim() === 'Approve'
					)
				).click();
				yield* until(() =>
					(target.querySelector('[data-role="assistant"]')?.textContent ?? '').includes(
						'Marked the chair.'
					)
				).pipe(
					Effect.catchCause((cause) =>
						Effect.die(new Error(target.textContent ?? 'Empty agent panel', { cause }))
					)
				);
				expect(target.querySelector('[data-role="confirm"]')).toBeNull();
				yield* handle.settled;
				expect(
					yield* t.db.rows(
						Schema.Struct({ automation: Schema.String, input: Schema.Json, state: Schema.String }),
						{
							text: "SELECT automation, input, state FROM sys_run WHERE automation = 'quotes_mark'",
							params: []
						}
					)
				).toEqual([{ automation: 'quotes_mark', input: { title: 'Chair' }, state: 'queued' }]);
				expect(
					yield* t.db.rows(Schema.Struct({ receipts: AgentRow.fields.receipts }), {
						text: "SELECT meta->'receipts' AS receipts FROM sys_message WHERE role='assistant' AND meta->>'tag'='reply'",
						params: []
					})
				).toMatchObject([
					{ receipts: [{ outcome: 'committed', callable: 'automation.quotes_mark' }] }
				]);
				expect(
					required((yield* t.db.read([{ text: 'SELECT title FROM quotes', params: [] }]))[0]).rows
				).toEqual([]);
				yield* t.runDue();
				expect(
					required((yield* t.db.read([{ text: 'SELECT title FROM quotes', params: [] }]))[0]).rows
				).toEqual([{ title: 'Chair' }]);
				const quoteId = yield* t.db.value(Schema.String, {
					text: 'SELECT id FROM quotes',
					params: []
				});
				expect(
					yield* t.db.rows(Schema.Struct({ state: Schema.String, output: Schema.Json }), {
						text: "SELECT state, output FROM sys_run WHERE automation = 'quotes_mark'",
						params: []
					})
				).toEqual([{ state: 'succeeded', output: quoteId }]);
			})
	);
});

describe('public SSR caller scope', () => {
	const manifest = Result.getOrThrow(
		decodeManifest({
			workspace: { tz: 'UTC', locale: 'en', apps: ['sales', 'careers'], agent: { triage: false } }, // hook:decisions
			models: {
				quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } }
			},
			relationships: {},
			exposures: {
				quotes: { read: { quotes: { fields: 'all' } }, create: { columns: { quotes: ['title'] } } }
			},
			policies: {
				rep: {
					description: 'Rep',
					capabilities: { apps: ['sales'] },
					grants: { quotes: { read: true } }
				},
				applicant: {
					description: 'Apply',
					grants: { quotes: { read: { quotes: { where: { title: { eq: 'Desk' } }, fields: ['title'] } } } }
				}
			},
			apps: {
				sales: {
					title: 'Sales',
					description: 'd',
					icon: 'i',
					pages: { deals: { title: 'Deals' }, report: { title: 'Report' } }
				},
				careers: {
					title: 'Careers',
					description: 'Jobs',
					icon: 'i',
					audience: { public: ['applicant'] },
					pages: { apply: { title: 'Apply' } }
				}
			},
			agent: { skills: {} },
			integrations: {},
			teams: { rep: ['rep'], applicant: ['applicant'] },
			automations: {},
			connections: {},
			envoys: {},
			mcp: {},
			customFields: {}
		})
	);
	const artifact = Effect.fnUntraced(function* () {
		const fs = yield* FileSystem.FileSystem;
		const here = dirname(fileURLToPath(import.meta.url));
		const root = yield* fs.makeTempDirectoryScoped({
			directory: yield* scratchRoot(),
			prefix: 'p4-public-scope-'
		});
		yield* fs.symlink(join(here, '..', 'node_modules'), join(root, 'node_modules'));
		const files = {
			'src/+workspace.ts': `export default ${JSON.stringify(manifest.workspace)} as const;`,
			'src/data/model/quotes/+model.ts': `import { model } from '@norbital-ai/bolt'; export default model('quotes', ${JSON.stringify({ ...manifest.models['quotes'], read: 'all', create: { columns: ['title'] } })});`,
			'src/access_control/team/+team.ts': `import { team } from '@norbital-ai/bolt'; export default team(${JSON.stringify(manifest.teams)});`,
			...Object.fromEntries(
				Object.entries(manifest.policies).map(([name, policy]) => [
					`src/access_control/policy/+${name}.policy.ts`,
					`import { policy } from '@norbital-ai/bolt'; export default policy(${JSON.stringify(policy)});`
				])
			),
			...Object.fromEntries(
				Object.entries(manifest.apps).map(([name, app]) => [
					`src/app/${name}/+app.ts`,
					`import { app } from '@norbital-ai/bolt'; export default app('${name}', ${JSON.stringify(app)});`
				])
			),
			'src/app/sales/+deals.page.svelte':
				'<script lang="ts">import { Table } from "@norbital-ai/ui";</script><Table of="quotes" columns={["title"]} />',
			'src/app/sales/+report.page.svelte':
				'<script lang="ts">import { Table } from "@norbital-ai/ui";</script><Table of="quotes" columns={["title"]} />',
			'src/app/careers/apply.page.data.ts': yield* fs.readFileString(
				join(here, 'support', 'p4-public.page.data.ts')
			),
			'src/app/careers/+apply.page.server.ts': `import { pageServer } from '@norbital-ai/bolt';
import data from './apply.page.data.ts';
export default pageServer({ data, load: function* (request, ctx) {
	const { quotes: page } = yield* ctx.query({ quotes: { fields: ['title'], orderBy: { title: 'asc' }, limit: 10 } });
	return { titles: page.rows.map((row) => row.title), caller: ctx.actor.kind, path: request.pathname };
} });`,
			'src/app/careers/+apply.page.svelte': `<script lang="ts">
import type Data from './apply.page.data.ts';
let { data }: { data: typeof Data.Type } = $props();
</script>
<h1>Apply</h1><p data-public-caller>{data.caller}</p><p data-public-path>{data.path}</p>
<ul>{#each data.titles as title (title)}<li>{title}</li>{/each}</ul>`
		};
		for (const [file, source] of Object.entries(files)) {
			yield* fs.makeDirectory(dirname(join(root, file)), { recursive: true });
			yield* fs.writeFileString(join(root, file), source);
		}
		const checked = yield* check(root, { migrations: 'generate' });
		expect(checked.errors).toEqual([]);
		const builtManifest = required(checked.manifest),
			guest = required(checked.guest);
		const found = yield* discover(root);
		expect(found.errors).toEqual([]);
		const out = join(root, '.norbital', 'artifact');
		yield* writeArtifact(root, { manifest: builtManifest, guest }, found.files, out);
		return yield* readArtifact(out);
	});

	it.live(
		'public server reads retain the visitor caller and filter private rows',
		() =>
			Effect.gen(function* () {
				const context = yield* Layer.build(
					TestWorkspace.layer({
						artifact: yield* artifact(),
						seed: {
							quotes: [
								{ id: randomUUID(), title: 'Desk' },
								{ id: randomUUID(), title: 'Private quote' }
							]
						}
					})
				);
				const publicPages = { 'app/careers/apply': PublicData };
				const rendered = yield* visit(
					'/app/careers/apply',
					{ visitor: 'careers' },
					{
						publicPages
					}
				).pipe(Effect.provide(context));
				expect(rendered.target.querySelector('[data-public-caller]')?.textContent).toBe('visitor');
				expect(rendered.target.querySelector('[data-public-path]')?.textContent).toBe(
					'/app/careers/apply'
				);
				expect([...rendered.target.querySelectorAll('li')].map((row) => row.textContent)).toEqual([
					'Desk'
				]);
				expect(rendered.target.textContent).not.toContain('Private quote');
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000
	);
});

describe('G5 UI', () => {
	it.live(
		'the location picker opens its search and map on demand; typed and located points follow the address',
		() =>
			Effect.gen(function* () {
				const errors: unknown[] = [];
				const original = console.error;
				console.error = (...a: unknown[]) => errors.push(a);
				try {
					Object.defineProperty(navigator, 'geolocation', {
						configurable: true,
						value: {
							getCurrentPosition: (
								ok: (p: { coords: { latitude: number; longitude: number } }) => void
							) => ok({ coords: { latitude: 1.3521234, longitude: 103.8198765 } })
						}
					});
					const got: Json[] = [];
					const geocoder: NonNullable<KindsHost['geocoder']> = {
						search: () =>
							Effect.succeed([
								{ point: { lat: 1.304, lng: 103.832 }, address: 'Orchard Road, Singapore' }
							]),
						reverse: () => Effect.succeed('Bishan, Singapore')
					};
					const picker = yield* show(Point, {
						kinds: { geocoder },
						onChange: (v: Json) => got.push(v)
					});
					flushSync();
					expect(picker.querySelectorAll('input')).toHaveLength(0);
					required(picker.querySelector<HTMLButtonElement>('[data-point-picker]')).click();
					flushSync();
					const panel = required(document.querySelector<HTMLElement>('[data-point-options]'));
					const box = required(panel.querySelector<HTMLInputElement>('input'));
					expect(panel.querySelectorAll('input')).toHaveLength(1);
					required(
						panel.querySelector<HTMLButtonElement>(`button[aria-label="Use my location"]`)
					).click();
					expect(got.at(-1)).toEqual({ lat: 1.352123, lng: 103.819877 });
					box.value = '1.29, 103.85';
					box.dispatchEvent(new Event('input', { bubbles: true }));
					expect(got.at(-1)).toEqual({ lat: 1.29, lng: 103.85 });
					box.value = 'orchard';
					box.dispatchEvent(new Event('input', { bubbles: true }));
					yield* until(
						() => JSON.stringify(got.at(-1)) === JSON.stringify({ lat: 1.304, lng: 103.832 })
					); // the value follows the typing
					expect(DEFAULT_BASEMAP.url).not.toMatch(/key=|token=|\?/);
					expect(DEFAULT_GEOCODER.reverse).toBeDefined();
					for (let i = 0; i < 20; i++) yield* tick; // the map's lazy load settles, or fails quietly
				} finally {
					console.error = original;
				}
				expect(errors).toEqual([]);
			})
	);

	const month = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
	const people = Array.from({ length: 60 }, (_, i) => ({
		id: randomUUID(),
		name: `P${String(i + 1).padStart(2, '0')}`
	}));
	const manifest = Result.getOrThrow(
		decodeManifest({
			workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
			models: {
				people: { description: 'An employee', label: 'name', fields: { name: { kind: 'text' } } },
				entries: {
					description: 'A time entry',
					label: 'day',
					fields: { day: { kind: 'date' }, hours: { kind: 'decimal', scale: 2 } }
				}
			},
			relationships: { 'entries.person': { to: 'people', inverse: 'entries' } },
			exposures: { people: { read: { people: { fields: 'all' } } }, entries: { read: { entries: { fields: 'all' } } } },
			policies: {},
			integrations: {},
			teams: {},
			automations: {},
			connections: {},
			envoys: {},
			mcp: {},
			apps: {},
			customFields: {},
			agent: { skills: {} }
		})
	);
	const kinds: KindsHost = {
		catalog: {
			people: { label: ['name'], fields: { name: { kind: 'text' } } },
			entries: {
				label: ['day'],
				fields: {
					day: { kind: 'date' },
					hours: { kind: 'decimal', scale: 2 },
					person: { kind: 'id', of: 'people' }
				}
			}
		}
	};
	const mounted = (view: 'table' | 'matrix', seed: TestOptions['seed']) =>
		Effect.gen(function* () {
			const context = yield* Layer.build(
				TestWorkspace.layer({ manifest, ...(seed === undefined ? {} : { seed }) })
			);
			const t = Context.get(context, TestWorkspace),
				handle = yield* routeFixture(context),
				authority = t.as(t.admin).authority;
			const bytes = { n: 0 },
				reads: string[] = [],
				run = yield* FiberSet.makeRuntimePromise();
			const nativeFetch = (input: RequestInfo | URL, init?: RequestInit) =>
				Effect.gen(function* () {
					const url = new URL(
						typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
						'http://cell'
					);
					const request = new Request(url, input instanceof Request ? input : init);
					if (url.pathname === PATHS.q) {
						const body = yield* Effect.tryPromise({
							try: () => request.clone().text(),
							catch: (error) => new KitInvalid({ message: String(error) })
						});
						reads.push(body);
					}
					const response = yield* handle.handle(authority, request);
					if (url.pathname !== PATHS.live || request.method === 'POST')
						bytes.n += (yield* Effect.tryPromise({
							try: () => response.clone().arrayBuffer(),
							catch: (error) => new KitInvalid({ message: String(error) })
						})).byteLength;
					return response;
				});
			const fetch: typeof globalThis.fetch = (input, init) => run(nativeFetch(input, init));
			const openStream = yield* sse((url) => nativeFetch(url).pipe(Effect.orDie), bytes);
			const bolt = yield* createBolt({
				actor: null,
				locale: 'en',
				base: 'http://cell',
				fetch,
				openStream
			});
			const target = yield* show(Views, { bolt, kinds, view, cols: month });
			return { target, bytes, reads };
		});

	const people23 = () => ({
		people: Array.from({ length: 23 }, (_, i) => ({
			id: randomUUID(),
			name: `N${String(i + 1).padStart(2, '0')}`
		}))
	});
	it.live('the Table shows its first page with the count, read once per scope', () =>
		Effect.gen(function* () {
			const { target, reads } = yield* mounted('table', people23());
			const range = () => target.querySelector('[data-range]')?.textContent ?? '';
			yield* until(() => range() === 'rows 1–10 of 23');
			expect(target.textContent).toContain('N10');
			expect(target.textContent).not.toContain('N11');
			const next = required(
				[...target.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Next')
			);
			expect(next.disabled).toBe(false);
			expect(reads.filter((b) => b.includes('"aggregate"'))).toHaveLength(1);
		})
	);

	// a cursor page is not liveable (rule 64): Table reads it once and keeps the first page live
	it.live('the Table pages forward by keyset link', () =>
		Effect.gen(function* () {
			const { target } = yield* mounted('table', people23());
			const range = () => target.querySelector('[data-range]')?.textContent ?? '';
			yield* until(() => range() === 'rows 1–10 of 23');
			const next = () =>
				required(
					[...target.querySelectorAll('button')].find(
						(b) => b.getAttribute('aria-label') === 'Next'
					)
				);
			next().click();
			yield* until(() => range() === 'rows 11–20 of 23', 200);
			next().click();
			yield* until(() => range() === 'rows 21–23 of 23', 200);
			expect(target.textContent).toContain('N23');
			expect(target.textContent).not.toContain('N01');
			expect(next().disabled).toBe(true);
		})
	);

	it.live(
		'a 50-row Matrix page of a month moves at most 300 KiB',
		() =>
			Effect.gen(function* () {
				// the densest nihon month: one work day per employee per calendar day (the bank's January averages under ten)
				const entries = people.flatMap((p) =>
					month.map((day) => ({ id: randomUUID(), person: p.id, day, hours: '7.50' }))
				);
				const { target, bytes } = yield* mounted('matrix', { people, entries });
				// the rows are windowed (virtualized past 20): the first rows render, the page's 50 arrive on the wire
				yield* until(
					() =>
						(target.textContent ?? '').includes('P01') &&
						(target.textContent ?? '').includes('7.5'),
					2000
				);
				for (let i = 0; i < 20; i++) yield* tick;
				expect(target.textContent).not.toContain('P51');
				expect(bytes.n).toBeLessThanOrEqual(300 * 1024);
				expect(bytes.n).toBeGreaterThan(50 * 30 * 60); // the page's cells did arrive
			}),
		60_000
	);
});
