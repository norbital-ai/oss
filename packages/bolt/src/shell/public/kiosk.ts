import { Effect, Option } from 'effect';
import type * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest';
import type { Authority } from '../../engine/contracts.ts';
import type { EngineManifest } from '../../engine/manifest.ts';
import { Identity } from '../../engine/services.ts';
import { canOpenKiosk, kioskOf } from '../../decl/runtime/kiosk.ts';
import { HEADERS } from '../../protocol/wire.ts';

export const requestKiosk = (
	request: HttpServerRequest.HttpServerRequest,
	query: boolean
): Option.Option<string> => {
	const value =
		request.headers[HEADERS.kiosk.toLowerCase()] ??
		(query ? new URL(request.url, 'http://bolt.local').searchParams.get('kiosk') : null);
	return value !== null && value !== undefined && /^[a-z][a-z0-9_]*$/.test(value)
		? Option.some(value)
		: Option.none();
};
export const kioskAuthority = Effect.fn('shell.kioskAuthority')(function* (
	manifest: EngineManifest,
	name: string,
	member: Authority | null,
	visitor: string
) {
	const spec = Option.getOrUndefined(kioskOf(manifest, name));
	if (
		spec === undefined ||
		spec.policies.length === 0 ||
		spec.policies.some((policy) => manifest.policies[policy] === undefined) ||
		(member === null ? spec.auth !== 'none' : !canOpenKiosk(manifest, name, member))
	)
		return Option.none<Authority>();
	const identity = yield* Identity;
	const authority = yield* identity.authority(
		{
			actor: member?.actor ?? { kind: 'visitor', app: name, visitor },
			policies: spec.policies,
			admin: false,
			...(member?.teamTree === undefined ? {} : { teamTree: member.teamTree }),
			...(member?.scopes === undefined ? {} : { scopes: member.scopes })
		},
		`kiosk:${name}:${member?.key ?? `visitor:${visitor}`}`
	);
	return Option.some({ ...authority, kiosk: name });
});
type KioskBoot =
	| { readonly _tag: 'Unknown' }
	| { readonly _tag: 'SignIn' }
	| { readonly _tag: 'Closed'; readonly message: string }
	| { readonly _tag: 'Member'; readonly authority: Authority }
	| { readonly _tag: 'Visitor'; readonly authority: Authority };
export const kioskBoot = Effect.fn('shell.kioskBoot')(function* (
	manifest: EngineManifest,
	name: string,
	member: Authority | null,
	visitor: string
): Effect.fn.Return<KioskBoot, never, Identity> {
	const spec = Option.getOrUndefined(kioskOf(manifest, name));
	if (spec === undefined) return { _tag: 'Unknown' };
	if (member === null && (spec.auth ?? 'members') !== 'none') return { _tag: 'SignIn' };
	const authority = yield* kioskAuthority(manifest, name, member, visitor);
	return Option.isNone(authority)
		? { _tag: 'Closed', message: 'This kiosk is not open to you.' }
		: member === null
			? { _tag: 'Visitor', authority: authority.value }
			: { _tag: 'Member', authority: authority.value };
});
