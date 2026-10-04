import { compileAuthority } from './authority.ts';
import { BoltError, type Authority, type EngineManifest } from '../contracts.ts';

/** An opaque, non-wire capability issued only by the native run bridge. */
export type AutomationDelegation = Readonly<{ run: string; automation: string }>;
const issued = new WeakMap<AutomationDelegation,{manifest:EngineManifest;authority:Authority}>();
export function issueAutomationDelegation(manifest:EngineManifest,authority:Authority,run:string,automation:string):AutomationDelegation {
 const token=Object.freeze({run,automation});
 issued.set(token,{manifest,authority});
 return token;
}
/** Add only the declared target verb's arms; reads and every other verb remain the trigger's. */
export function delegatedVerbAuthority(manifest:EngineManifest,authority:Authority,token:AutomationDelegation|undefined,callable:string):Authority {
 if(token===undefined)return authority;
 const native=issued.get(token);
 if(native===undefined||native.manifest!==manifest||native.authority!==authority)throw new BoltError('forbidden','admission','Automation delegation requires its immutable native run principal.');
 const matches=manifest.automations[token.automation]?.delegations?.filter(item=>item.verb===callable)??[];
 if(matches.length===0)return authority;
 const dot=callable.lastIndexOf('.'),collection=callable.slice(0,dot),verb=callable.slice(dot+1);
 if(verb!=='create'&&verb!=='update'&&verb!=='delete')throw new BoltError('forbidden','admission','Automation delegates only an exact native generated verb.');
 const policies=matches.map(item=>item.policy);
 const own=authority.collections[collection];
 if(own===undefined)throw new BoltError('forbidden','admission','Automation delegation requires its native target collection.');
 const delegated=compileAuthority(manifest,{actor:authority.actor,policies,admin:false,teamTree:authority.teamTree,scopes:authority.scopes},`${authority.key}:automation:${token.automation}:${callable}`);
 const arms=delegated.collections[collection]?.[verb]??[];
 if(arms.length===0)throw new BoltError('forbidden','admission','The declared automation policy has no exact target verb grant.');
 return {...authority,key:`${authority.key}:run:${token.run}:${callable}`,policies:[...new Set([...authority.policies,...policies])],collections:{...authority.collections,[collection]:{...own,[verb]:[...own[verb],...arms]}}};
}
