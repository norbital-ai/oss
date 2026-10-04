import type { Json } from '../../decl/values.ts';
import type { Bindings, EngineManifest, ReadIR, Reader, RowData, SelectIR } from '../contracts.ts';
import { BoltError } from '../contracts.ts';
import { applyReadProjection, assertReadSubset } from './projection.ts';

type Declaration = { fields: readonly string[]; context: readonly string[] };
type ProjectionPorts = {
 manifest: EngineManifest;
 context(collection: string, id: string, columns: readonly string[], revision: number | undefined, bindings: Bindings): Promise<RowData | null>;
 invoke(collection: string, record: RowData, fields: readonly string[], reader: Extract<Reader,{as:'caller'}>, bindings: Bindings): Promise<Json>;
};
const object = (value: Json): RowData | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RowData : undefined;

/** Runs only after the original native row and field authorization has succeeded. */
export function readProjector(ports: ProjectionPorts) {
 const declarations = new Map<string, Declaration>();
 for (const [name, spec] of Object.entries(ports.manifest.collections)) {
  const declaration = (spec.read as typeof spec.read & { projection?: Declaration }).projection;
  if (declaration !== undefined) declarations.set(name, declaration);
 }
 return async (read: ReadIR, answer: Json, reader: Reader, bindings: Bindings): Promise<Json> => {
  if (reader.as !== 'caller' || declarations.size === 0) return answer;
  const caller = reader;
  async function row(collection: string, selected: RowData, select?: SelectIR, revision?: number): Promise<RowData> {
   let result = { ...selected };
   const declaration = declarations.get(collection);
   const fields = declaration?.fields.filter(field => Object.hasOwn(selected, field) && !(object(selected[field]!)?.['$masked'] === true)) ?? [];
   if (fields.length > 0 && declaration !== undefined) {
    if (typeof selected['id'] !== 'string') throw new BoltError('invalid', 'deliver', 'Projected native row requires its actual identity.');
    const context = await ports.context(collection, selected['id'], [...new Set([...declaration.context,...fields])], revision, bindings);
    if (context === null || context['id'] !== selected['id']) throw new BoltError('forbidden', 'deliver', 'Original read projection context is unavailable.');
    for (const field of fields) {
     if (!Object.hasOwn(context,field)) throw new BoltError('forbidden','deliver','Original projected input capture is unavailable.');
     assertReadSubset(context[field]!, selected[field]!); assertReadSubset(selected[field]!, context[field]!);
    }
    for(const column of declaration.context) {
     if(!Object.hasOwn(selected,column)||object(selected[column]!)?.['$masked']===true)continue;
     if(!Object.hasOwn(context,column))throw new BoltError('forbidden','deliver','Original read context changed during projection.');
     assertReadSubset(context[column]!,selected[column]!); assertReadSubset(selected[column]!,context[column]!);
    }
    const captured = { ...selected, ...context };
    const narrowed = await ports.invoke(collection, captured, fields, caller, bindings);
    result = { ...applyReadProjection(selected, narrowed, fields) };
   }
   for (const [name, relation] of Object.entries(select?.relations ?? {})) {
    const value = selected[name];
    if (value === undefined || value === null) continue;
    if (relation.many) {
     if (!Array.isArray(value)) throw new BoltError('invalid','deliver','Projected native relation requires its original rows.');
     result[name] = await Promise.all(value.map(async item => {
      const existing = object(item);
      if (existing === undefined) throw new BoltError('invalid','deliver','Projected native relation requires original records.');
      return row(relation.target, existing, relation.select);
     }));
    } else {
     const existing = object(value);
     if (existing === undefined) throw new BoltError('invalid','deliver','Projected native relation requires its original record.');
     result[name] = await row(relation.target, existing, relation.select);
    }
   }
   return result;
  }
  if (read.kind === 'get') return answer === null ? null : row(read.collection, object(answer)!, read.select);
  if (read.kind === 'read') {
   const page = object(answer);
   if (page === undefined || !Array.isArray(page['rows'])) return answer;
   return { ...page, rows: await Promise.all(page['rows'].map(value => row(read.collection, object(value)!, read.select))) };
  }
  if (read.kind === 'similar') return Array.isArray(answer) ? Promise.all(answer.map(value => row(read.collection, object(value)!, read.select))) : answer;
  if (read.kind === 'history') {
   if (read.full === true) {
    const record = object(answer);
    return record === undefined ? answer : row(read.collection, record, undefined, typeof record['revision'] === 'number' ? record['revision'] : undefined);
   }
   if (!Array.isArray(answer)) return answer;
   return Promise.all(answer.map(async value => {
    const entry = object(value), changed = entry === undefined ? undefined : object(entry['changed']!);
    if (entry === undefined || changed === undefined) return value;
    if (typeof entry['revision'] !== 'number') throw new BoltError('invalid','deliver','Read projection requires the actual historical revision.');
    const projected = await row(read.collection, { ...changed, id: read.id }, undefined, entry['revision']);
    const { id: _identity, ...fields } = projected;
    return { ...entry, changed: fields };
   }));
  }
  return answer;
 };
}
