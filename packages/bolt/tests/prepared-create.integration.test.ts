import assert from 'node:assert/strict';
import {test} from 'vitest';
import {testWorkspace} from '../src/test/index.ts';
import type {EngineManifest} from '../src/engine/contracts.ts';
import {manifest as base} from './write-fixture.ts';

const manifest:EngineManifest={...base,policies:{operator:{description:'Native writer',grants:{orders:{read:true,create:true},lines:{read:true,create:true}}},rootonly:{description:'No child grant',grants:{orders:{read:true,create:true}}},review:{description:'Native approval',grants:{orders:{read:true,create:true},lines:{read:true,create:{approval:[{steps:[['Finance']]}]}}}}}};
const guest={source:`export default {collection:{orders:{bodies:{transform:async(inputs,ctx)=>{
 const root=ctx.staged.find(r=>r.collection==='orders'&&!r.parent);
 const path=[...root.path,'lines','create',0];
 const title=inputs[0].title;
 const first=await ctx.db.prepareCreate(title==='foreign'?'tags':'lines',{label:'reserved',amount:'7.50'},{path:title==='badpath'?[...root.path,'missing','create',0]:path});
 if(first.committed!==false)ctx.refuse('preparation cannot claim a commit');
 if(title==='conflict')await ctx.db.prepareCreate('lines',{label:'changed',amount:'7.50'},{path});
 if(title==='late-refusal')ctx.refuse('late source refusal');
 if(title==='unused')return inputs;
 const again=await ctx.db.prepareCreate('lines',{label:'reserved',amount:'7.50'},{path});
 if(again.id!==first.id)ctx.refuse('native reservation identity changed');
 return [{...inputs[0],note:first.id,lines:{create:[{label:title==='changed'?'changed':'reserved',amount:'7.50'}]}}];
}}}}};`};

test('prepared native identities are actual final children and retry does not duplicate rows',async()=>{
 const t=await testWorkspace({manifest,guest,transforms:['orders']});
 const caller=t.as(t.member(['operator']));
 const first=await caller.act('orders.create',{title:'native'},{key:'prepared-native'});
 assert.equal(first.kind,'committed',JSON.stringify(first));
 const rows=await t.db.read([{text:'SELECT o.note,l.id::text AS id FROM orders o JOIN lines l ON l."order"=o.id',params:[]}]);
 assert.equal(rows[0]!.rows.length,1);assert.equal(rows[0]!.rows[0]!.note,rows[0]!.rows[0]!.id);
 assert.deepEqual(await caller.act('orders.create',{title:'native'},{key:'prepared-native',retry:true}),first);
 const count=await t.db.read([{text:'SELECT count(*)::int AS count FROM lines',params:[]}]);assert.equal(count[0]!.rows[0]!.count,1);
});

test('invalid reservations and late refusal leave no parent or child writes',async()=>{
 for(const title of ['foreign','badpath','conflict','unused','changed','late-refusal']){
  const t=await testWorkspace({manifest,guest,transforms:['orders']});
  const outcome=await t.as(t.member(['operator'])).act('orders.create',{title});
  assert.notEqual(outcome.kind,'committed',title);
  const count=await t.db.read([{text:'SELECT (SELECT count(*) FROM orders)+(SELECT count(*) FROM lines) AS count',params:[]}]);assert.equal(Number(count[0]!.rows[0]!.count),0,title);
 }
});

test('native child ACL and approval remain active after preparation',async()=>{
 const t=await testWorkspace({manifest,guest,transforms:['orders']});
 assert.notEqual((await t.as(t.member(['rootonly'])).act('orders.create',{title:'forbidden'})).kind,'committed');
 const outcome=await t.as(t.member(['review'])).act('orders.create',{title:'held'});
 assert.equal(outcome.kind,'pendingApproval',JSON.stringify(outcome));
 const rows=await t.db.read([{text:'SELECT approval_id FROM lines',params:[]}]);assert.equal(rows[0]!.rows.length,1);assert.ok(rows[0]!.rows[0]!.approval_id);
});

test('preparing a staged root keeps its minted identity and submitted values',async()=>{
 const rootGuest={source:`export default {collection:{orders:{bodies:{transform:async(inputs,ctx)=>{
  const root=ctx.staged.find(row=>!row.parent);
  const receipt=await ctx.db.prepareCreate('orders',{...inputs[0],note:'configured-calendar'},{path:root.path});
  if(receipt.id!==root.id||receipt.phase!=='PREPARED_NATIVE_CREATE'||receipt.committed!==false)ctx.refuse('invalid engine phase');
  return [{...inputs[0],note:'configured-calendar'}];
 }}}}};`};
 const t=await testWorkspace({manifest,guest:rootGuest,transforms:['orders']});
 const result=await t.as(t.member(['operator'])).act('orders.create',{title:'original'});
 assert.equal(result.kind,'committed',JSON.stringify(result));
 const rows=await t.db.read([{text:'SELECT title,note FROM orders',params:[]}]);
 assert.deepEqual(rows[0]!.rows,[{title:'original',note:'configured-calendar'}]);
});

test('preparing a root cannot replace submitted fields',async()=>{
 const rootGuest={source:`export default {collection:{orders:{bodies:{transform:async(inputs,ctx)=>{
  const root=ctx.staged.find(row=>!row.parent);
  await ctx.db.prepareCreate('orders',{...inputs[0],title:'replaced'},{path:root.path});
  return [{...inputs[0],title:'replaced'}];
 }}}}};`};
 const t=await testWorkspace({manifest,guest:rootGuest,transforms:['orders']});
 const result=await t.as(t.member(['operator'])).act('orders.create',{title:'original'});
 assert.notEqual(result.kind,'committed');
 const rows=await t.db.read([{text:'SELECT count(*)::int AS count FROM orders',params:[]}]);
 assert.equal(rows[0]!.rows[0]!.count,0);
});

test('prospective reads refuse unavailable generated values instead of reporting null',async()=>{
 const rootGuest={source:`export default {collection:{orders:{bodies:{transform:async(inputs,ctx)=>{
  const root=ctx.staged.find(row=>!row.parent);
  await ctx.db.prepareCreate('orders',inputs[0],{path:root.path});
  await ctx.db.after('orders',{}, {all:true});
  return inputs;
 }}}}};`};
 const t=await testWorkspace({manifest,guest:rootGuest,transforms:['orders']});
 const result=await t.as(t.member(['operator'])).act('orders.create',{title:'generated'});
 assert.notEqual(result.kind,'committed');
 const rows=await t.db.read([{text:'SELECT count(*)::int AS count FROM orders',params:[]}]);
 assert.equal(rows[0]!.rows[0]!.count,0);
});

test('prepared native relationship pins are visible before final atomic commit',async()=>{
 const simple:EngineManifest={...manifest,models:{...manifest.models,orders:{...manifest.models.orders!,fields:{title:{kind:'text'},note:{kind:'text',optional:true}}}},policies:{operator:{description:'Actual source pin writer',grants:{orders:{read:true,create:true},tags:{read:true,create:true,update:true}}}}};
 const pinGuest={source:`export default {collection:{orders:{bodies:{transform:async(inputs,ctx)=>{
  const root=ctx.staged.find(row=>!row.parent);
  const values={...inputs[0],tags:{link:[inputs[0].note]}};
  const receipt=await ctx.db.prepareCreate('orders',values,{path:root.path});
  const mutation=receipt.related_actions.find(row=>row.collection==='tags'&&row.operation==='update');
  if(!mutation||mutation.phase!=='PREPARED_NATIVE_MUTATION'||mutation.committed!==false||mutation.invocation_id!==ctx.invocationId||mutation.previous.id!==inputs[0].note||mutation.previous.order!=null||mutation.previous_revision!==mutation.previous.revision)ctx.refuse('source pin lost its actual pre-image phase');
  const visible=await ctx.db.after('tags',{order:{eq:receipt.id}},{select:{id:true,name:true,order:true,revision:true},all:true});
  if(visible.rows.length!==1||visible.rows[0].id!==inputs[0].note||visible.rows[0].order!==receipt.id)ctx.refuse('native prospective source pin missing');
  if(visible.rows[0].revision!==mutation.previous_revision)ctx.refuse('prospective pin invented a committed revision');
  if(inputs[0].title==='rollback')ctx.refuse('source refused after its real prospective pin');
  return [values];
 }}}}};`};
 for(const title of ['commit','rollback']){
  const t=await testWorkspace({manifest:simple,guest:pinGuest,transforms:['orders']});
  const caller=t.as(t.member(['operator']));
  assert.equal((await caller.act('tags.create',{name:'actual source'})).kind,'committed');
  const before=await t.db.read([{text:'SELECT id::text AS id FROM tags',params:[]}]);
  const id=String(before[0]!.rows[0]!.id);
  const result=await caller.act('orders.create',{title,note:id});
  const after=await t.db.read([{text:'SELECT t."order"::text AS owner,(SELECT count(*)::int FROM orders) AS count FROM tags t',params:[]}]);
  if(title==='commit'){assert.equal(result.kind,'committed',JSON.stringify(result));assert.ok(after[0]!.rows[0]!.owner);assert.equal(after[0]!.rows[0]!.count,1);}
  else {assert.notEqual(result.kind,'committed');assert.equal(after[0]!.rows[0]!.owner,null);assert.equal(after[0]!.rows[0]!.count,0);}
 }
});

test('private routing bootstrap exposes missing derived values without claiming completed financials',async()=>{
 const incomplete:EngineManifest={...manifest,models:{...manifest.models,orders:{...manifest.models.orders!,fields:{title:{kind:'text'},note:{kind:'text',optional:true},derived_amount:{kind:'int'}}}}};
 const bootstrap={source:`export default {collection:{orders:{bodies:{transform:async(inputs,ctx)=>{
  const root=ctx.staged.find(row=>!row.parent);
  const receipt=await ctx.db.prepareCreate('orders',inputs[0],{path:root.path});
  const page=await ctx.db.after('orders',{id:{eq:receipt.id}},{select:{id:true,title:true,derived_amount:true},all:true});
  if(page.rows.length!==1||page.rows[0].title!==inputs[0].title||page.rows[0].derived_amount!==null)ctx.refuse('incomplete routing source was misrepresented');
  if(inputs[0].title==='premature-price'&&page.rows[0].derived_amount==null)ctx.refuse('financial pricing requires its actual derived amount');
  return inputs[0].title==='missing-final' ? inputs : [{...inputs[0],derived_amount:7}];
 }}}}};`};
 for(const title of ['complete','premature-price','missing-final']){
  const t=await testWorkspace({manifest:incomplete,guest:bootstrap,transforms:['orders']});
  const result=await t.as(t.member(['operator'])).act('orders.create',{title});
  assert.equal(result.kind==='committed',title==='complete',JSON.stringify(result));
  const rows=await t.db.read([{text:'SELECT title,derived_amount FROM orders',params:[]}]);
  assert.deepEqual(rows[0]!.rows,title==='complete'?[{title,derived_amount:7}]:[]);
 }
});
