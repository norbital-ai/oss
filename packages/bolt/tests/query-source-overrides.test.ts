import {describe,it,expect} from 'vitest';
import {catalog} from '../src/protocol/catalog.ts';
import {read,get,aggregate,select,where} from '../src/protocol/ir.ts';
import {compile,compileGets,whereSql,grantSql} from '../src/engine/query/sql.ts';
import {bindings,manifest,rep} from './query.fixture.ts';

const cat=catalog(manifest);
const workspace={as:'workspace'} as const;
const sources=new Map([['accounts','__bolt_prepared_0'],['orders','__bolt_prepared_1'],['lines','__bolt_prepared_2']]);
const options={sources};

describe('engine-owned prospective query sources',()=>{
 it('routes root, relation predicates, nested selections and aggregation paths through the same sources',()=>{
  const queries=[
   read(cat,'accounts',{all:true,where:{orders:{some:{status:{eq:'open'}}}},select:{name:true,orders:{all:true,select:{status:true,lines:{all:true,select:{sku:true}}}}}}),
   read(cat,'orders',{all:true,select:{account:{select:{name:true}}}}),
   aggregate(cat,'orders',{by:['account.region'],count:true,sum:['total'],all:true})
  ];
  for(const query of queries){
   const ordinary=compile(cat,query,workspace,bindings);
   const prospective=compile(cat,query,workspace,bindings,undefined,options);
   expect(prospective.sql.params).toEqual(ordinary.sql.params);
   expect(prospective.sql.text).toContain('"__bolt_prepared_0"');
   expect(prospective.sql.text).toContain('"__bolt_prepared_1"');
   expect(prospective.sql.text).not.toMatch(/FROM "(?:accounts|orders|lines)"/);
  }
 });
 it('keeps caller scope and masks when replacing physical sources',()=>{
  const query=read(cat,'orders',{limit:3,select:{total:true,account:{select:{name:true}}}});
  const ordinary=compile(cat,query,{as:'caller',authority:rep},bindings);
  const prospective=compile(cat,query,{as:'caller',authority:rep},bindings,undefined,options);
  expect(prospective.sql.params).toEqual(ordinary.sql.params);
  expect(prospective.sql.text).toContain('CASE WHEN');
  expect(prospective.sql.text).not.toMatch(/FROM "(?:accounts|orders)"/);
 });
 it('routes single, batched and predicate reads, quoting source identifiers as identifiers',()=>{
  const id='00000000-0000-4000-8000-000000000001';
  expect(compile(cat,get(cat,'orders',id),workspace,bindings,undefined,options).sql.text).toContain('FROM "__bolt_prepared_1"');
  expect(compileGets(cat,'orders',[id],select(cat,'orders',{status:true}),workspace,bindings,options).text).toContain('FROM "__bolt_prepared_1"');
  const predicate=where(cat,'orders',{account:{is:{region:{eq:'north'}}}});
  for(const sql of [whereSql(cat,'orders',predicate,workspace,bindings,options),grantSql(cat,'orders',predicate,rep,bindings,options)]){
   expect(sql.text).toContain('FROM "__bolt_prepared_0"');
   expect(sql.text).toContain('FROM "__bolt_prepared_1"');
  }
  const odd={sources:new Map([['orders','prepared"name']])};
  expect(compile(cat,get(cat,'orders',id),workspace,bindings,undefined,odd).sql.text).toContain('FROM "prepared""name"');
 });
});
