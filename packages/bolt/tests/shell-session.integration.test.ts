// The session cookie follows the database session: every signed-in boot re-sends it with what is left of the sliding
// expiry, so a member who keeps coming back is not signed out on day seven. Host-only root cookies and refusal
// of duplicate credential names prevent a planted cookie from shadowing the workspace session.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Result } from 'effect';
import { decodeManifest } from '../src/engine/manifest.ts';
import { mint, sha256 } from '../src/engine/identity/session.ts';
import { authorityOf, HostIdentity } from '../src/shell/host.ts';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import { COOKIES, SHELL } from '../src/shell/nav.ts';
import { RateLimits } from '../src/protocol/http.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { storedFileUrl } from '../src/page/file-ref.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en', apps: [], agent: { triage: false } },
		models: {},
		relationships: {},
		exposures: {},
		policies: {},
		apps: {},
		agent: { skills: {} },
		integrations: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		customFields: {}
	})
);

describe('the session cookie', () => {
	it.live(
		'keeps HTTP sessions across boots and clears the same canonical cookies on sign-out',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(
						TestWorkspace.layer({
							manifest,
							host: {
								publicUrl: 'http://127.0.0.1:4180',
								workspace: () => ({ name: 'Local', handle: 'local' })
							}
						})
					);
					const t = Context.get(context, TestWorkspace);
					const id = randomUUID();
					yield* t.db.write({
						text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ($1, 'ada@x.test', 'Ada', 'staff', true)`,
						params: [id]
					});
					const session = yield* t.session(id);
					expect(session).toMatch(/^bolt-session=/);
					const request = (path: string, cookie: string, method = 'GET') =>
						t.handle(new Request(`http://127.0.0.1:4180${path}`, { method, headers: { cookie } }));
					const first = yield* request(SHELL, session);
					expect(first.status).toBe(200);
					const renewed = first.headers.get('set-cookie') ?? '';
					expect(renewed).toMatch(/^bolt-session=/);
					expect(renewed).toContain('; Path=/; HttpOnly; SameSite=Lax;');
					expect(renewed).not.toMatch(/(?:^|;)\s*(?:Secure|Partitioned)(?:;|$)/i);
					expect((yield* request(SHELL, renewed.split(';')[0]!)).status).toBe(200);
					expect((yield* request(SHELL, `${session}; ${session}`)).status).toBe(400);
					expect((yield* request(SHELL, `__Secure-${session}`)).status).toBe(401);
					const signedOut = yield* request('/__bolt/session/signout', session, 'POST');
					expect(signedOut.status).toBe(204);
					const cleared = signedOut.headers.getSetCookie();
					expect(cleared).toHaveLength(2);
					expect(cleared[0]).toMatch(/^bolt-session=;/);
					expect(cleared[1]).toMatch(/^bolt-preview=;/);
					for (const header of cleared) {
						expect(header).toContain('Max-Age=0');
						expect(header).not.toMatch(/(?:^|;)\s*(?:Secure|Partitioned)(?:;|$)/i);
					}
					expect((yield* request(SHELL, session)).status).toBe(401);
					const audited = [...t.fakes.audit.values()];
					expect(
						audited.filter(
							(event) => event.action === 'session.revoke' && event.id.endsWith(':terminal')
						)
					).toMatchObject([
						{
							status: 'committed',
							actor: { kind: 'member', id },
							payload: { outcome: { output: { count: 1 } } }
						}
					]);
					const bearer = decodeURIComponent(session.slice(session.indexOf('=') + 1));
					for (const secret of [bearer, sha256(bearer)])
						expect(JSON.stringify(audited)).not.toContain(secret);
				})
			)
	);
	it.live(
		'authorizes direct public file URLs through their declared app or kiosk and rejects ambiguous scope',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const publicManifest = Result.getOrThrow(
						decodeManifest({
							...manifest,
							models: {
								photos: {
									label: 'title',
									fields: {
										title: { kind: 'text' },
										visible: { kind: 'bool' },
										image: { kind: 'file', accept: ['image/png'], max: '1MiB' }
									}
								}
							},
							exposures: {
								photos: {
									read: { photos: { fields: 'all' } },
									create: { columns: { photos: ['title', 'visible', 'image'] } }
								}
							},
							policies: {
								viewer: {
									description: 'Visible photos',
									grants: {
										photos: {
											read: { where: { visible: { eq: true } }, fields: ['title', 'image'] }
										}
									}
								}
							},
							apps: {
								gallery: {
									title: 'Gallery',
									description: 'Public photos',
									icon: 'x',
									audience: { public: ['viewer'] },
									pages: { home: { title: 'Home' } }
								},
								internal: {
									title: 'Internal',
									description: 'Private app',
									icon: 'x',
									pages: { home: { title: 'Home' } }
								}
							},
							kiosks: {
								lobby: {
									title: 'Lobby',
									description: 'Public photos',
									icon: 'x',
									auth: 'none',
									policies: ['viewer'],
									pages: { home: { title: 'Home' } }
								},
								private: {
									title: 'Private',
									description: 'Members kiosk',
									icon: 'x',
									auth: 'members',
									policies: ['viewer'],
									pages: { home: { title: 'Home' } }
								}
							}
						})
					);
					const context = yield* Layer.build(TestWorkspace.layer({ manifest: publicManifest }));
					const t = Context.get(context, TestWorkspace);
					const bytes = new Uint8Array(
						readFileSync(new URL('./fixtures/files/photo.png', import.meta.url))
					);
					const publicUpload = yield* t
						.as(t.admin)
						.upload('photos.image', { name: 'public.png', mime: 'image/png', bytes });
					const privateUpload = yield* t
						.as(t.admin)
						.upload('photos.image', { name: 'private.png', mime: 'image/png', bytes });
					if (publicUpload.kind !== 'committed' || privateUpload.kind !== 'committed')
						throw new Error('Expected native stored-file uploads');
					const visible = publicUpload.output;
					const hidden = privateUpload.output;
					yield* t.db.write({
						text: 'INSERT INTO photos (id,title,visible,image) VALUES ($1,$2,$3,$4::jsonb),($5,$6,$7,$8::jsonb)',
						params: [
							randomUUID(),
							'Public photo',
							true,
							{ id: visible.id, name: visible.name, mime: visible.mime },
							randomUUID(),
							'Private photo',
							false,
							{ id: hidden.id, name: hidden.name, mime: hidden.mime }
						]
					});
					const request = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
						t.handle(new Request(`https://workspace.test${path}`, { method, headers }));
					const appPath = storedFileUrl('', visible.id, { preview: 64 }, { app: 'gallery' });
					const preview = yield* request(appPath);
					expect(preview.status).toBe(200);
					expect(preview.headers.get('content-type')).toBe('image/png');
					const previewBytes = new Uint8Array(yield* Effect.promise(() => preview.arrayBuffer()));
					expect([...previewBytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
					const dimensions = new DataView(
						previewBytes.buffer,
						previewBytes.byteOffset,
						previewBytes.byteLength
					);
					for (const offset of [16, 20]) {
						expect(dimensions.getUint32(offset)).toBeGreaterThan(0);
						expect(dimensions.getUint32(offset)).toBeLessThanOrEqual(64);
					}
					const original = yield* request(storedFileUrl('', visible.id, {}, { app: 'gallery' }));
					expect(original.status).toBe(200);
					expect(original.headers.get('content-type')).toBe('image/png');
					expect(new Uint8Array(yield* Effect.promise(() => original.arrayBuffer()))).toEqual(
						bytes
					);
					expect((yield* request(storedFileUrl('', visible.id))).status).toBe(401);
					expect(
						(yield* request(storedFileUrl('', hidden.id, { preview: 64 }, { app: 'gallery' })))
							.status
					).toBe(404);
					expect(
						(yield* request(storedFileUrl('', visible.id, { preview: 512 }, { kiosk: 'lobby' })))
							.status
					).toBe(200);
					const administrator = randomUUID();
					yield* t.db.write({
						text: 'INSERT INTO sys_user (id,email,name,kind,admin) VALUES ($1,$2,$3,$4,$5)',
						params: [
							administrator,
							'photo-admin@example.test',
							'Photo administrator',
							'staff',
							true
						]
					});
					const memberHeaders = { cookie: yield* t.session(administrator) };
					expect((yield* request(storedFileUrl('', hidden.id), 'GET', memberHeaders)).status).toBe(
						200
					);
					expect(
						(yield* request(
							storedFileUrl('', hidden.id, {}, { app: 'gallery' }),
							'GET',
							memberHeaders
						)).status
					).toBe(404);
					expect(
						(yield* request(
							storedFileUrl('', hidden.id, {}, { kiosk: 'lobby' }),
							'GET',
							memberHeaders
						)).status
					).toBe(404);
					const head = yield* request(appPath, 'HEAD');
					expect(head.status).toBe(200);
					expect(head.headers.get('content-type')).toBe('image/png');
					expect(yield* Effect.promise(() => head.text())).toBe('');
					const ambiguous: readonly (readonly [string, Record<string, string>])[] = [
						['app=gallery&app=gallery', {}],
						['kiosk=lobby&kiosk=lobby', {}],
						['app=gallery&kiosk=lobby', {}],
						['app=gallery', { 'Bolt-App': 'other' }],
						['app=gallery', { 'Bolt-Kiosk': 'lobby' }],
						['kiosk=lobby', { 'Bolt-App': 'gallery' }],
						['kiosk=lobby', { 'Bolt-Kiosk': 'private' }]
					];
					for (const [suffix, headers] of ambiguous) {
						expect(
							(yield* request(`/__bolt/files/${visible.id}?${suffix}`, 'GET', headers)).status
						).toBe(400);
					}
					for (const scope of [
						{ app: 'internal' },
						{ app: 'unknown' },
						{ kiosk: 'private' },
						{ kiosk: 'unknown' }
					])
						expect((yield* request(storedFileUrl('', visible.id, {}, scope))).status).toBe(403);
					expect((yield* request(appPath, 'GET', { 'Bolt-App': 'gallery' })).status).toBe(200);
					expect((yield* request('/__bolt/files/photos.image?app=gallery', 'PUT')).status).toBe(
						401
					);
					expect((yield* request('/__bolt/q?app=gallery', 'POST')).status).toBe(401);
				})
			)
	);
	it.live('a session minted for the agent marks every authority it yields; a plain one none', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest,
						host: {
							publicUrl: 'https://acme.example/acme',
							workspace: () => ({ name: 'Acme', handle: 'acme' })
						}
					})
				);
				const t = Context.get(context, TestWorkspace),
					identity = Context.get(context, HostIdentity);
				const id = randomUUID();
				yield* t.db.write({
					text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ($1, 'ada@x.test', 'Ada', 'staff', true)`,
					params: [id]
				});
				const authority = (token: string) =>
					authorityOf(
						HttpServerRequest.fromWeb(
							new Request(`https://acme.example${SHELL}`, {
								headers: { cookie: `${COOKIES.session}=${encodeURIComponent(token)}` }
							})
						)
					).pipe(Effect.provide(RateLimits.layer), Effect.provide(context));
				const marked = yield* mint(identity, id, { conversation: 'c1' }).pipe(
					Effect.provide(context)
				);
				const plain = yield* mint(identity, id).pipe(Effect.provide(context));
				expect(yield* authority(marked.token)).toMatchObject({
					actor: { kind: 'member', id },
					admin: true,
					agent: { conversation: 'c1' }
				});
				const own = yield* authority(plain.token);
				expect(own).toMatchObject({ actor: { kind: 'member', id }, admin: true });
				expect(own?.agent).toBeUndefined();
			})
		)
	);
	it.live(
		'slides with the database session on every boot and refuses duplicate credential names',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(
						TestWorkspace.layer({
							manifest,
							host: {
								publicUrl: 'https://acme.example/acme',
								workspace: () => ({ name: 'Acme', handle: 'acme' })
							}
						})
					);
					const t = Context.get(context, TestWorkspace),
						identity = Context.get(context, HostIdentity);
					const id = randomUUID();
					yield* t.db.write({
						text: `INSERT INTO sys_user (id, email, name, kind, admin) VALUES ($1, 'ada@x.test', 'Ada', 'staff', true)`,
						params: [id]
					});
					const s = yield* mint(identity, id).pipe(Effect.provide(context));
					const session = `${COOKIES.session}=${encodeURIComponent(s.token)}`;
					const boot = (cookie: string) =>
						t.handle(new Request(`https://acme.example${SHELL}`, { headers: { cookie } }));

					// six days on, the database session refreshes (a day since the last) and the cookie is re-sent for seven more days
					t.clock.set(new Date(Date.parse(t.clock.now()) + 6 * 86_400_000).toISOString());
					const later = yield* boot(session);
					expect(later.status).toBe(200);
					const maxAge = Number(/Max-Age=(\d+)/.exec(later.headers.get('set-cookie') ?? '')?.[1]);
					expect(maxAge).toBeGreaterThan(6 * 86_400);
					const renewed = later.headers.get('set-cookie') ?? '';
					expect(renewed).toMatch(/^__Secure-bolt-session=/);
					expect(renewed).toContain('; Path=/acme;');
					expect(renewed).toContain('; HttpOnly;');
					expect(renewed).toContain('; Secure;');
					expect(renewed).not.toMatch(/;\s*Domain=/i);

					for (const duplicated of [
						`${session}; ${COOKIES.session}=stray`,
						`${COOKIES.session}=stray; ${session}`
					]) {
						const refused = yield* boot(duplicated);
						expect(refused.status).toBe(400);
						expect(yield* Effect.promise(() => refused.json())).toEqual({
							error: { code: 'invalid', message: 'Duplicate credentials are refused.' }
						});
					}
					expect((yield* boot(`${COOKIES.session}=stray`)).status).toBe(401);
				})
			)
	);
});
