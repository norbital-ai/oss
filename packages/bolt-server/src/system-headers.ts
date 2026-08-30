import {
	GATEWAY_SECRET_VARIABLE,
	SYSTEM_SIGNATURE_HEADER,
	SYSTEM_TIMESTAMP_HEADER,
	systemSignaturePayload
} from '@norbital-ai/bolt-protocol';
import { Clock, Effect, Redacted, Schema } from 'effect';
import { createHmac } from 'node:crypto';

/**
 * The host refused to dispatch unsigned rather than let the guest report a missing credential.
 *
 * `host.*` and `sync.advance` are system-only. An unsigned call is refused by the runtime as
 * unauthorized, which would send an operator looking at the wrong thing. Failing here names the
 * variable that has to be set.
 */
class HostUnsignedError extends Schema.TaggedError<HostUnsignedError>()(
	'BoltServer.HostUnsignedError',
	{
		operation: Schema.String,
		message: Schema.NonEmptyString
	}
) {}

/**
 * The headers that make one invocation run as the system principal.
 *
 * The payload comes from the protocol package's `systemSignaturePayload` rather than a rendering
 * kept here: the runtime rebuilds it from what arrived and compares, and two renderings of "the
 * bytes we sign" is how such a check comes to pass on something nobody meant to authorize.
 */
export const systemCommandHeaders = (
	gatewaySecret: Redacted.Redacted<string> | undefined,
	command: string,
	tenantId: string,
	input: unknown
): Effect.Effect<Record<string, Array<string>>, HostUnsignedError> =>
	Effect.gen(function* () {
		if (gatewaySecret === undefined) {
			return yield* new HostUnsignedError({
				operation: command,
				message: `${GATEWAY_SECRET_VARIABLE} is not configured, so this host cannot prove itself to its own bundle`
			});
		}
		const timestamp = yield* Clock.currentTimeMillis;
		const digest = createHmac('sha256', Redacted.value(gatewaySecret))
			.update(systemSignaturePayload({ timestamp, command, tenantId, input }), 'utf8')
			.digest('hex');
		return {
			[SYSTEM_SIGNATURE_HEADER]: [digest],
			[SYSTEM_TIMESTAMP_HEADER]: [String(timestamp)]
		};
	});
