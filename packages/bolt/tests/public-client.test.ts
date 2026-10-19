import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { Decimal } from '@norbital-ai/std/decimal';
import { inputSchema } from '@norbital-ai/std/kind';
import { decodePublicHydration, PublicBoot, toPublicBoot } from '../src/protocol/public-page.ts';
import type { ShellBoot } from '../src/shell/nav.ts';
import { storedFileUrl } from '../src/page/file-ref.ts';

const boot: PublicBoot = {
	workspace: { name: 'Public fixture', locale: 'en-SG', tz: 'Asia/Singapore' },
	actor: null,
	base: '/fixture',
	visitor: { app: 'portal' },
	kiosk: null,
	contract: 'fixture-contract',
	describe: false,
	messages: {},
	catalog: {}
};
const data = Schema.Struct({ title: Schema.String, amount: Schema.Number });
const body = {
	route: 'app/portal/book',
	release: 'release-a',
	locale: 'en-SG',
	boot,
	data: { title: 'Book', amount: 0 }
};

it('keeps native image previews and original downloads within one encoded public surface', () => {
	expect(storedFileUrl('/fixture', 'file/a?b')).toBe('/fixture/__bolt/files/file%2Fa%3Fb');
	for (const preview of [64, 512, 1024] as const) {
		const url = new URL(
			storedFileUrl('/fixture', 'file', { preview }, { app: 'public/jobs' }),
			'https://workspace.test'
		);
		expect([...url.searchParams]).toEqual([
			['preview', String(preview)],
			['app', 'public/jobs']
		]);
	}
	const kiosk = new URL(
		storedFileUrl('/fixture', 'file', {}, { kiosk: 'lobby' }),
		'https://workspace.test'
	);
	expect([...kiosk.searchParams]).toEqual([['kiosk', 'lobby']]);
	expect(kiosk.searchParams.has('preview')).toBe(false);
	expect(kiosk.searchParams.has('app')).toBe(false);
});

it.effect(
	'decodes exact public data and refuses a different route, release, locale or codec shape',
	() =>
		Effect.gen(function* () {
			expect(
				yield* decodePublicHydration(JSON.stringify(body), data, {
					route: body.route,
					release: body.release
				})
			).toEqual({ boot, data: body.data });
			for (const changed of [
				{ ...body, route: 'app/portal/visits' },
				{ ...body, release: 'release-b' },
				{ ...body, locale: 'fr' },
				{ ...body, data: { title: 'Book', amount: '0' } }
			]) {
				const result = yield* Effect.result(
					decodePublicHydration(JSON.stringify(changed), data, {
						route: body.route,
						release: body.release
					})
				);
				expect(result._tag).toBe('Failure');
			}
		})
);

it.effect(
	'projects public boot without internal workspace, navigation, agent or Studio metadata',
	() =>
		Effect.gen(function* () {
			const source: ShellBoot = {
				workspace: {
					...boot.workspace,
					environment: 'private-environment',
					apex: 'https://operator.invalid',
					organization: true
				},
				actor: null,
				name: null,
				admin: false,
				preview: null,
				nav: [],
				surfaces: { agent: true, studio: true, inbox: true, runs: true, settings: true },
				inbox: 0,
				kiosks: [],
				envoys: { private: 'private-envoy-name' },
				push: null,
				visitor: { app: 'portal' },
				catalog: {},
				contract: boot.contract
			};
			const projected = yield* toPublicBoot(source, { base: boot.base, kiosk: null });
			expect(projected).toEqual(boot);
			const text = JSON.stringify(projected);
			for (const privateText of [
				'private-environment',
				'operator.invalid',
				'organization',
				'surfaces',
				'envoys',
				'private-envoy-name'
			])
				expect(text).not.toContain(privateText);
		})
);

it.effect('hydrates native decimal values through the same codec used to encode server data', () =>
	Effect.gen(function* () {
		const codec = Schema.Struct({ total: inputSchema({ kind: 'money', currency: 'SGD' }) });
		const encoded = { total: { $dec: '12.5' } };
		const decoded = yield* decodePublicHydration(
			JSON.stringify({ ...body, data: encoded }),
			codec,
			{ route: body.route, release: body.release }
		);
		expect(decoded.data.total).toBeInstanceOf(Decimal);
		expect(yield* Schema.encodeEffect(codec)(decoded.data)).toEqual(encoded);
	})
);
