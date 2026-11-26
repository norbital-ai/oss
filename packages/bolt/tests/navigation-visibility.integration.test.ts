import { Effect, Schema } from 'effect';
import { expect } from '@effect/vitest';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { layer } from '../../bolt-cli/src/test/effect.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { manifest as base } from './engine-fixture.ts';

const rule = { model:'switches',output:'visible',field:'key',
  apps:{pilot:['feature']},pages:{'office/private':['feature','private']} } as const;
const manifest:EngineManifest={...base,
  workspace:{...base.workspace,navigation_visibility:rule},
  models:{...base.models,switches:{description:'Scoped feature keys',fields:{key:{kind:'text'},who:{kind:'text'}}}},
  exposures:{...base.exposures,switches:{outputs:{default:{switches:{fields:'all'}},visible:{switches:{fields:['key']}}}}},
  apps:{
    pilot:{title:'Pilot',description:'',icon:'i',pages:{overview:{title:'Overview'}}},
    office:{title:'Office',description:'',icon:'i',pages:{private:{title:'Private'},news:{title:'News'}}}
  },
  policies:{...base.policies,pages:{description:'Read assigned switch names',capabilities:{apps:['pilot','office']},
    grants:{switches:{outputs:{visible:{scopes:{switches:{who:{eq:{var:'actor.id'}}}}}}}}}}
};
const Reply=Schema.Struct({value:Schema.Struct({nav:Schema.Array(Schema.Struct({name:Schema.String,href:Schema.String,
  pages:Schema.Array(Schema.Struct({name:Schema.String}))}))})});
layer(TestWorkspace.layer({manifest,seed:{sys_team:[{id:'desk',name:'Desk',policies:['pages']}]},host:{public_url:'http://localhost',secure:false}}))('actor-scoped navigation',it=>{
  it.effect('keeps staff on allowed pages and rejects direct requests after revocation',()=>Effect.gen(function*(){
    const t=yield* TestWorkspace;
    const pilot='00000000-0000-4000-8000-000000009987',other='00000000-0000-4000-8000-000000009988';
    yield* t.as(t.member([],{id:pilot,email:'pilot@example.test',teams:['desk']}));
    yield* t.as(t.member([],{id:other,email:'other@example.test',teams:['desk']}));
    yield* t.db.write({text:"INSERT INTO switches (id,key,who) VALUES (gen_random_uuid(),'feature',$1),(gen_random_uuid(),'private',$1),(gen_random_uuid(),'private',$2)",params:[pilot,other]});
    const pilotCookie=yield* t.session(pilot), otherCookie=yield* t.session(other);
    const get=(path:string,cookie:string)=>t.handle(new Request('http://localhost'+path,{headers:{cookie}}));
    const nav=Effect.fnUntraced(function*(cookie:string){
      const response=yield* get('/__bolt/shell',cookie);
      expect(response.status).toBe(200);
      return Schema.decodeUnknownSync(Reply)(yield* Effect.promise(()=>response.json())).value.nav;
    });
    const yes=yield* nav(pilotCookie);
    expect(yes.map(app=>app.name).sort()).toEqual(['office','pilot']);
    expect(yes.find(app=>app.name==='office')?.pages.map(p=>p.name)).toContain('private');
    const no=yield* nav(otherCookie);
    expect(no.map(app=>app.name)).toEqual(['office']);
    expect(no[0]?.href).toBe('/app/office/news');
    expect(no[0]?.pages.map(page=>page.name)).toEqual(['news']);
    for(const path of ['/app/pilot/overview','/app/office/private']) {
      const denied=yield* get(path,otherCookie);
      expect(denied.status).toBe(404);
      expect(yield* Effect.promise(()=>denied.text())).toContain('No such page');
    }
    // Allowed private routes fall through to the static client artifact. The test host has no artifact.
    const allowed=yield* get('/app/office/private',pilotCookie);
    expect(yield* Effect.promise(()=>allowed.text())).not.toContain('No such page');
    yield* t.db.write({text:"DELETE FROM switches WHERE who=$1 AND key='feature'",params:[pilot]});
    expect((yield* nav(pilotCookie)).map(app=>app.name)).toEqual(['office']);
    expect((yield* get('/app/office/private',pilotCookie)).status).toBe(404);
  }));
});
