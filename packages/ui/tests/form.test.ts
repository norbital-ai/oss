import './dom.ts';
import { viewFixture, browser } from './view-fixture.ts';
import { Deferred, Effect, Fiber } from 'effect';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import type { Json } from '@norbital-ai/std/wire';
import type { FormSpec } from '../src/form/draft.ts';

const d = await import('../src/form/draft.ts');
const { FormState } = await import('../src/form/form-state.svelte.ts');
const specOf = (...args: Parameters<typeof d.formSpec>): FormSpec => {
	const spec = d.formSpec(...args);
	assert.ok(spec);
	return spec;
};

const exposure = {
	label: ['title'],
	fields: {
		title: { kind: 'text' },
		total: { kind: 'money', currency: 'SGD' },
		note: { kind: 'text', optional: true },
		status: {
			kind: 'state',
			initial: 'draft',
			states: { draft: { to: ['submitted'] }, submitted: { edit: ['note'] } }
		}
	},
	relations: { account: { targets: ['accounts'] } },
	create: { columns: ['title', 'total', 'note', 'account'] },
	update: { columns: ['title', 'total', 'note'] },
	actions: {
		hire: { input: { name: { kind: 'text' }, start: { kind: 'date' } } },
		close: { input: { reason: { kind: 'text', optional: true } }, target: 'record' }
	}
} as const;
const text = { pendingApproval: 'held', conflict: 'conflict', unknown: 'unknown' };

it.effect(
	'transform-filled create fields may be omitted while supplied values remain validated',
	() =>
		Effect.sync(() => {
			const spec = specOf(
				'quotes',
				{ ...exposure, create: { ...exposure.create, filled: ['title', 'account'] } },
				'create'
			);
			const draft = d.startValues(spec, null, { total: '10' });
			assert.deepEqual([...d.check(spec, draft)], []);
			assert.deepEqual(d.payload(spec, {}, draft), { total: '10' });
			assert.ok(d.check(spec, { ...draft, title: 42 }).has('title'));
			assert.ok(
				d
					.check(specOf('quotes', exposure, 'update', 'q1'), {
						title: null,
						total: '10',
						note: null
					})
					.has('title')
			);
		})
);

it.effect('a create form is the create allowlist, relations as pickers', () =>
	Effect.sync(() => {
		const spec = specOf('quotes', exposure, 'create');
		assert.equal(spec.callable, 'quotes.create');
		assert.deepEqual(
			spec.fields.map((f) => f.name),
			['title', 'total', 'note', 'account']
		);
		assert.deepEqual(spec.fields.find((field) => field.name === 'account')?.kind, {
			kind: 'id',
			of: 'accounts'
		});
		assert.equal(
			d.formSpec('quotes', (({ create: _create, ...rest }) => rest)(exposure), 'create'),
			null
		);
		assert.equal(d.formSpec('quotes', undefined, 'create'), null);
	})
);

it.effect('an update sends only changed fields; nothing changed sends nothing', () =>
	Effect.sync(() => {
		const spec = specOf('quotes', exposure, 'update', 'q1');
		const base = d.startValues(spec, {
			id: 'q1',
			title: 'A',
			total: Decimal.of('10.00'),
			note: null
		});
		assert.equal(base.title, 'A');
		assert.equal(base.note, null);
		assert.ok(base.total instanceof Decimal);
		assert.equal(base.total.toString(), '10.00');
		assert.equal(d.payload(spec, base, base), null);
		assert.deepEqual(d.payload(spec, base, { ...base, note: 'x' }), {
			target: 'q1',
			set: { note: 'x' }
		});
	})
);

it.effect('draft comparisons ignore object key order and observe later nested edits', () =>
	Effect.sync(() => {
		const base = { details: { amount: Decimal.of('1.20'), tags: ['a', 'b'] } };
		const draft = { details: { tags: ['a', 'b'], amount: Decimal.of('1.20') } };
		assert.deepEqual(d.changed(base, draft), {});
		draft.details.amount = Decimal.of('2.00');
		assert.deepEqual(d.changed(base, draft), { details: draft.details });
		draft.details.amount = Decimal.of('1.20');
		assert.deepEqual(d.changed(base, draft), {});
		draft.details.tags.reverse();
		assert.deepEqual(d.changed(base, draft), { details: draft.details });
		assert.deepEqual(d.changed({}, { missing: null }), {});
	})
);

it.effect('a create omits nulls so defaults apply; an action wraps a record target', () =>
	Effect.sync(() => {
		const create = specOf('quotes', exposure, 'create');
		assert.deepEqual(d.payload(create, {}, { title: 'A', total: '1', note: null, account: 'a1' }), {
			title: 'A',
			total: '1',
			account: 'a1'
		});
		const hire = specOf({ action: 'quotes.hire' }, exposure, 'create');
		assert.deepEqual(d.payload(hire, {}, { name: 'N', start: '2026-01-01' }), {
			name: 'N',
			start: '2026-01-01'
		});
		const close = specOf({ action: 'quotes.close' }, exposure, 'create', 'q1');
		assert.equal(close.callable, 'quotes.close');
		assert.deepEqual(d.payload(close, {}, { reason: null }), { target: 'q1', input: {} });
	})
);

it.effect('advisory check blocks what decode would refuse, by path', () =>
	Effect.sync(() => {
		const spec = specOf('quotes', exposure, 'create');
		const problems = d.check(spec, { title: null, total: 'abc', note: null, account: 'a1' });
		assert.deepEqual(
			[...problems],
			[
				['title', 'is required'],
				['total', 'expected a decimal']
			]
		);
	})
);

it.effect('a refusal lands on its field; an unowned one on the form; the draft is kept', () =>
	Effect.sync(() => {
		const spec = specOf('quotes', exposure, 'update', 'q1');
		const base = { title: 'A', total: '1', note: null },
			sent = { ...base, total: '2' };
		const onField = d.settle(
			spec,
			base,
			sent,
			{ kind: 'refused', code: 'check', message: 'Too small', field: 'total' },
			text
		);
		assert.equal(onField.draft, null);
		assert.deepEqual([...onField.errors], [['total', 'Too small']]);
		assert.equal(onField.notice, null);
		const onForm = d.settle(
			spec,
			base,
			sent,
			{ kind: 'refused', code: 'forbidden', message: 'No', field: 'secret' },
			text
		);
		assert.deepEqual(onForm.notice, { tone: 'danger', text: 'No' });
		assert.equal(onForm.newKey, true);
	})
);

it.effect('committed: an update re-bases on what was sent; a create resets to defaults', () =>
	Effect.sync(() => {
		const upd = specOf('quotes', exposure, 'update', 'q1');
		const s = d.settle(
			upd,
			{ title: 'A', total: '1', note: null },
			{ title: 'B', total: '1', note: null },
			{ kind: 'committed', output: null, records: [] },
			text
		);
		assert.equal(s.draft, null);
		assert.deepEqual(s.base, { title: 'B', total: '1', note: null });
		const create = specOf('quotes', exposure, 'create');
		const c = d.settle(
			create,
			{},
			{ title: 'B', total: '1', note: null, account: 'a' },
			{ kind: 'pendingApproval', requestId: 'r', records: [] },
			text
		);
		assert.deepEqual(c.draft, { title: null, total: null, note: null, account: null });
		assert.deepEqual(c.notice, { tone: 'info', text: 'held' });
	})
);

it.effect('only an unknown outcome retries under the same key; a conflict marks the fields', () =>
	Effect.sync(() => {
		const spec = specOf('quotes', exposure, 'update', 'q1');
		const base = { title: 'A', total: '1', note: null };
		assert.equal(
			d.settle(spec, base, base, { kind: 'unknown', invocation: 'k' }, text).newKey,
			false
		);
		const c = d.settle(
			spec,
			base,
			base,
			{ kind: 'conflict', records: [{ collection: 'quotes', id: 'q1', fields: ['title'] }] },
			text
		);
		assert.deepEqual([...c.errors], [['title', 'conflict']]);
		assert.equal(c.newKey, true);
	})
);

it.effect('a state lock makes fields read-only as advice', () =>
	Effect.sync(() => {
		const lock = d.locked(exposure.fields, { status: 'submitted' });
		assert.equal(lock('note'), false);
		assert.equal(lock('total'), true);
		assert.equal(d.locked(exposure.fields, null)('total'), false);
		assert.equal(d.locked(exposure.fields, { status: 'draft' })('total'), false);
		assert.equal(
			d.locked(exposure.fields, { status: 'draft' })('status'),
			false,
			'the state field still moves along `to`'
		);
		assert.equal(lock('status'), true, 'a state with no move left is final');
	})
);

it.effect('a hidden field has no editor, so the advisory check leaves it to the host', () =>
	Effect.sync(() => {
		const spec = {
			...specOf('quotes', exposure, 'create'),
			fields: [{ name: 'key', kind: { kind: 'text', hidden: true } as const }]
		};
		assert.equal(d.check(spec, { key: null }).size, 0);
	})
);

it.effect('an update the caller only reads is the read-only form of its readable fields', () =>
	Effect.sync(() => {
		const spec = specOf(
			'quotes',
			(({ update: _update, ...rest }) => rest)(exposure),
			'update',
			'q1'
		);
		assert.equal(spec.readonly, true);
		assert.deepEqual(
			spec.fields.map((f) => f.name),
			['title', 'total', 'note', 'status', 'account']
		);
		assert.equal(specOf('quotes', exposure, 'update', 'q1').readonly, undefined);
	})
);

it.effect(
	'update preserves readable fields while only writable values participate in saving and validation',
	() =>
		Effect.sync(() => {
			const spec = specOf('quotes', exposure, 'update', 'q1');
			assert.deepEqual(
				spec.fields.filter((f) => f.readonly).map((f) => f.name),
				['status', 'account']
			);
			const base = d.startValues(spec, {
				title: 'A',
				total: '10',
				note: null,
				status: 'submitted',
				account: 'a1'
			});
			assert.equal('status' in base, false);
			assert.equal(
				d.check(spec, base).has('account'),
				false,
				'a missing readonly relation never blocks saving'
			);
			assert.deepEqual(
				d.payload(spec, base, { ...base, note: 'Local note', status: 'draft', account: 'a2' }),
				{ target: 'q1', set: { note: 'Local note' } }
			);
		})
);

it.live(
	'submit drains an in-flight upload before validation and preserves its uploaded ref in the native action',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>(),
					upload = yield* Deferred.make<{ id: string; name: string; mime: string }>();
				const calls: Json[] = [];
				const { bolt } = yield* browser(() =>
					viewFixture({
						act: (_callable, input) => {
							calls.push(input);
							return { kind: 'committed', output: null, records: [] };
						}
					})
				);
				const spec = specOf(
					'jobs',
					{
						label: ['title'],
						fields: {
							title: { kind: 'text' },
							document: { kind: 'file', accept: ['application/pdf'], max: '20MiB' }
						},
						create: { columns: ['title', 'document'] }
					},
					'create'
				);
				const form = new FormState(spec, null, { title: 'Paint' }, bolt.act, text);
				let validated = false;
				form.beforeSubmit(() =>
					Effect.sync(() => {
						validated = true;
						return true;
					})
				);
				const tracked = yield* form
					.track(
						Deferred.succeed(started, undefined).pipe(
							Effect.flatMap(() => Deferred.await(upload)),
							Effect.tap((ref) => Effect.sync(() => form.set('document', ref)))
						)
					)
					.pipe(Effect.forkScoped);
				yield* Deferred.await(started);
				const submitted = yield* form.submit().pipe(Effect.forkScoped);
				yield* Effect.yieldNow;
				assert.equal(validated, false);
				assert.deepEqual(calls, []);
				const ref = { id: 'uploaded', name: 'paint.pdf', mime: 'application/pdf' };
				yield* Deferred.succeed(upload, ref);
				yield* Fiber.join(tracked);
				yield* Fiber.join(submitted);
				assert.equal(validated, true);
				assert.deepEqual(calls, [{ title: 'Paint', document: ref }]);
			})
		)
);
