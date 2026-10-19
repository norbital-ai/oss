import * as Predicate from 'effect/Predicate';
import type { ActFailure } from './act.ts';

/** Select the failure decoder without constructing error schemas for successful writes. */
export const actFailureTag = (outcome: unknown): ActFailure['_tag'] | undefined => {
	if (!Predicate.hasProperty(outcome, 'kind')) return undefined;
	switch (outcome.kind) {
		case 'refused':
			return 'ActRefused';
		case 'conflict':
			return 'ActConflict';
		case 'unknown':
			return 'ActUnknown';
		default:
			return undefined;
	}
};
