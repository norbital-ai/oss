// A view's source: a native read (`bolt.aggregate` by buckets, a declared query) or a local array.
import type { Query } from '../client/contract.js';
import type { Page, Values } from '../model/types.js';
import { queryState, type ReadState } from './state.js';

/** A source's rows: a page (an aggregate's buckets) or an array. */
export type SourceRows = Page<Values> | readonly Values[];
export type ViewSource = Query<SourceRows> | readonly Values[];
const local = (source: ViewSource): source is readonly Values[] => Array.isArray(source);
/** The source's state: a local array is ready at once; a read is live while the view reads it. */
export const sourceState = (source: ViewSource): ReadState<SourceRows> =>
	local(source) ? { kind: 'ready', value: source } : queryState(source);
