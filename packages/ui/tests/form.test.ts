import './dom.ts';
import { viewFixture, browser } from './view-fixture.ts';
import { Deferred, Effect, Fiber, Schema } from 'effect';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import type { Json } from '@norbital-ai/std/wire';
import type { FormSpec, Outcome } from '../src/form/draft.ts';
import type { Outcome as WireOutcome } from '../../bolt/build/protocol/schema.js';

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
	update: { columns: ['title', 'total', 'note'] }
} as const;
const automations = {
	hire: { input: { name: { kind: 'text' }, start: { kind: 'date' } } },
	close: {
		input: { target: { kind: 'id', of: 'quotes' }, reason: { kind: 'text', optional: true } }
	}
} as const;
const text = {
	pendingApproval: 'held',
	conflict: 'conflict',
	unknown: 'unknown',
	running: 'running'
};

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

it.effect('create and automation forms omit nulls and send direct input fields', () =>
	Effect.sync(() => {
		const create = specOf('quotes', exposure, 'create');
		assert.deepEqual(d.payload(create, {}, { title: 'A', total: '1', note: null, account: 'a1' }), {
			title: 'A',
			total: '1',
			account: 'a1'
		});
		const hire = specOf({ automation: 'hire' }, undefined, 'create', undefined, automations.hire);
		assert.deepEqual(d.payload(hire, {}, { name: 'N', start: '2026-01-01' }), {
			name: 'N',
			start: '2026-01-01'
		});
		const close = specOf(
			{ automation: 'close' },
			undefined,
			'create',
			undefined,
			automations.close
		);
		assert.equal(close.callable, 'close');
		assert.deepEqual(close.target, { of: 'automation', automation: 'close' });
		assert.deepEqual(d.payload(close, {}, { target: 'q1', reason: null }), { target: 'q1' });
		assert.equal(d.formSpec({ automation: 'close' }, exposure, 'create'), null);
	})
);

it.live('an automation submit reports queue admission and retains its native run separately', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>(),
				admitted = yield* Deferred.make<void>();
			const inputs: Json[] = [];
			const { bolt } = yield* browser(() =>
				viewFixture({
					act: (callable, input) => {
						assert.equal(callable, 'start');
						const request = Schema.decodeUnknownSync(
							Schema.Struct({
								automation: Schema.String,
								runs: Schema.Array(Schema.Struct({ id: Schema.String, input: Schema.Json }))
							})
						)(input);
						assert.equal(request.automation, 'close');
						const first = request.runs[0];
						assert.ok(first);
						inputs.push(first.input);
						const queued: WireOutcome = {
							kind: 'committed',
							output: {
								id: first.id,
								ids: request.runs.map((run) => run.id),
								automation: request.automation
							},
							records: []
						};
						return Deferred.succeed(started, undefined).pipe(
							Effect.andThen(Deferred.await(admitted)),
							Effect.as(queued)
						);
					}
				})
			);
			let writes = 0;
			const form = new FormState(
				specOf({ automation: 'close' }, undefined, 'create', undefined, automations.close),
				null,
				{ target: 'q1', reason: 'Duplicate' },
				(callable, input, options) => {
					writes++;
					return bolt.act(callable, input, options);
				},
				text,
				undefined,
				(automation, input) => bolt.start(automation, input)
			);
			const observed: Outcome[] = [];
			form.onOutcome((outcome) => observed.push(outcome));
			const submitted = yield* form.submit().pipe(Effect.forkScoped);
			yield* Deferred.await(started);
			assert.equal(form.pending, true);
			assert.deepEqual(observed, []);
			assert.deepEqual(inputs, [{ target: 'q1', reason: 'Duplicate' }]);
			yield* Deferred.succeed(admitted, undefined);
			const outcome = yield* Fiber.join(submitted);
			const handle = form.run;
			assert.ok(handle);
			assert.deepEqual(outcome, {
				kind: 'committed',
				output: { id: handle.id, ids: handle.ids, automation: 'close' },
				records: []
			});
			assert.strictEqual(observed[0], outcome);
			assert.equal(writes, 0);
			assert.equal(form.pending, false);
			assert.deepEqual(form.notice, { tone: 'info', text: 'running', run: handle.id });
		})
	)
);

it.live(
	'unknown automation retries reuse the run only while the submitted input is unchanged',
	() =>
		Effect.gen(function* () {
			let minted = 0;
			const requests: { id: string; input: Json }[] = [];
			const { bolt } = yield* browser(() =>
				viewFixture({
					uuid: () => `run-${++minted}`,
					act: (callable, input) => {
						assert.equal(callable, 'start');
						const request = Schema.decodeUnknownSync(
							Schema.Struct({
								automation: Schema.String,
								runs: Schema.Array(Schema.Struct({ id: Schema.String, input: Schema.Json }))
							})
						)(input);
						const run = request.runs[0];
						assert.ok(run);
						requests.push(run);
						return requests.length <= 2
							? { kind: 'unknown', invocation: run.id }
							: {
									kind: 'committed',
									output: { id: run.id, ids: [run.id], automation: request.automation },
									records: []
								};
					}
				})
			);
			const form = new FormState(
				specOf({ automation: 'close' }, undefined, 'create', undefined, automations.close),
				null,
				{ target: 'q1', reason: 'Duplicate' },
				(callable, input, options) => bolt.act(callable, input, options),
				text,
				undefined,
				(automation, input) => bolt.start(automation, input)
			);
			assert.equal((yield* form.submit())?.kind, 'unknown');
			const first = form.run;
			assert.ok(first);
			assert.deepEqual(form.values, { target: 'q1', reason: 'Duplicate' });
			assert.equal((yield* form.submit())?.kind, 'unknown');
			assert.strictEqual(form.run, first);
			form.set('reason', 'Corrected reason');
			assert.deepEqual(form.values, { target: 'q1', reason: 'Corrected reason' });
			assert.equal((yield* form.submit())?.kind, 'committed');
			assert.ok(form.run);
			assert.notEqual(form.run.id, first.id);
			assert.deepEqual(requests, [
				{ id: first.id, input: { target: 'q1', reason: 'Duplicate' } },
				{ id: first.id, input: { target: 'q1', reason: 'Duplicate' } },
				{ id: form.run.id, input: { target: 'q1', reason: 'Corrected reason' } }
			]);
			assert.equal(minted, 2);
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
			{ kind: 'conflict', records: [{ model: 'quotes', id: 'q1', fields: ['title'] }] },
			text
		);
		assert.deepEqual([...c.errors], [['title', 'conflict']]);
		assert.equal(c.newKey, true);
	})
);

it.effect('a running outcome keeps the draft and key, and its notice names the run', () =>
	Effect.sync(() => {
		const spec = specOf('quotes', exposure, 'create');
		const base = { title: null, total: null, note: null, account: null };
		const s = d.settle(spec, base, { ...base, title: 'A' }, { kind: 'running', run: 'r1' }, text);
		assert.equal(s.draft, null);
		assert.equal(s.newKey, false);
		assert.deepEqual(s.notice, { tone: 'info', text: 'running', run: 'r1' });
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
				assert.deepEqual(calls, [[{ title: 'Paint', document: ref }]]);
			})
		)
);
