// Audit Phase 2: `ctx.browser` driven through the host's browser port, and the run's tab closed after it fails.
import { expect, it } from '@effect/vitest';
import { randomUUID } from 'node:crypto';
import { Context, Effect, Layer } from 'effect';
import type { BrowserSnapshot } from '@norbital-ai/host-api';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Browser } from '../src/engine/ports.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	policies: { ops: { description: 'Ops', grants: {} } },
	teams: {},
	automations: { browse: { description: 'Reads a supplier page', policies: ['ops'] } },
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} }
};
const guest = program(`export default { automation: {
	browse: { body: function* (input, ctx) {
		yield* ctx.browser.navigate('https://shop.test/item');
		const page = yield* ctx.browser.snapshot({ find: 'Price' });
		yield* ctx.browser.act([{ click: 'e1' }]);
		yield* ctx.browser.download('https://shop.test/sheet.pdf', { for: 'browse' });
		throw new Error('the price moved: ' + page.text);
	} }
} };`);

it.live('a run drives its own tab through the host port and the tab closes when the run fails', () =>
	Effect.scoped(
		Effect.gen(function* () {
			// the host's browser: what each profile's tab saw, in order
			const seen: string[] = [];
			const tabs = new Map<string, BrowserSnapshot>();
			const tab = (profile: string) => {
				const page = tabs.get(profile);
				if (page === undefined) throw new Error(`no open tab for ${profile}`);
				return page;
			};
			const host = Browser.fromAbi({
				open: async (profile) => {
					seen.push('open');
					tabs.set(profile, { url: 'about:blank', title: null, text: '' });
				},
				navigate: async (profile, to) => {
					seen.push(`navigate ${'url' in to ? to.url : to.go}`);
					tab(profile);
					const page = { url: 'url' in to ? to.url : 'about:blank', title: 'Item', text: 'Price 10' };
					tabs.set(profile, page);
					return page;
				},
				snapshot: async (profile, options) => {
					seen.push(`snapshot ${options.find ?? ''}`);
					return tab(profile);
				},
				act: async (profile, steps) => {
					seen.push(`act ${JSON.stringify(steps)}`);
					return tab(profile);
				},
				evaluate: async () => null,
				screenshot: async () => new Uint8Array(),
				download: async (profile, url) => {
					seen.push(`download ${url}`);
					tab(profile);
					return { key: 'sheet', sha256: 'a'.repeat(64), name: 'sheet.pdf', mime: 'application/pdf', bytes: 3 };
				},
				close: async (profile) => {
					seen.push('close');
					tabs.delete(profile);
				}
			});
			const t = Context.get(
				yield* Layer.build(TestWorkspace.layer({ manifest, guest: yield* guest, ports: host })),
				TestWorkspace
			);
			yield* t.db.write({
				text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth) VALUES ($1, 'browse', '{}', $2::timestamptz, 'schedule', 0)`,
				params: [randomUUID(), t.clock.now()]
			});
			const { failed } = yield* t.run_due();
			expect(failed).toEqual([
				expect.objectContaining({ automation: 'browse', error: expect.stringContaining('the price moved: Price 10') })
			]);
			expect(seen).toEqual([
				'open',
				'navigate https://shop.test/item',
				'snapshot Price',
				'act [{"click":"e1"}]',
				'download https://shop.test/sheet.pdf',
				'close'
			]);
			expect(tabs.size).toBe(0);
			const [files] = yield* t.db.read([{ text: 'SELECT name, field FROM sys_file', params: [] }]);
			expect(files?.rows).toEqual([{ name: 'sheet.pdf', field: 'browse' }]);
		})
	)
);
