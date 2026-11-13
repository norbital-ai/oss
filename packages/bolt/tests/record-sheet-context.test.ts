// @vitest-environment happy-dom
// The shell's `?record=` sheet hands a template's own record view the same page context a page receives: its clock,
// translator and reads, not only the views' `ui`.
import './setup-happy-dom.ts';
import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { mount_shell } from '../src/shell/mount.ts';
import { manifest } from './catalogue-fixture.ts';
import AuthoredRecordView from './support/authored-record-view.svelte';

it.live('a record sheet gives the authored record view the full page context', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const id = randomUUID();
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest,
					seed: { products: [{ id, external_code: 'P-1', name: 'Widget' }] },
					host: { public_url: location.origin, workspace: () => ({ name: 'Catalogue', handle: 'catalogue' }) }
				})
			);
			const t = Context.get(context, TestWorkspace);
			const admin = randomUUID();
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ($1, 'ada@x.test', 'Ada', 'staff', true)`,
				params: [admin]
			});
			const cookie = yield* t.session(admin);
			Object.defineProperty(window, 'bolt_live_mode', { value: 'snapshot', configurable: true });
			history.replaceState(null, '', `/?record=products/${id}`);
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					Reflect.deleteProperty(window, 'bolt_live_mode');
					history.replaceState(null, '', '/');
				})
			);
			const target = document.createElement('div');
			document.body.replaceChildren(target);
			const unmount = mount_shell(target, {
				manifest: { workspace: manifest.workspace, apps: manifest.apps },
				pages: {},
				representations: { products: () => Promise.resolve({ default: AuthoredRecordView }) },
				fetch: (input, init) => {
					const request = new Request(new URL(input instanceof Request ? input.url : String(input), location.origin), init);
					request.headers.set('cookie', cookie);
					return Effect.runPromise(t.handle(request));
				},
				open_stream: () => ({ onmessage: null, onerror: null, close() {} })
			});
			yield* Effect.addFinalizer(() => Effect.promise(unmount));
			// the view's text once its read answers: the DOM settles as the shell boots and the sheet loads
			const shown = yield* Effect.promise(
				() =>
					new Promise<string>((resolve) => {
						const check = () => {
							const text = document.querySelector('[data-testid="authored-view"]')?.textContent ?? 'loading';
							if (text.includes('loading')) return;
							observer.disconnect();
							resolve(text);
						};
						const observer = new MutationObserver(check);
						observer.observe(document.body, { subtree: true, childList: true, characterData: true });
						check();
					})
			);
			expect(shown).toContain('Product: view');
			expect(shown).toMatch(/\d{4}-\d{2}-\d{2}, 1/);
		})
	)
);
