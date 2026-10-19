import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { browser } from './view-fixture.ts';
import { EditorView } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import type { Value } from '../src/kinds/kind.ts';
import { readViewUrl } from '../src/filter/filter.ts';
const { mount, flushSync, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./json-schema-harness.svelte');
const settle = async () => {
	flushSync();
	await tick();
	flushSync();
};

async function editor(changed: (value: Value) => void) {
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, {
		target,
		props: { kind: { kind: 'json' }, initial: { a: 1 }, changed }
	});
	await settle();
	const element = target.querySelector('.cm-editor');
	assert.ok(element instanceof HTMLElement);
	const view = EditorView.findFromDOM(element);
	assert.ok(view);
	return {
		target,
		view,
		async close() {
			await unmount(app);
			target.remove();
		}
	};
}

it.live('repeated editor mounts reuse stylesheet rules while keeping independent drafts', () =>
	browser(async () => {
		const ruleCount = () =>
			Array.from(document.styleSheets).reduce((count, sheet) => count + sheet.cssRules.length, 0);
		let mountedRuleCount: number | undefined;
		for (let index = 0; index < 6; index++) {
			const changes: Value[] = [];
			const mounted = await editor((value) => changes.push(value));
			try {
				assert.equal(mounted.view.state.doc.toString(), '{\n  "a": 1\n}');
				mounted.view.dispatch({
					changes: { from: 0, to: mounted.view.state.doc.length, insert: String(index) }
				});
				await settle();
				assert.deepEqual(changes, [index]);
				assert.equal(mounted.view.state.doc.toString(), String(index));
				if (mountedRuleCount === undefined) {
					mountedRuleCount = ruleCount();
					assert.ok(mountedRuleCount > 0, 'the native editor must mount actual stylesheet rules');
				} else
					assert.equal(ruleCount(), mountedRuleCount, 'new editors must reuse mounted CSS rules');
			} finally {
				await mounted.close();
			}
			assert.equal(mounted.target.querySelector('.cm-editor'), null);
			assert.equal(
				ruleCount(),
				mountedRuleCount,
				'destroying a view must not add stylesheet rules'
			);
		}
	})
);

it.live(
	'raw JSON retains invalid drafts and emits each valid edit once, including null and blank',
	() =>
		browser(async () => {
			const changes: Value[] = [];
			const mounted = await editor((value) => changes.push(value));
			try {
				for (const [text, value] of [
					['false', false],
					['0', 0],
					['null', null],
					[' ', null],
					['{"a":[2]}', { a: [2] }]
				] as const) {
					mounted.view.dispatch({
						changes: { from: 0, to: mounted.view.state.doc.length, insert: text }
					});
					await settle();
					assert.equal(changes.length, ['false', '0', 'null', ' ', '{"a":[2]}'].indexOf(text) + 1);
					assert.deepEqual(changes.at(-1), value);
					assert.equal(
						mounted.view.state.doc.toString(),
						typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : text
					);
					assert.equal(mounted.target.querySelector('.text-destructive'), null);
				}
				mounted.view.dispatch({
					changes: { from: 0, to: mounted.view.state.doc.length, insert: '{"a":' }
				});
				await settle();
				assert.equal(changes.length, 5);
				assert.equal(mounted.view.state.doc.toString(), '{"a":');
				assert.ok(mounted.target.querySelector('.text-destructive'));
				mounted.view.dispatch({
					changes: { from: 0, to: mounted.view.state.doc.length, insert: '[3]' }
				});
				await settle();
				assert.deepEqual(changes.at(-1), [3]);
				assert.equal(changes.length, 6);
				assert.equal(mounted.target.querySelector('.text-destructive'), null);
			} finally {
				await mounted.close();
			}
		})
);

it.live('valid JSON callback faults reach CodeMirror rather than becoming parse errors', () =>
	browser(async () => {
		const failure = new Error('consumer failed');
		const observed: unknown[] = [];
		const mounted = await editor(() => {
			throw failure;
		});
		try {
			mounted.view.dispatch({
				effects: StateEffect.appendConfig.of(
					EditorView.exceptionSink.of((error) => observed.push(error))
				)
			});
			mounted.view.dispatch({
				changes: { from: 0, to: mounted.view.state.doc.length, insert: 'false' }
			});
			await settle();
			assert.deepEqual(observed, [failure]);
			assert.equal(mounted.target.querySelector('.text-destructive'), null);
		} finally {
			await mounted.close();
		}
	})
);

it.live('URL JSON distinguishes valid null from invalid text and retains sort state', () =>
	Effect.sync(() => {
		for (const [raw, where, badJson] of [
			['null', null, false],
			['false', false, false],
			['{"a":', undefined, true]
		] as const) {
			assert.deepEqual(
				readViewUrl(new URLSearchParams({ 'rows.where': raw, 'rows.order': 'name' }), 'rows'),
				{ where, order: 'name', badJson }
			);
		}
	})
);
