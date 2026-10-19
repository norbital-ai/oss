// Pure authored recipient callbacks run before the guarded statement; recipient fan-out remains transactional.
import { Effect, Schema } from 'effect';
import type { NotificationInput } from '../../decl/collection.ts';
import type { Json } from '../../decl/values.ts';
import { LIMITS, type Invocation, type NoticeRow } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { GuestShape as GuestPort } from '../services.ts';
import { BoltError } from '../../protocol/errors.ts';
import { canonical, minter } from '../write/sql.ts';
const Recipients = Schema.Array(Schema.Record(Schema.String, Schema.NonEmptyString));
type NativeNotificationInput = Omit<NotificationInput, 'approvers'> & {
	readonly approvers: readonly string[];
};
export const notificationRecipients = Effect.fn('Bolt.notificationRecipients')(function* (
	guest: GuestPort | undefined,
	manifest: EngineManifest,
	invocation: Omit<Invocation, 'kind' | 'input' | 'budget'>,
	input: NativeNotificationInput
) {
	if (guest === undefined)
		return yield* Effect.fail(
			BoltError.make(
				'noGuest',
				'guest',
				'notification recipients require the authored guest program'
			)
		);
	if (
		input.records.length > LIMITS.changesPerAct ||
		new TextEncoder().encode(JSON.stringify(input)).length > LIMITS.argsBytes
	)
		return yield* Effect.fail(
			BoltError.make(
				'tooLarge',
				'guest',
				'the notification event exceeds the native callback budget'
			)
		);
	const result = yield* guest.invoke(
		{
			...invocation,
			kind: 'notification',
			input,
			budget: { cpuMs: LIMITS.guestCpuMs, crossings: 0, readBytes: 0 }
		},
		{
			cross: (calls) =>
				Effect.succeed(
					calls.map(() => ({
						ok: false as const,
						error: {
							kind: 'bolt' as const,
							code: 'unsupported' as const,
							message: 'a recipient callback is pure'
						}
					}))
				)
		}
	);
	if (result.kind === 'failed') return yield* Effect.fail(result.error);
	if (result.kind === 'refused')
		return yield* Effect.fail(BoltError.make('guestError', 'guest', result.message));
	const recipients = yield* Schema.decodeUnknownEffect(Recipients)(result.output).pipe(
		Effect.mapError((error) =>
			BoltError.make(
				'guestError',
				'guest',
				'a recipient callback returns a list of member IDs, authored team handles or policy holders',
				error
			)
		)
	);
	if (recipients.length > LIMITS.changesPerAct)
		return yield* Effect.fail(
			BoltError.make('tooLarge', 'guest', 'the recipient callback returns too many recipients')
		);
	for (const recipient of recipients) {
		const keys = Object.keys(recipient);
		const key = keys[0];
		if (
			keys.length !== 1 ||
			key === undefined ||
			!['user', 'team', 'policy'].includes(key) ||
			(key === 'policy' && !Object.hasOwn(manifest.policies, recipient[key] ?? '')) ||
			(key === 'team' && !Object.hasOwn(manifest.teams, recipient[key] ?? ''))
		)
			return yield* Effect.fail(
				BoltError.make(
					'guestError',
					'guest',
					'each recipient names one member ID, authored team handle or existing policy'
				)
			);
	}
	return [...new Map(recipients.map((recipient) => [canonical(recipient), recipient])).values()];
});
