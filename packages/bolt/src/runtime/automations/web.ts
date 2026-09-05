import { Effect, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { WebPage, WEB_READ_OPERATION } from '@norbital-ai/bolt-protocol';
import { FacilityError } from '#lib/runtime/facilities/database.js';
import type { ConnectorInterface } from '#lib/runtime/facilities/services.js';

/** Every request is a marshalled connector call; tenant code never opens a socket. */
export const webReader = (effectId: EffectId, connector: ConnectorInterface) => {
	let sequence = 0;
	return (url: string): Effect.Effect<WebPage, FacilityError> =>
		Effect.gen(function* () {
			const response = yield* connector.execute(EffectId.make(`${effectId}:web:${sequence++}`), {
				connector: 'web',
				operation: WEB_READ_OPERATION,
				input: { url }
			});
			return yield* Schema.decodeUnknownEffect(WebPage)(response.output).pipe(
				Effect.mapError(
					() =>
						new FacilityError({
							operation: WEB_READ_OPERATION,
							code: 'web.invalid_response',
							message: 'Web connector returned an invalid page.',
							retryable: false,
							outcome: 'known'
						})
				)
			);
		});
};
