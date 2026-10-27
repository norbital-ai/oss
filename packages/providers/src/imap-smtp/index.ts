// Mailbox pairing, cursor ownership and delivery; SMTP and the scoped IMAP watch live in their own modules.
import { createHmac } from 'node:crypto';
import { Clock, Effect, FiberHandle, Option, Schedule, Predicate, Schema } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import {
	OAUTH_CALLBACK,
	type DriverOpen,
	type InstanceState,
	type Json,
	type LinkStatus,
	type LocalText,
	type OutboundAttachment,
	type SetupDescription,
	type SetupField
} from '@norbital-ai/bolt/engine';
import type { ProviderDef } from '../abi.ts';
import {
	OAuthRefused,
	PairingInvalid,
	ProviderRefused,
	ProviderUnavailable,
	type ProviderFailure
} from '../errors.ts';
import { field, hostCall, same, str, withFetch } from '../util.ts';
import {
	attempt,
	authorizeUrl,
	callbackCompletion,
	grant,
	revoke,
	tokenHolder,
	Tokens,
	type OAuthApp
} from '../oauth.ts';
import { readMail } from './reports.ts';
import { Cursor, Mailbox, Wire, mailCall, type Login, type Method, type Server } from './model.ts';
import { imap, mailboxWatch } from './mailbox-watch.ts';
import { smtp, submit } from './submit.ts';

export type MailboxOptions = {
	readonly plain?: boolean;
	readonly servers?: Partial<Record<'microsoft' | 'google', { imap: Server; smtp: Server }>>;
};
const KNOWN = {
	microsoft: {
		imap: { host: 'outlook.office365.com', port: 993 },
		smtp: { host: 'smtp.office365.com', port: 587 }
	},
	google: {
		imap: { host: 'imap.gmail.com', port: 993 },
		smtp: { host: 'smtp.gmail.com', port: 465 }
	}
};
const tenantOf = (m: Mailbox) =>
	(m.method === 'microsoft' ? m.oauth.tenant : undefined) ?? 'organizations';
const appOf = (m: Mailbox, personal = false): OAuthApp =>
	m.method === 'google'
		? {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				revokeUrl: 'https://oauth2.googleapis.com/revoke',
				// `openid email`: the sign-in names the mailbox, so nobody types its address
				scopes: ['https://mail.google.com/', 'openid', 'email'],
				params: { access_type: 'offline', prompt: 'consent' }
			}
		: {
				authorizeUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenantOf(m))}/oauth2/v2.0/authorize`,
				tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenantOf(m))}/oauth2/v2.0/token`,
				scopes: [
					'https://outlook.office.com/IMAP.AccessAsUser.All',
					...(personal ? [] : ['https://outlook.office.com/SMTP.Send']),
					'offline_access'
				]
			};

// ── setup, as data the shell renders ──
const t = (en: string, zh: string): LocalText => ({ en, zh });
const F = {
	address: {
		name: 'address',
		label: t('Email address', '电子邮件地址'),
		hint: t('The mailbox this integration reads and sends as', '此集成读取并以其身份发信的邮箱')
	},
	fromName: {
		name: 'fromName',
		label: t('Sender name', '发件人名称'),
		optional: true,
		hint: t('Shown as the sender, e.g. "Acme Support"', '显示为发件人，例如 “Acme 客服”')
	},
	folder: {
		name: 'folder',
		label: t('Folder to watch', '监视的文件夹'),
		optional: true,
		hint: t('Default INBOX', '默认 INBOX')
	},
	tracking: {
		name: 'tracking',
		label: t('Open tracking', '打开跟踪'),
		optional: true,
		options: [
			{ value: 'off', label: t('Off', '关闭') },
			{ value: 'on', label: t('On', '开启') }
		],
		hint: t(
			'Adds an invisible image to HTML mail; opens are approximate (mail apps prefetch or block images)',
			'在 HTML 邮件中加入不可见图片；打开记录为近似值（邮件应用可能预取或屏蔽图片）'
		)
	},
	quietHours: {
		name: 'quietHours',
		label: t('Presume delivered after (hours)', '视为已送达（小时）'),
		optional: true,
		hint: t(
			'With no bounce in this long, a message counts as delivered. Default 24',
			'在此时长内没有退信，则视为已送达。默认 24'
		)
	},
	clientId: { name: 'clientId', label: t('Client ID', '客户端 ID') },
	clientSecret: { name: 'clientSecret', label: t('Client secret', '客户端密钥'), secret: true }
} satisfies { [k: string]: SetupField };
const COMMON = [F.fromName, F.folder, F.tracking, F.quietHours];
const WATCHED = t(
	"Mail arriving in the watched folder enters this integration; replies are sent through SMTP as this address. Bounce and delay reports landing there update each message's delivery status (spam complaints are not reported over IMAP).",
	'到达所监视文件夹的邮件会进入此集成；回复通过 SMTP 以此地址发出。落入该文件夹的退信和延迟报告会更新每封邮件的送达状态（IMAP 不报告垃圾邮件投诉）。'
);

const PASSWORD: SetupDescription = {
	kind: 'form',
	steps: [
		{
			text: t(
				"Use the mailbox's IMAP and SMTP server settings (your mail provider or IT team publishes them). Ports 993 (IMAP) and 465 (SMTP) use TLS; 143 and 587 use STARTTLS. Unencrypted connections are refused.",
				'使用邮箱的 IMAP 与 SMTP 服务器设置（由您的邮件服务商或 IT 团队提供）。端口 993（IMAP）和 465（SMTP）使用 TLS；143 和 587 使用 STARTTLS。不接受未加密的连接。'
			)
		},
		{
			text: t(
				'A Google or Microsoft mailbox with two-step verification needs an app password here, or choose its "Sign in" option instead.',
				'启用了两步验证的 Google 或 Microsoft 邮箱需要在此使用应用专用密码，或改用其“登录”选项。'
			)
		},
		{ text: WATCHED }
	],
	fields: [
		F.address,
		{
			name: 'username',
			label: t('Username', '用户名'),
			optional: true,
			hint: t('Default: the email address', '默认：电子邮件地址')
		},
		{ name: 'password', label: t('Password or app password', '密码或应用专用密码'), secret: true },
		{ name: 'imapHost', label: t('IMAP server', 'IMAP 服务器'), hint: 'imap.example.com' },
		{
			name: 'imapPort',
			label: t('IMAP port', 'IMAP 端口'),
			optional: true,
			hint: t('Default 993', '默认 993')
		},
		{ name: 'smtpHost', label: t('SMTP server', 'SMTP 服务器'), hint: 'smtp.example.com' },
		{
			name: 'smtpPort',
			label: t('SMTP port', 'SMTP 端口'),
			optional: true,
			hint: t('Default 587', '默认 587')
		},
		...COMMON
	]
};

const MICROSOFT: SetupDescription = {
	kind: 'form',
	steps: [
		{
			text: t(
				'In the Microsoft Entra admin center, open App registrations → New registration (accounts in this organizational directory). Add a Web platform redirect URI, exactly:',
				'在 Microsoft Entra 管理中心打开“应用注册”→“新注册”（仅此组织目录中的帐户）。添加 Web 平台重定向 URI，须完全一致：'
			),
			href: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
			copy: 'redirectUrl'
		},
		{
			text: t(
				'Under API permissions add the delegated Microsoft Graph permissions offline_access, IMAP.AccessAsUser.All and SMTP.Send, then grant admin consent.',
				'在“API 权限”中添加委托的 Microsoft Graph 权限 offline_access、IMAP.AccessAsUser.All 和 SMTP.Send，然后授予管理员同意。'
			)
		},
		{
			text: t(
				"Under Certificates & secrets create a client secret. Paste the Directory (tenant) ID, the Application (client) ID and the secret's value below.",
				'在“证书和密码”中创建客户端密码。将目录（租户）ID、应用程序（客户端）ID 和密码的值粘贴到下方。'
			)
		},
		{
			text: t(
				'Authenticated SMTP must be on for the mailbox (Microsoft 365 admin center → the user → Mail → Manage email apps). Then Connect and sign in as the mailbox in the window that opens.',
				'邮箱须启用“经过身份验证的 SMTP”（Microsoft 365 管理中心 → 用户 → 邮件 → 管理电子邮件应用）。然后点击连接，在打开的窗口中以该邮箱登录。'
			)
		},
		{ text: WATCHED }
	],
	fields: [
		F.address,
		{ name: 'tenant', label: t('Directory (tenant) ID', '目录（租户）ID') },
		F.clientId,
		F.clientSecret,
		...COMMON
	]
};

/** One click: the host's Google client signs in, and the sign-in names the mailbox. */
const GOOGLE: SetupDescription = { kind: 'oauth', steps: [] };

const syncSetup = (method: Method): SetupDescription => {
	if (method === 'google') return GOOGLE;
	const setup = { password: PASSWORD, microsoft: MICROSOFT }[method];
	const fields = (setup.fields ?? [])
		.map((f) =>
			f.name === 'address' ? { ...f, hint: t('The mailbox to synchronize', '要同步的邮箱') } : f
		)
		.filter(
			(f) => !['smtpHost', 'smtpPort', 'fromName', 'tracking', 'quietHours'].includes(f.name)
		);
	const steps = {
		password: [],
		microsoft: [
			setup.steps[0]!,
			{
				text: t(
					'Grant delegated IMAP.AccessAsUser.All and offline_access permissions for this mailbox.',
					'为此邮箱授予委托的 IMAP.AccessAsUser.All 和 offline_access 权限。'
				)
			},
			setup.steps[2]!,
			{
				text: t(
					'Connect and sign in as the mailbox in the window that opens.',
					'点击连接，在打开的窗口中以该邮箱登录。'
				)
			}
		]
	}[method];
	return {
		...setup,
		fields,
		steps: [
			...steps,
			{
				text: t(
					'Messages in the selected folder sync into this workspace. This connection does not send email.',
					'所选文件夹中的邮件会同步到此工作区。此连接不会发送邮件。'
				)
			}
		]
	};
};

const PIXEL = Uint8Array.from(
	Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
);
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const escape = (value: string) =>
	value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const METHODS = {
	google: {
		id: 'google',
		name: 'Gmail',
		icon: 'logos:google-gmail',
		label: t(
			'Google Workspace or Gmail (sign in with Google)',
			'Google Workspace 或 Gmail（使用 Google 登录）'
		),
		personalLabel: t(
			'Google Workspace or Gmail (sign in with Google)',
			'Google Workspace 或 Gmail（使用 Google 登录）'
		),
		setup: GOOGLE,
		signIn: 'Sign in with Google'
	},
	password: {
		id: 'imap',
		name: t('Email', '电子邮件'),
		icon: 'lucide:mail',
		label: t('Mail server (IMAP + SMTP, password)', '邮件服务器（IMAP + SMTP，密码）'),
		personalLabel: t('Mail server (IMAP, password)', '邮件服务器（IMAP，密码）'),
		setup: PASSWORD,
		signIn: 'Sign in'
	},
	microsoft: {
		id: 'microsoft',
		name: 'Microsoft Outlook',
		icon: 'logos:microsoft-icon',
		label: t('Microsoft 365 (sign in with Microsoft)', 'Microsoft 365（使用 Microsoft 登录）'),
		personalLabel: t(
			'Microsoft 365 (sign in with Microsoft)',
			'Microsoft 365（使用 Microsoft 登录）'
		),
		setup: MICROSOFT,
		signIn: 'Sign in with Microsoft'
	}
} as const;

const mailboxOf = Effect.fn('Mailbox.input')(function* (
	method: Method,
	input: Json,
	known: { imap: Server; smtp: Server } | undefined,
	personal: boolean,
	pixelKey: string
): Effect.fn.Return<Mailbox, PairingInvalid> {
	const get = (key: string) => (Predicate.isObject(input) ? str(input[key]) : null)?.trim() || null;
	const port = (key: string, fallback: number, label: string) =>
		Effect.suspend(() => {
			const value = get(key),
				number = value === null ? fallback : Number(value);
			return Number.isInteger(number) && number >= 1 && number <= 65535
				? Effect.succeed(number)
				: Effect.fail(new PairingInvalid({ message: `${label} is not a port number` }));
		});
	// a Google sign-in names its mailbox: the address is filled from it at the callback
	const address =
		method === 'google'
			? ''
			: (yield* field(input, 'address', 'The email address', EMAIL)).toLowerCase();
	const quiet = get('quietHours') === null ? 24 : Number(get('quietHours'));
	if (!Number.isFinite(quiet) || quiet <= 0 || quiet > 720)
		return yield* Effect.fail(
			new PairingInvalid({ message: 'The delivery window is a number of hours (up to 720)' })
		);
	const common = {
		address,
		fromName: get('fromName'),
		folder: get('folder') ?? 'INBOX',
		tracking: !personal && get('tracking') === 'on',
		quietHours: quiet,
		pixelKey
	};
	if (method === 'password')
		return {
			...common,
			method,
			user: get('username') ?? address,
			password: yield* field(input, 'password', 'The password'),
			imap: {
				host: yield* field(input, 'imapHost', 'The IMAP server'),
				port: yield* port('imapPort', 993, 'The IMAP port')
			},
			...(personal
				? {}
				: {
						smtp: {
							host: yield* field(input, 'smtpHost', 'The SMTP server'),
							port: yield* port('smtpPort', 587, 'The SMTP port')
						}
					})
		};
	if (known === undefined)
		return yield* Effect.fail(
			new PairingInvalid({ message: 'The sign-in method has no mail servers' })
		);
	const servers = personal ? { imap: known.imap } : known;
	if (method === 'google') return { ...common, method, user: address, ...servers };
	return {
		...common,
		method,
		user: address,
		...servers,
		oauth: {
			clientId: yield* field(input, 'clientId', 'The client ID'),
			clientSecret: yield* field(input, 'clientSecret', 'The client secret'),
			tenant: yield* field(input, 'tenant', 'The directory (tenant) ID', /^[\w.-]+$/)
		}
	};
});

const UserInfo = Schema.Struct({ email: Schema.NonEmptyString });
/** The address a Google sign-in is for (its `openid email` scopes). */
const signedIn = (access: string) =>
	HttpClient.execute(
		HttpClientRequest.get('https://openidconnect.googleapis.com/v1/userinfo').pipe(
			HttpClientRequest.bearerToken(access),
			HttpClientRequest.acceptJson
		)
	).pipe(
		Effect.flatMap(HttpClientResponse.schemaBodyJson(UserInfo)),
		Effect.map((info) => info.email.toLowerCase()),
		Effect.mapError(
			() => new ProviderUnavailable({ message: 'Google did not say which mailbox signed in' })
		)
	);

const provider = (method: Method, options: MailboxOptions): ProviderDef => {
	const metadata = METHODS[method],
		known = method === 'password' ? undefined : (options.servers?.[method] ?? KNOWN[method]);
	return {
		_tag: 'ProviderDef',
		driver: 'email',
		personal: true,
		importStart: { kind: 'timestamp', precision: 'second' },
		id: metadata.id,
		name: metadata.name,
		icon: metadata.icon,
		description: t('Sync messages from your inbox', '同步收件箱中的消息'),
		label: metadata.label,
		setup: metadata.setup,
		describe: ({ personal }) => ({
			label: personal ? metadata.personalLabel : metadata.label,
			setup: personal ? syncSetup(method) : metadata.setup
		}),
		...(method === 'google' ? { oauth: 'google' as const } : {}),
		test: {},
		open: (ctx) => open(ctx, method, metadata.id, known, options)
	};
};

const open = Effect.fn('Mailbox.open')(function* (
	ctx: DriverOpen,
	method: Method,
	id: string,
	known: { imap: Server; smtp: Server } | undefined,
	options: MailboxOptions
) {
	const plain = options.plain === true,
		personal = ctx.personal;
	const stored = yield* hostCall('read mailbox credentials', () => ctx.credentials.load());
	let box = Option.getOrNull(Schema.decodeUnknownOption(Mailbox)(stored.get('credential')));
	let tokens = Option.getOrNull(Schema.decodeUnknownOption(Tokens)(stored.get('token')));
	let cursor = Option.getOrNull(Schema.decodeUnknownOption(Cursor)(stored.get('state')));
	let pending: { state: string; verifier: string; url: string; draft: Mailbox; at: number } | null =
		null;
	let problem: string | null = null,
		live: InstanceState = 'connecting',
		detail: string | null = null;
	const supervisor = yield* FiberHandle.make<void>();
	const completion = yield* callbackCompletion;
	/** The OAuth client a mailbox signs in with: Microsoft's is the operator's app, Google's the host's (or the definition's). */
	const clientOf = (mailbox: Mailbox) =>
		Effect.gen(function* () {
			const client =
				mailbox.method === 'microsoft'
					? { id: mailbox.oauth.clientId, secret: mailbox.oauth.clientSecret }
					: mailbox.method === 'google'
						? yield* Effect.promise(() => ctx.oauthClient('google'))
						: undefined;
			return yield* client === undefined
				? Effect.fail(
						new ProviderUnavailable({ message: 'This host has no sign-in for the mailbox' })
					)
				: Effect.succeed(client);
		});
	const domainOf = (mailbox: Mailbox) =>
		mailbox.address.slice(mailbox.address.lastIndexOf('@') + 1);
	const midOf = (mailbox: Mailbox, local: string) => `<${local}@${domainOf(mailbox)}>`;
	const macOf = (mailbox: Mailbox, local: string) =>
		createHmac('sha256', mailbox.pixelKey).update(local).digest('base64url').slice(0, 22);
	const need = () =>
		box === null
			? Effect.fail(
					new ProviderRefused({
						message: 'this email integration is not connected',
						permanent: true
					})
				)
			: Effect.succeed(box);
	const report = () =>
		Effect.gen(function* () {
			const current = box;
			const status: LinkStatus =
				pending !== null
					? { state: 'pairing' }
					: problem !== null
						? { state: 'error', error: problem }
						: current === null
							? { state: 'unpaired' }
							: {
									state: live,
									account: current.address,
									...(detail === null ? {} : { detail }),
									about: {
										address: current.address,
										server: personal
											? current.imap.host
											: `${current.imap.host} · ${current.smtp?.host}`,
										folder: current.folder,
										openTracking: current.tracking ? 'on' : 'off'
									}
								};
			if (pending !== null) {
				const value = pending.url;
				yield* Effect.sync(() =>
					ctx.pairing({ kind: 'oauth', value, label: METHODS[method].signIn })
				);
			}
			yield* hostCall('report mailbox status', () => ctx.status(status));
		});
	const makeHolder = (mailbox: Mailbox, initial: Tokens | null, persist: boolean) =>
		tokenHolder(
			appOf(mailbox, personal),
			() => clientOf(mailbox),
			initial,
			(next) =>
				persist
					? hostCall('store mailbox token', () =>
							ctx.credentials.write(new Map([['token', next]]))
						).pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									tokens = next;
								})
							)
						)
					: Effect.void
		);
	type Holder = Effect.Success<ReturnType<typeof tokenHolder>>;
	let holder: Holder | null =
		box === null || box.method === 'password' ? null : yield* makeHolder(box, tokens, true);
	const login = Effect.fn('Mailbox.login')(function* (
		mailbox: Mailbox,
		draft?: Tokens | null
	): Effect.fn.Return<Login, ProviderFailure> {
		if (mailbox.method === 'password') return { user: mailbox.user, pass: mailbox.password };
		const active =
			draft === undefined && mailbox === box && holder !== null
				? holder
				: yield* makeHolder(mailbox, draft ?? null, false);
		return { user: mailbox.user, accessToken: (yield* withFetch(ctx, active.get())).access };
	});
	const verify = (mailbox: Mailbox, token: Tokens | null) =>
		Effect.scoped(
			Effect.gen(function* () {
				const auth = yield* login(mailbox, token),
					client = yield* imap(mailbox, auth, plain);
				yield* mailCall(`IMAP ${mailbox.imap.host}`, () => client.connect()).pipe(
					Effect.onInterrupt(() => Effect.sync(() => client.close()))
				);
				yield* mailCall(`the mailbox has no folder "${mailbox.folder}"`, () =>
					client.mailboxOpen(mailbox.folder, { readOnly: true })
				);
				if (!personal) {
					const transport = yield* smtp(mailbox, auth, plain);
					yield* mailCall(`SMTP ${mailbox.smtp?.host}`, () => transport.verify());
				}
			})
		);
	const advance = (next: Cursor) =>
		hostCall('advance mailbox cursor', () =>
			ctx.credentials.write(new Map([['state', next]]))
		).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					cursor = next;
				})
			)
		);
	const after = ctx.importStart?.kind === 'since' ? ctx.importStart.at : undefined;
	const deliver = (
		mailbox: Mailbox,
		source: Uint8Array,
		local: string,
		receivedAt: string | undefined
	) =>
		Effect.gen(function* () {
			// INTERNALDATE is the source checkpoint; Date headers and ingestion time cannot admit old history.
			if (
				after !== undefined &&
				(receivedAt === undefined || Date.parse(receivedAt) < Date.parse(after))
			)
				return;
			const read = yield* readMail(
				source,
				domainOf(mailbox),
				midOf(mailbox, local),
				!personal,
				receivedAt
			);
			if (read.kind === 'report') {
				const at = new Date(yield* Clock.currentTimeMillis).toISOString();
				for (const providerId of read.ids)
					yield* hostCall('store mail report', () =>
						ctx.emit({ kind: 'delivery', providerId, report: { ...read.report, at, provider: id } })
					);
				return;
			}
			if (read.from === mailbox.address && !personal) return;
			const message = personal
				? {
						...read.message,
						...(receivedAt === undefined ? {} : { sourceAt: receivedAt }),
						direction: read.from === mailbox.address ? 'outbound' : 'inbound'
					}
				: { ...read.message, ...(receivedAt === undefined ? {} : { sourceAt: receivedAt }) };
			yield* hostCall('store mailbox message', () =>
				ctx.emit({
					kind: 'messages',
					messages: [message],
					...(read.bins.length === 0 ? {} : { bins: read.bins })
				})
			);
		});
	const start = () =>
		Effect.gen(function* () {
			const mailbox = box;
			if (mailbox === null) return;
			yield* FiberHandle.run(
				supervisor,
				mailboxWatch({
					box: mailbox,
					plain,
					personal,
					after,
					login: () => login(mailbox),
					cursor: () => cursor,
					advance,
					deliver: (source, fallback, receivedAt) => deliver(mailbox, source, fallback, receivedAt),
					connected: Effect.suspend(() => {
						live = 'connected';
						detail = null;
						return report();
					})
				}).pipe(
					Effect.tapError((error) =>
						Effect.suspend(() => {
							live = 'reconnecting';
							detail = error.message;
							return report();
						})
					),
					Effect.retry({
						schedule: Schedule.min([
							Schedule.exponential('5 seconds'),
							Schedule.spaced('300 seconds')
						]),
						while: (error) =>
							error._tag !== 'OAuthRefused' &&
							error._tag !== 'LinkClosed' &&
							error._tag !== 'Fenced'
					}),
					Effect.catchTag('OAuthRefused', (error) =>
						Effect.suspend(() => {
							problem =
								method === 'password'
									? `The mail server refused the sign-in for ${mailbox.address} (${error.message}). Enter the current password and connect again.`
									: `The sign-in for ${mailbox.address} was revoked or has expired (${error.message}). Connect and sign in again.`;
							return report();
						})
					),
					Effect.tapCause(Effect.logWarning),
					Effect.ignore
				)
			);
		});
	const adopt = (mailbox: Mailbox, token: Tokens | null) =>
		Effect.gen(function* () {
			yield* FiberHandle.clear(supervisor);
			// Host persistence cannot be canceled; finish adoption before disconnect can wipe its keys.
			yield* Effect.gen(function* () {
				yield* hostCall('store mailbox pairing', () =>
					ctx.credentials.write(
						new Map<string, Json | null>([
							['credential', mailbox],
							['token', token],
							['state', null]
						])
					)
				);
				box = mailbox;
				tokens = token;
				cursor = null;
				problem = null;
				live = 'connecting';
				holder = mailbox.method === 'password' ? null : yield* makeHolder(mailbox, token, true);
				yield* report();
			}).pipe(Effect.uninterruptible);
			yield* start();
		});
	const page = (status: number, text: string, close = false) =>
		new Response(
			`<!doctype html><meta charset="utf-8"><title>Norbital</title><p style="font:15px system-ui;margin:3rem auto;max-width:28rem">${escape(text)}</p>${close ? '<script>window.close()</script>' : ''}`,
			{
				status,
				headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
			}
		);
	const callback = (query: URLSearchParams) =>
		completion.run(
			query.get('state') ?? '',
			() => pending,
			() =>
				page(
					400,
					"This sign-in is unknown or has expired. Start again from the integration's setup."
				),
			(pairing) =>
				Effect.gen(function* () {
					pending = null;
					return yield* Effect.gen(function* () {
						const error = query.get('error');
						if (error !== null)
							return yield* Effect.fail(
								new OAuthRefused({
									message: `the sign-in was refused (${error})${query.get('error_description') === null ? '' : `: ${(query.get('error_description') ?? '').split('\n')[0]}`}`,
									revoked: false
								})
							);
						const token = yield* withFetch(
							ctx,
							grant(appOf(pairing.draft, personal), yield* clientOf(pairing.draft), {
								grant_type: 'authorization_code',
								code: query.get('code') ?? '',
								redirect_uri: ctx.redirectUrl,
								code_verifier: pairing.verifier
							})
						);
						const draft =
							pairing.draft.method === 'google'
								? yield* withFetch(ctx, signedIn(token.access)).pipe(
										Effect.map((address) => ({ ...pairing.draft, address, user: address }))
									)
								: pairing.draft;
						yield* verify(draft, token);
						yield* adopt(draft, token);
						return page(200, `Connected as ${draft.address}. You can close this window.`, true);
					}).pipe(
						Effect.catch((error) =>
							Effect.gen(function* () {
								problem = `${error.message}. Check the app registration and connect again.`;
								yield* report();
								return page(400, `Not connected: ${problem}`);
							}).pipe(Effect.uninterruptible)
						)
					);
				})
		);
	yield* report();
	if (box !== null) yield* start();
	return {
		pair: (input: Json) =>
			completion.reset(
				Effect.gen(function* () {
					pending = null;
					const draft = yield* mailboxOf(
						method,
						input,
						known,
						personal,
						yield* Effect.promise(() => ctx.state())
					);
					if (draft.method === 'password') {
						yield* verify(draft, null);
						yield* adopt(draft, null);
						return;
					}
					const pairing = attempt(yield* Effect.promise(() => ctx.state())),
						client = yield* clientOf(draft);
					pending = {
						state: pairing.state,
						verifier: pairing.verifier,
						at: yield* Clock.currentTimeMillis,
						draft,
						url: authorizeUrl(
							appOf(draft, personal),
							client.id,
							ctx.redirectUrl,
							pairing.state,
							pairing.challenge,
							draft.address === '' ? undefined : draft.address
						)
					};
					problem = null;
					yield* report();
				})
			),
		unpair: () =>
			completion.reset(
				FiberHandle.clear(supervisor).pipe(
					// the provider forgets the grant too (Microsoft has no per-token revocation; its tokens just go)
					Effect.andThen(
						box === null || box.method === 'password'
							? Effect.void
							: withFetch(ctx, revoke(appOf(box, personal), tokens))
					),
					Effect.tap(() =>
						Effect.sync(() => {
							pending = null;
							problem = null;
							box = null;
							tokens = null;
							cursor = null;
							holder = null;
						})
					)
				)
			),
		close: FiberHandle.clear(supervisor),
		send: (message: Json, files: readonly OutboundAttachment[] = []) =>
			Effect.gen(function* () {
				if (personal)
					return yield* Effect.fail(
						new ProviderRefused({
							message: 'This mailbox only synchronizes messages.',
							permanent: true
						})
					);
				const mailbox = yield* need(),
					wire = yield* Schema.decodeUnknownEffect(Wire)(message).pipe(
						Effect.mapError(
							() => new ProviderRefused({ message: 'Invalid email message', permanent: true })
						)
					);
				const mid = midOf(mailbox, wire.id),
					html =
						wire.html !== undefined && mailbox.tracking
							? `${wire.html}<img src="${ctx.webhookUrl}/open/${wire.id}.${macOf(mailbox, wire.id)}.gif" width="1" height="1" alt="" style="display:none">`
							: wire.html;
				yield* Effect.gen(function* () {
					yield* submit(
						mailbox,
						yield* login(mailbox),
						plain,
						{ ...wire, ...(html === undefined ? {} : { html }) },
						mid,
						{},
						files
					);
				}).pipe(
					Effect.tapError((error) =>
						error._tag !== 'OAuthRefused'
							? Effect.void
							: Effect.gen(function* () {
									problem = `The sign-in for ${mailbox.address} was revoked or has expired (${error.message}). Connect and sign in again.`;
									yield* FiberHandle.clear(supervisor);
									yield* report();
								})
					)
				);
				return { providerId: mid, presumeAfterMs: mailbox.quietHours * 3600000 };
			}),
		test: (_input: Json) =>
			Effect.scoped(
				Effect.gen(function* () {
					if (personal)
						return yield* Effect.fail(
							new ProviderRefused({
								message: 'This mailbox only synchronizes messages.',
								permanent: true
							})
						);
					const mailbox = yield* need(),
						local = yield* Effect.promise(() => ctx.state()),
						mid = midOf(mailbox, local),
						auth = yield* login(mailbox);
					yield* submit(
						mailbox,
						auth,
						plain,
						{
							id: local,
							to: [mailbox.address],
							subject: 'Norbital test message',
							text: 'This email integration is connected: sending and receiving both work.'
						},
						mid,
						{ 'X-Norbital-Test': local }
					);
					const client = yield* imap(mailbox, auth, plain);
					yield* mailCall('IMAP test connect', () => client.connect()).pipe(
						Effect.onInterrupt(() => Effect.sync(() => client.close()))
					);
					const arrived = yield* Effect.gen(function* () {
						for (const folder of new Set([mailbox.folder, 'INBOX'])) {
							yield* mailCall('IMAP test folder', () =>
								client.mailboxOpen(folder, { readOnly: true })
							);
							const hits = yield* mailCall('IMAP test lookup', () =>
								client.search({ header: { 'message-id': mid } }, { uid: true })
							);
							if (Array.isArray(hits) && hits.length > 0) return true;
						}
						return false;
					}).pipe(
						Effect.repeat({ schedule: Schedule.spaced('3 seconds'), until: (found) => found }),
						Effect.timeoutOption('60 seconds')
					);
					if (Option.isNone(arrived))
						return yield* Effect.fail(
							new ProviderUnavailable({
								message: `The test message was sent but did not arrive in "${mailbox.folder}": check the folder and any mail rules that move it.`
							})
						);
				})
			),
		webhook: (request: Request) =>
			Effect.gen(function* () {
				const url = new URL(request.url),
					base = new URL(ctx.webhookUrl).pathname,
					rest = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : '';
				if (request.method === 'GET' && url.pathname.endsWith(OAUTH_CALLBACK))
					return yield* callback(url.searchParams);
				const hit = /^\/open\/([\w-]{1,64})\.([\w-]{22})\.gif$/.exec(rest);
				if (request.method === 'GET' && hit !== null) {
					const mailbox = box,
						local = hit[1],
						mac = hit[2];
					if (
						mailbox !== null &&
						mailbox.tracking &&
						local !== undefined &&
						mac !== undefined &&
						same(mac, macOf(mailbox, local))
					) {
						const at = new Date(yield* Clock.currentTimeMillis).toISOString();
						yield* hostCall('store open report', () =>
							ctx.emit({
								kind: 'delivery',
								providerId: midOf(mailbox, local),
								report: { kind: 'opened', at, provider: id, approximate: true }
							})
						).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
					}
					return new Response(PIXEL, {
						headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, private' }
					});
				}
				return new Response(null, { status: 404 });
			})
	};
});

export function mailbox(options: MailboxOptions = {}): readonly ProviderDef[] {
	return (['google', 'microsoft', 'password'] as const).map((method) => provider(method, options));
}
