// Existing references join a new row through a create transform's carried update, in its atomic commit.
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest, authority, grants, write_arm } from './write-fixture.ts';

const inputs = (acts: Readonly<Record<string, Json>>) => acts;
const base = manifest.exposures.orders;
if (base?.create === undefined) throw new Error('The write fixture must expose orders.create.');
const m: EngineManifest = {
 ...manifest,
 relationships: { ...manifest.relationships, 'orders.tag': { to: 'tags', optional: true } },
 exposures: { ...manifest.exposures, orders: { ...base,
  create: { columns: { orders: ['title', 'tag'] }, transform: true }
 } }
};
const guest = program(`export default { model: { orders: { bodies: {
 create: function*(changes,ctx){
  const update=[];
  for(const {set,after} of changes){
   if(!set.tag)continue;
   const {tags}=yield* ctx.query({tags:{where:{id:{eq:set.tag},order:{is_null:true}},fields:['name','revision']}});
   const target=tags.rows[0];
   if(!target)return yield* ctx.refuse('This tag is already attached or missing.');
   update.push({target,set:{order:after.id}});
  }
  return {sets:changes.map(({set})=>set),with:{tags:{update}}};
 }
} } } };`);
const fixture = Effect.gen(function* () {
 const context = yield* Layer.build(TestWorkspace.layer({ manifest: m, guest: yield* guest }));
 const t = Context.get(context, TestWorkspace);
 // the writer reads the tag it links; it holds no write on tags
 const tags = grants('tags', { create: [], update: [], delete: [] });
 const caller = authority({ orders: grants('orders', { create: [write_arm({ orders: ['title', 'tag'] })] }), tags });
 const sealed = authority({ orders: grants('orders', { create: [write_arm({ orders: ['title'] })] }), tags });
 yield* (yield* t.body_acts(t.admin))(inputs({ 'tags.create': [{ name: 'free' }] }));
 const tag = yield* t.db.value(Schema.String, { text: "SELECT id::text FROM tags WHERE name='free'", params: [] });
 const linked = () => t.db.value(Schema.NullOr(Schema.String), { text: 'SELECT "order"::text FROM tags WHERE id=$1', params: [tag] });
 return { t, caller, sealed, tag, linked };
});
it.live('carries an existing optional ref in the same commit without a separate target write grant', () =>
 Effect.scoped(Effect.gen(function* () {
  const f = yield* fixture;
  const order = yield* (yield* f.t.body_acts(f.caller))(inputs({ 'orders.create': [{ title: 'one', tag: f.tag }] }));
  if (order.kind !== 'committed') throw new Error('The root and carried target must commit.');
  const root = order.records.find(({ model }) => model === 'orders');
  if (root === undefined) throw new Error('The commit omitted its root.');
  expect(yield* f.linked()).toBe(root.id);
  expect(order.records.map(({ model }) => model).sort()).toEqual(['orders', 'tags']);
 }))
);
it.live('refuses an already attached target and leaves the second parent absent', () =>
 Effect.scoped(Effect.gen(function* () {
  const f = yield* fixture;
  yield* (yield* f.t.body_acts(f.caller))(inputs({ 'orders.create': [{ title: 'one', tag: f.tag }] }));
  const before = yield* f.linked();
  expect(yield* Effect.flip((yield* f.t.body_acts(f.caller))(inputs({ 'orders.create': [{ title: 'two', tag: f.tag }] })))).toMatchObject({ _tag: 'ActRefused', code: 'refused' });
  expect(yield* f.linked()).toBe(before);
  expect(yield* f.t.db.rows(Schema.Struct({ title: Schema.String }), { text: 'SELECT title FROM orders', params: [] })).toEqual([{ title: 'one' }]);
 }))
);
it.live('requires the root grant to admit the selected reference and leaves the target unchanged on refusal', () =>
 Effect.scoped(Effect.gen(function* () {
  const f = yield* fixture;
  expect(yield* Effect.flip((yield* f.t.body_acts(f.sealed))(inputs({ 'orders.create': [{ title: 'one', tag: f.tag }] })))).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
  expect(yield* f.linked()).toBeNull();
  expect(yield* Effect.flip((yield* f.t.body_acts(f.caller))(inputs({ 'orders.create': [{ title: 'old shortcut', attaches: { tags: [f.tag] } }] })))).toMatchObject({ _tag: 'ActRefused', code: 'invalid_input' });
  expect(yield* f.t.db.value(Schema.Number, { text: 'SELECT count(*)::int FROM orders', params: [] })).toBe(0);
 }))
);
