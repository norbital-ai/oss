// One generated verb as every caller commits it: a batch of one through `commitActs`.
import { Effect } from 'effect';
import { commitActs } from '../../src/engine/callables/index.ts';
import type { ActsRequest } from '../../src/engine/services.ts';
import type { ActRequest, WriteEngine } from '../../src/engine/write/act.ts';

export type OneAct = Omit<ActRequest, 'mode' | 'restored'> &
	Pick<ActsRequest, 'issuedAt' | 'retry' | 'rate' | 'restored' | 'sync'>;
export const one_act = ({ model, verb, input, observed, on_conflict, ...rest }: OneAct): ActsRequest => ({
	...rest,
	from: 'Client',
	name: `${model}.${verb}`,
	acts: [
		{
			model,
			verb,
			input,
			...(observed === undefined ? {} : { observed }),
			...(on_conflict === undefined ? {} : { on_conflict })
		}
	]
});
/** Commits a batch over a bare write engine: no live hub, so `v` is 0 and nothing is published. */
export const acts_on = (e: WriteEngine) => (r: ActsRequest) =>
	commitActs({ ...e, v: Effect.succeed(0), publish: () => Effect.succeed(0) }, r, e.log);
export const act_one = (e: WriteEngine, r: OneAct) => acts_on(e)(one_act(r));
