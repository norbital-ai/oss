// A view's source: a native read (`bolt.query`, `bolt.aggregate`, a declared query) or a local array.
import type { Query } from '../client/contract.js';
import type { Values } from '../collection/types.js';
import { queryState, type ReadState } from './state.js';

export type ViewSource = Query<unknown> | readonly Values[];
const local = (source: ViewSource): source is readonly Values[] => Array.isArray(source);
/** The source's state: a local array is ready at once; a read is live while the view reads it. */
export const sourceState = (source: ViewSource): ReadState<unknown> =>
	local(source) ? { kind: 'ready', value: source } : queryState(source);
