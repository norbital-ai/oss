// Semantic (invariant) validation: a registered rule's issues disable Save and block submit without locking the
// field, and fixing the value clears them reactively.
import './dom.ts';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { it, afterEach } from '@effect/vitest';
import type { Json } from '@norbital-ai/std/wire';
import type { KindsHost } from '../src/kinds/context.ts';
import type { FormSpec } from '../src/form/draft.ts';
import type { FormState as Form, SemanticIssue } from '../src/form/form-state.svelte.ts';
import { browser, required, textOf, viewFixture } from './view-fixture.ts';
import { element } from './elements.ts';
const { flushSync, mount, tick, unmount } = await import('svelte');
const d = await import('../src/form/draft.ts');
const { FormState } = await import('../src/form/form-state.svelte.ts');
const { default: Harness } = await import('./semantic-harness.svelte');

const catalog = {
	jobs: {
		label: ['title'],
		fields: { title: { kind: 'text' } },
		create: { columns: ['title'] },
		update: { columns: ['title'] }
	}
} satisfies NonNullable<KindsHost['catalog']>;
const text = { pendingApproval: 'held', conflict: 'conflict', unknown: 'unknown' };
const notBad = (form: Form) => (): readonly SemanticIssue[] =>
	form.get('title') === 'bad' ? [{ field: 'title', message: 'Title cannot be bad' }] : [];
const specOf = (...args: Parameters<typeof d.formSpec>): FormSpec => required(d.formSpec(...args));

const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of mounted.splice(0).reverse()) await close();
});
const settle = async () => {
	flushSync();
	for (let i = 0; i < 5; i++) {
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
};
async function show(part: 'record' | 'create') {
	const acts: Json[] = [];
	const { bolt } = await viewFixture({
		get: (c, id) => (c === 'jobs' && id === 'j1' ? { id: 'j1', revision: 1, title: 'Paint' } : null),
		act: (_callable, input) => {
			acts.push(input);
			return { kind: 'committed', output: null, records: [] };
		}
	});
	const target = document.body.appendChild(document.createElement('div'));
	let form: Form | undefined;
	const app = mount(Harness, {
		target,
		props: { bolt, catalog, part, onForm: (f: Form) => (form = f) }
	});
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	await settle();
	return { target, acts, form: () => required(form) };
}
const button = (root: ParentNode, label: string) =>
	required(
		[...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => textOf(b).trim() === label)
	);
const type = async (root: ParentNode, value: string) => {
	const input = element<HTMLInputElement>(root, '[data-field=title] input');
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
};

it.live('a broken invariant disables the create footer Save until the value is fixed', () =>
	Effect.gen(function* () {
		const v = yield* browser(() => show('create'));
		v.form().addValidation(notBad(v.form()));
		yield* browser(() => type(v.target, 'bad'));
		assert.equal(button(v.target, 'Create').disabled, true);
		const input = element<HTMLInputElement>(v.target, '[data-field=title] input');
		assert.equal(input.getAttribute('aria-invalid'), 'true');
		assert.match(textOf(element(v.target, '[data-field=title] [role=alert]')), /Title cannot be bad/);
		assert.equal(input.disabled || input.readOnly, false, 'the field stays editable');
		yield* browser(() => type(v.target, 'good'));
		assert.equal(button(v.target, 'Create').disabled, false);
		assert.equal(v.target.querySelector('[data-field=title] [role=alert]'), null);
	})
);

it.live('a broken invariant disables the record header Save until the value is fixed', () =>
	Effect.gen(function* () {
		const v = yield* browser(() => show('record'));
		button(v.target, 'Edit').click();
		yield* browser(() => settle());
		v.form().addValidation(notBad(v.form()));
		yield* browser(() => type(v.target, 'bad'));
		assert.equal(button(v.target, 'Save').disabled, true);
		yield* browser(() => type(v.target, 'Paint v2'));
		assert.equal(button(v.target, 'Save').disabled, false);
		button(v.target, 'Save').click();
		yield* browser(() => settle());
		assert.equal(v.acts.length, 1);
	})
);

it.live('submit sends nothing while an issue exists; unregister removes the rule', () =>
	Effect.gen(function* () {
		const acts: Json[] = [];
		const { bolt } = yield* browser(() =>
			viewFixture({
				act: (_callable, input) => {
					acts.push(input);
					return { kind: 'committed', output: null, records: [] };
				}
			})
		);
		const form = new FormState(specOf('jobs', catalog.jobs, 'create'), null, {}, bolt.act, text);
		const unregister = form.addValidation(notBad(form));
		form.set('title', 'bad');
		assert.deepEqual(form.semanticErrors, [{ field: 'title', message: 'Title cannot be bad' }]);
		assert.equal(form.semanticError('title'), 'Title cannot be bad');
		assert.equal(form.semanticError('other'), undefined);
		assert.equal(form.canSubmit, true, 'permission is unaffected');
		assert.equal(form.locked('title'), false);
		assert.equal(form.canSave, false);
		assert.equal(form.validate(), false);
		assert.equal(yield* form.submit(), null);
		assert.equal(yield* form.prepare(), false);
		assert.deepEqual(acts, []);
		unregister();
		assert.deepEqual(form.semanticErrors, []);
		assert.equal(form.canSave, true);
		assert.equal((yield* form.submit())?.kind, 'committed');
		assert.deepEqual(acts, [{ title: 'bad' }]);
	})
);
