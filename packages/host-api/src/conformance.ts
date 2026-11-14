// The conformance kit: what any host checks of a release before serving it, and what every release must answer.
// Framework-free: each check is a named Promise a host runs in its own test runner, against a release on its own disk.
import { Schema } from 'effect';
import { ReleaseFacts } from './answers.ts';
import { HostApiFailure } from './failure.ts';
import type { HostApiCore, Release } from './ports.ts';
import { supports, type HostApiRange } from './version.ts';

/** One conformance check: its name, and the Promise that rejects with why the release fails it. */
export type Check = { readonly name: string; readonly run: () => Promise<void> };

const expect = (ok: boolean, message: string) => {
	if (!ok) throw new Error(message);
};
const signal = () => ({ signal: AbortSignal.timeout(30_000) });

/**
 * The checks for one release: `release` as built, and `tampered`, the same release with one of its files changed after
 * the build (the release must refuse it with an encoded `HostFailure`).
 */
export const conformance = (input: {
	readonly api: HostApiCore;
	readonly range: HostApiRange;
	readonly release: Release;
	readonly tampered: Release;
}): readonly Check[] => {
	const { api, range, release, tampered } = input;
	return [
		{
			name: 'speaks a HOST_API in the host range',
			run: async () =>
				expect(
					supports(range, api.version),
					`HOST_API ${api.version} is outside ${range.from}–${range.to}`
				)
		},
		{
			name: 'evaluates tenant source',
			run: async () => expect(api.guest_execution === 'source', 'guest_execution is not source')
		},
		{
			name: 'names its contract and cookies',
			run: async () =>
				expect(
					api.contract !== '' &&
						api.cookies.session !== '' &&
						api.cookies.preview !== '' &&
						typeof api.cookie_site(true) === 'string' &&
						typeof api.cookie_site(false) === 'string',
					'contract, cookies or cookie_site is empty'
				)
		},
		{
			name: 'verifies its own release',
			run: () => api.verify(release, signal())
		},
		{
			name: 'refuses a tampered release with an encoded HostFailure',
			run: async () => {
				const failure = await api.verify(tampered, signal()).then(
					() => undefined,
					(error: unknown) => error
				);
				const decoded = Schema.decodeUnknownOption(HostApiFailure)(failure);
				expect(
					decoded._tag === 'Some' && decoded.value._tag === 'HostFailure',
					`a tampered release answered ${String(failure)}`
				);
			}
		},
		{
			name: 'describes itself',
			run: async () => {
				Schema.decodeUnknownSync(ReleaseFacts)(await api.describe(release, signal()));
			}
		},
		{
			name: 'answers a frame policy',
			run: async () =>
				expect(
					(await api.frame_policy(release, '/', signal())).startsWith('frame-ancestors '),
					'the frame policy is not a frame-ancestors directive'
				)
		}
	];
};
