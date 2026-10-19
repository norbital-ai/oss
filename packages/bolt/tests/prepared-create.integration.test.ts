import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Context, Effect, Layer, Result } from 'effect';
import { TestWorkspace, type ActOptions } from '../src/test/index.ts';
import type { Authority } from '../src/engine/contracts.ts';
import type { Json } from '../src/decl/values.ts';
import { program } from './support/guest-fixture.ts';
import { HEADERS } from '../src/protocol/wire.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { manifest as base } from './write-fixture.ts';

const manifest: EngineManifest = {
	...base,
	teams: { Finance: [] },
	policies: {
		operator: {
			description: 'Native writer',
			grants: { orders: { read: true, create: true }, lines: { read: true, create: true } }
		},
		rootonly: {
			description: 'No child grant',
			grants: { orders: { read: true, create: true }, lines: { read: true } }
		},
		review: {
			description: 'Native approval',
			grants: {
				orders: { read: true, create: true },
				lines: { read: true, approval: { create: [{ steps: [['Finance']] }] } }
			}
		}
	}
};
const guest = {
	source: `export default {collection:{orders:{bodies:{transform:function*(inputs,ctx){
 const root=ctx.staged.find(r=>r.collection==='orders'&&!r.parent);
 const path=[...root.path,'lines','create',0];
 const title=inputs[0].title;
 const first=yield* ctx.db.prepareCreate(title==='foreign'?'tags':'lines',{label:'reserved',amount:'7.50'},{path:title==='badpath'?[...root.path,'missing','create',0]:path});
 if(first.committed!==false)yield* ctx.refuse('preparation cannot claim a commit');
 if(title==='conflict')yield* ctx.db.prepareCreate('lines',{label:'changed',amount:'7.50'},{path});
 if(title==='late-refusal')yield* ctx.refuse('late source refusal');
 if(title==='unused')return inputs;
 const again=yield* ctx.db.prepareCreate('lines',{label:'reserved',amount:'7.50'},{path});
 if(again.id!==first.id)yield* ctx.refuse('native reservation identity changed');
 return [{...inputs[0],note:first.id,lines:{create:[{label:title==='changed'?'changed':'reserved',amount:'7.50'}]}}];
}}}}};`
};

const required = <T>(value: T | undefined | null): T => {
	if (value === undefined || value === null) throw new Error('fixture value missing');
	return value;
};
const workspace = (options: {
	manifest: EngineManifest;
	guest: { source: string };
	transforms: readonly string[];
}) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({ ...options, guest: yield* program(options.guest.source) })
		);
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context);
		const act = (authority: Authority, callable: string, input: Json, options: ActOptions = {}) =>
			actReply(
				route,
				authority,
				{ callable, input, issuedAt: t.clock.now() },
				{
					...(options.key === undefined ? {} : { 'Idempotency-Key': options.key }),
					...(options.retry ? { [HEADERS.retry]: '1' } : {})
				}
			).pipe(Effect.map((reply) => reply.outcome));
		return { t, act };
	});

it.live(
	'prepared native identities are actual final children and retry does not duplicate rows',
	() =>
		Effect.gen(function* () {
			const { t, act } = yield* workspace({ manifest, guest, transforms: ['orders'] });
			const caller = t.as(t.member(['operator']));
			const first = yield* act(
				caller.authority,
				'orders.create',
				{ title: 'native' },
				{ key: 'prepared-native' }
			);
			assert.equal(first.kind, 'committed', JSON.stringify(first));
			const rows = yield* t.db.read([
				{
					text: 'SELECT o.note,l.id::text AS id FROM orders o JOIN lines l ON l."order"=o.id',
					params: []
				}
			]);
			assert.equal(required(rows[0]).rows.length, 1);
			assert.equal(
				required(required(rows[0]).rows[0]).note,
				required(required(rows[0]).rows[0]).id
			);
			assert.deepEqual(
				yield* act(
					caller.authority,
					'orders.create',
					{ title: 'native' },
					{ key: 'prepared-native', retry: true }
				),
				first
			);
			const count = yield* t.db.read([
				{ text: 'SELECT count(*)::int AS count FROM lines', params: [] }
			]);
			assert.equal(required(required(count[0]).rows[0]).count, 1);
		})
);

it.live('invalid reservations and late refusal leave no parent or child writes', () =>
	Effect.gen(function* () {
		for (const title of ['foreign', 'badpath', 'conflict', 'unused', 'changed', 'late-refusal']) {
			const { t, act } = yield* workspace({ manifest, guest, transforms: ['orders'] });
			const outcome = yield* act(t.as(t.member(['operator'])).authority, 'orders.create', {
				title
			}).pipe(Effect.result);
			assert.equal(Result.isFailure(outcome) || outcome.success.kind !== 'committed', true, title);
			const count = yield* t.db.read([
				{
					text: 'SELECT (SELECT count(*) FROM orders)+(SELECT count(*) FROM lines) AS count',
					params: []
				}
			]);
			assert.equal(Number(required(required(count[0]).rows[0]).count), 0, title);
		}
	})
);

it.live('native child ACL and approval remain active after preparation', () =>
	Effect.gen(function* () {
		const { t, act } = yield* workspace({ manifest, guest, transforms: ['orders'] });
		const forbidden = yield* act(t.as(t.member(['rootonly'])).authority, 'orders.create', {
			title: 'forbidden'
		}).pipe(Effect.result);
		assert.equal(Result.isFailure(forbidden) || forbidden.success.kind !== 'committed', true);
		const outcome = yield* act(t.as(t.member(['review'])).authority, 'orders.create', {
			title: 'held'
		});
		assert.equal(outcome.kind, 'pendingApproval', JSON.stringify(outcome));
		// the provisional create commits root and prepared child at once; its request holds both
		const rows = yield* t.db.read([{ text: 'SELECT id FROM lines', params: [] }]);
		assert.equal(required(rows[0]).rows.length, 1);
		const requests = yield* t.db.read([
			{ text: 'SELECT jsonb_array_length(records) AS count FROM bolt_approvals', params: [] }
		]);
		assert.equal(required(required(requests[0]).rows[0]).count, 2);
	})
);

it.live('preparing a staged root keeps its minted identity and submitted values', () =>
	Effect.gen(function* () {
		const rootGuest = {
			source: `export default {collection:{orders:{bodies:{transform:function*(inputs,ctx){
  const root=ctx.staged.find(row=>!row.parent);
  const receipt=yield* ctx.db.prepareCreate('orders',{...inputs[0],note:'configured-calendar'},{path:root.path});
  if(receipt.id!==root.id||receipt.phase!=='PREPARED_NATIVE_CREATE'||receipt.committed!==false)yield* ctx.refuse('invalid engine phase');
  return [{...inputs[0],note:'configured-calendar'}];
 }}}}};`
		};
		const { t, act } = yield* workspace({ manifest, guest: rootGuest, transforms: ['orders'] });
		const result = yield* act(t.as(t.member(['operator'])).authority, 'orders.create', {
			title: 'original'
		});
		assert.equal(result.kind, 'committed', JSON.stringify(result));
		const rows = yield* t.db.read([{ text: 'SELECT title,note FROM orders', params: [] }]);
		assert.deepEqual(required(rows[0]).rows, [{ title: 'original', note: 'configured-calendar' }]);
	})
);

it.live('preparing a root cannot replace submitted fields', () =>
	Effect.gen(function* () {
		const rootGuest = {
			source: `export default {collection:{orders:{bodies:{transform:function*(inputs,ctx){
  const root=ctx.staged.find(row=>!row.parent);
  yield* ctx.db.prepareCreate('orders',{...inputs[0],title:'replaced'},{path:root.path});
  return [{...inputs[0],title:'replaced'}];
 }}}}};`
		};
		const { t, act } = yield* workspace({ manifest, guest: rootGuest, transforms: ['orders'] });
		const result = yield* act(t.as(t.member(['operator'])).authority, 'orders.create', {
			title: 'original'
		}).pipe(Effect.result);
		assert.equal(Result.isFailure(result) || result.success.kind !== 'committed', true);
		const rows = yield* t.db.read([
			{ text: 'SELECT count(*)::int AS count FROM orders', params: [] }
		]);
		assert.equal(required(required(rows[0]).rows[0]).count, 0);
	})
);

it.live('prospective reads refuse unavailable generated values instead of reporting null', () =>
	Effect.gen(function* () {
		const rootGuest = {
			source: `export default {collection:{orders:{bodies:{transform:function*(inputs,ctx){
  const root=ctx.staged.find(row=>!row.parent);
  yield* ctx.db.prepareCreate('orders',inputs[0],{path:root.path});
  yield* ctx.db.after('orders',{}, {all:true});
  return inputs;
 }}}}};`
		};
		const { t, act } = yield* workspace({ manifest, guest: rootGuest, transforms: ['orders'] });
		const result = yield* act(t.as(t.member(['operator'])).authority, 'orders.create', {
			title: 'generated'
		}).pipe(Effect.result);
		assert.equal(Result.isFailure(result) || result.success.kind !== 'committed', true);
		const rows = yield* t.db.read([
			{ text: 'SELECT count(*)::int AS count FROM orders', params: [] }
		]);
		assert.equal(required(required(rows[0]).rows[0]).count, 0);
	})
);

it.live('prepared native relationship pins are visible before final atomic commit', () =>
	Effect.gen(function* () {
		const simple: EngineManifest = {
			...manifest,
			models: {
				...manifest.models,
				orders: {
					...required(manifest.models.orders),
					fields: { title: { kind: 'text' }, note: { kind: 'text', optional: true } }
				}
			},
			policies: {
				operator: {
					description: 'Actual source pin writer',
					grants: {
						orders: { read: true, create: true },
						tags: { read: true, create: true, update: true }
					}
				}
			}
		};
		const pinGuest = {
			source: `export default {collection:{orders:{bodies:{transform:function*(inputs,ctx){
  const root=ctx.staged.find(row=>!row.parent);
  const values={...inputs[0],tags:{link:[inputs[0].note]}};
  const receipt=yield* ctx.db.prepareCreate('orders',values,{path:root.path});
  const mutation=receipt.related_actions.find(row=>row.collection==='tags'&&row.operation==='update');
  if(!mutation||mutation.phase!=='PREPARED_NATIVE_MUTATION'||mutation.committed!==false||mutation.invocation_id!==ctx.invocationId||mutation.previous.id!==inputs[0].note||mutation.previous.order!=null||mutation.previous_revision!==mutation.previous.revision)yield* ctx.refuse('source pin lost its actual pre-image phase');
  const visible=yield* ctx.db.after('tags',{order:{eq:receipt.id}},{select:{id:true,name:true,order:true,revision:true},all:true});
  if(visible.rows.length!==1||visible.rows[0].id!==inputs[0].note||visible.rows[0].order!==receipt.id)yield* ctx.refuse('native prospective source pin missing');
  if(visible.rows[0].revision!==mutation.previous_revision)yield* ctx.refuse('prospective pin invented a committed revision');
  if(inputs[0].title==='rollback')yield* ctx.refuse('source refused after its real prospective pin');
  return [values];
 }}}}};`
		};
		for (const title of ['commit', 'rollback']) {
			const { t, act } = yield* workspace({
				manifest: simple,
				guest: pinGuest,
				transforms: ['orders']
			});
			const caller = t.as(t.member(['operator']));
			assert.equal(
				(yield* act(caller.authority, 'tags.create', { name: 'actual source' })).kind,
				'committed'
			);
			const before = yield* t.db.read([{ text: 'SELECT id::text AS id FROM tags', params: [] }]);
			const id = String(required(required(before[0]).rows[0]).id);
			const result = yield* act(caller.authority, 'orders.create', { title, note: id }).pipe(
				Effect.result
			);
			const after = yield* t.db.read([
				{
					text: 'SELECT t."order"::text AS owner,(SELECT count(*)::int FROM orders) AS count FROM tags t',
					params: []
				}
			]);
			if (title === 'commit') {
				assert.equal(
					Result.isSuccess(result) && result.success.kind === 'committed',
					true,
					JSON.stringify(result)
				);
				assert.ok(required(required(after[0]).rows[0]).owner);
				assert.equal(required(required(after[0]).rows[0]).count, 1);
			} else {
				assert.equal(Result.isFailure(result) || result.success.kind !== 'committed', true);
				assert.equal(required(required(after[0]).rows[0]).owner, null);
				assert.equal(required(required(after[0]).rows[0]).count, 0);
			}
		}
	})
);

it.live(
	'private routing bootstrap exposes missing derived values without claiming completed financials',
	() =>
		Effect.gen(function* () {
			const incomplete: EngineManifest = {
				...manifest,
				models: {
					...manifest.models,
					orders: {
						...required(manifest.models.orders),
						fields: {
							title: { kind: 'text' },
							note: { kind: 'text', optional: true },
							derived_amount: { kind: 'int' }
						}
					}
				}
			};
			const bootstrap = {
				source: `export default {collection:{orders:{bodies:{transform:function*(inputs,ctx){
  const root=ctx.staged.find(row=>!row.parent);
  const receipt=yield* ctx.db.prepareCreate('orders',inputs[0],{path:root.path});
  const page=yield* ctx.db.after('orders',{id:{eq:receipt.id}},{select:{id:true,title:true,derived_amount:true},all:true});
  if(page.rows.length!==1||page.rows[0].title!==inputs[0].title||page.rows[0].derived_amount!==null)yield* ctx.refuse('incomplete routing source was misrepresented');
  if(inputs[0].title==='premature-price'&&page.rows[0].derived_amount==null)yield* ctx.refuse('financial pricing requires its actual derived amount');
  return inputs[0].title==='missing-final' ? inputs : [{...inputs[0],derived_amount:7}];
 }}}}};`
			};
			for (const title of ['complete', 'premature-price', 'missing-final']) {
				const { t, act } = yield* workspace({
					manifest: incomplete,
					guest: bootstrap,
					transforms: ['orders']
				});
				const result = yield* act(t.as(t.member(['operator'])).authority, 'orders.create', {
					title
				}).pipe(Effect.result);
				assert.equal(
					Result.isSuccess(result) && result.success.kind === 'committed',
					title === 'complete',
					JSON.stringify(result)
				);
				const rows = yield* t.db.read([
					{ text: 'SELECT title,derived_amount FROM orders', params: [] }
				]);
				assert.deepEqual(
					required(rows[0]).rows,
					title === 'complete' ? [{ title, derived_amount: 7 }] : []
				);
			}
		})
);
