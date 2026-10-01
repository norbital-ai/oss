// A tenant's own mailbox as an email channel: IMAP watches one folder (IDLE, reconnecting with backoff) and SMTP sends
// as the mailbox. Any server works with a password (or app password); Microsoft 365 and Google also sign in with OAuth
// (XOAUTH2) through the tenant's own app registration, the callback landing on this channel's webhook. Delivery status:
// the SMTP reply on submit (4xx retried as `deferred`, 5xx `failed`), a DSN requested when the server offers it, DSNs and
// non-delivery reports read from the watched folder, and an optional open-tracking pixel served on the channel's
// webhook. Spam complaints are not reported over IMAP + SMTP. Libraries: imapflow, nodemailer, postal-mime.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import {
	connection,
	OAUTH_CALLBACK,
	SendRefused,
	type ChannelLink,
	type ChannelOpen,
	type ChannelProvider,
	type ConnectionState,
	type Json,
	type LocalText,
	type OutboundAttachment,
	type SetupField,
	type SetupStep
} from '@norbital-ai/bolt/engine';
import { isObj, same, str } from '../util.ts';
import {
	attempt,
	authorizeUrl,
	fresh,
	grant,
	OAuthRefused,
	STATE_MS,
	type OAuthApp,
	type Tokens
} from './oauth.ts';
import { codeOf, readMail } from './reports.ts';

type Method = 'password' | 'microsoft' | 'google';
type Server = { host: string; port: number };
/** What the channel seals: its settings, its secret (a password, or the tenant's OAuth client and tokens), its read cursor. */
type Mailbox = {
	method: Method;
	address: string;
	user: string;
	fromName: string | null;
	folder: string;
	tracking: boolean;
	quietHours: number;
	imap: Server;
	smtp?: Server;
	password?: string;
	pixelKey: string;
	oauth?: { clientId: string; clientSecret: string; tenant?: string; tokens: Tokens | null };
	cursor?: { validity: string; uid: number };
};
export type MailboxOptions = {
	/** Tests only: talk to a local fake server without TLS. Never set on a real host. */
	plain?: boolean;
	/** The known servers of the OAuth sign-ins (tests point them at a fake). */
	servers?: Partial<Record<'microsoft' | 'google', { imap: Server; smtp: Server }>>;
	now?: () => number;
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
const appOf = (m: Mailbox, syncOnly = false): OAuthApp =>
	m.method === 'google'
		? {
				authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				scopes: ['https://mail.google.com/'],
				params: { access_type: 'offline', prompt: 'consent' }
			}
		: {
				authorizeUrl: `https://login.microsoftonline.com/${encodeURIComponent(m.oauth?.tenant ?? 'organizations')}/oauth2/v2.0/authorize`,
				tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(m.oauth?.tenant ?? 'organizations')}/oauth2/v2.0/token`,
				scopes: [
					'https://outlook.office.com/IMAP.AccessAsUser.All',
					...(syncOnly ? [] : ['https://outlook.office.com/SMTP.Send']),
					'offline_access'
				]
			};

// ── setup, as data the shell renders ──
const t = (en: string, zh: string): LocalText => ({ en, zh });
const F = {
	address: {
		name: 'address',
		label: t('Email address', '电子邮件地址'),
		hint: t('The mailbox this channel reads and sends as', '此渠道读取并以其身份发信的邮箱')
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
	"Mail arriving in the watched folder enters this channel; replies are sent through SMTP as this address. Bounce and delay reports landing there update each message's delivery status (spam complaints are not reported over IMAP).",
	'到达所监视文件夹的邮件会进入此渠道；回复通过 SMTP 以此地址发出。落入该文件夹的退信和延迟报告会更新每封邮件的送达状态（IMAP 不报告垃圾邮件投诉）。'
);

const PASSWORD: ChannelProvider['setup'] = {
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

const MICROSOFT: ChannelProvider['setup'] = {
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

const GOOGLE: ChannelProvider['setup'] = {
	kind: 'form',
	steps: [
		{
			text: t(
				'In Google Cloud console, pick a project and configure the OAuth consent screen (Internal for a Google Workspace domain); add the scope https://mail.google.com/.',
				'在 Google Cloud 控制台中选择一个项目并配置 OAuth 同意屏幕（Google Workspace 域选择“内部”）；添加范围 https://mail.google.com/。'
			),
			href: 'https://console.cloud.google.com/apis/credentials/consent'
		},
		{
			text: t(
				'Create an OAuth client ID of type Web application with this authorized redirect URI, exactly:',
				'创建类型为 Web 应用的 OAuth 客户端 ID，并添加以下授权重定向 URI，须完全一致：'
			),
			href: 'https://console.cloud.google.com/apis/credentials',
			copy: 'redirectUrl'
		},
		{
			text: t(
				'Paste the client ID and client secret below, then Connect and sign in as the mailbox in the window that opens.',
				'将客户端 ID 和客户端密钥粘贴到下方，然后点击连接，在打开的窗口中以该邮箱登录。'
			)
		},
		{ text: WATCHED }
	],
	fields: [F.address, F.clientId, F.clientSecret, ...COMMON]
};

const syncSetup = (method: Method): ChannelProvider['setup'] => {
	const setup = method === 'password' ? PASSWORD : method === 'microsoft' ? MICROSOFT : GOOGLE;
	const fields = (setup.fields ?? [])
		.map((f) =>
			f.name === 'address' ? { ...f, hint: t('The mailbox to synchronize', '要同步的邮箱') } : f
		)
		.filter(
			(f) => !['smtpHost', 'smtpPort', 'fromName', 'tracking', 'quietHours'].includes(f.name)
		);
	const steps =
		method === 'password'
			? []
			: method === 'microsoft'
				? [
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
				: setup.steps.slice(0, -1);
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

const SIGN_IN = { microsoft: 'Sign in with Microsoft', google: 'Sign in with Google' } as const;
const PIXEL = Uint8Array.from(
	Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
);
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});

/** The operator's setup input → a mailbox, or the refusal the shell shows verbatim. */
function mailboxOf(
	method: Method,
	input: Json,
	known: { imap: Server; smtp: Server } | undefined,
	syncOnly: boolean
): Mailbox {
	const get = (k: string) => (isObj(input) ? str(input[k]) : null)?.trim() || null;
	const need = (k: string, label: string) => {
		const v = get(k);
		if (v === null) throw new Error(`${label} is required`);
		return v;
	};
	const port = (k: string, fallback: number, label: string) => {
		const v = get(k),
			n = v === null ? fallback : Number(v);
		if (!Number.isInteger(n) || n < 1 || n > 65535)
			throw new Error(`${label} is not a port number`);
		return n;
	};
	const address = need('address', 'The email address').toLowerCase();
	if (!EMAIL.test(address)) throw new Error('The email address does not look right');
	const quiet = get('quietHours') === null ? 24 : Number(get('quietHours'));
	if (!Number.isFinite(quiet) || quiet <= 0 || quiet > 24 * 30)
		throw new Error('The delivery window is a number of hours (up to 720)');
	const common = {
		method,
		address,
		fromName: get('fromName'),
		folder: get('folder') ?? 'INBOX',
		tracking: !syncOnly && get('tracking') === 'on',
		quietHours: quiet,
		pixelKey: randomBytes(32).toString('base64url')
	};
	if (method === 'password')
		return {
			...common,
			user: get('username') ?? address,
			password: need('password', 'The password'),
			imap: {
				host: need('imapHost', 'The IMAP server'),
				port: port('imapPort', 993, 'The IMAP port')
			},
			...(syncOnly
				? {}
				: {
						smtp: {
							host: need('smtpHost', 'The SMTP server'),
							port: port('smtpPort', 587, 'The SMTP port')
						}
					})
		};
	const tenant = method === 'microsoft' ? need('tenant', 'The directory (tenant) ID') : undefined;
	if (tenant !== undefined && !/^[\w.-]+$/.test(tenant))
		throw new Error('The directory (tenant) ID does not look right');
	return {
		...common,
		user: address,
		...(syncOnly ? { imap: known!.imap } : known!),
		oauth: {
			clientId: need('clientId', 'The client ID'),
			clientSecret: need('clientSecret', 'The client secret'),
			...(tenant === undefined ? {} : { tenant }),
			tokens: null
		}
	};
}

function provider(method: Method, o: MailboxOptions): ChannelProvider {
	const now = o.now ?? Date.now;
	const known = method === 'password' ? undefined : (o.servers?.[method] ?? KNOWN[method]);
	const id = method === 'password' ? 'imap' : method;
	return {
		transport: 'email',
		supportsSync: true,
		id,
		label:
			method === 'password'
				? t('Mail server (IMAP + SMTP, password)', '邮件服务器（IMAP + SMTP，密码）')
				: method === 'microsoft'
					? t('Microsoft 365 (sign in with Microsoft)', 'Microsoft 365（使用 Microsoft 登录）')
					: t(
							'Google Workspace or Gmail (sign in with Google)',
							'Google Workspace 或 Gmail（使用 Google 登录）'
						),
		setup: method === 'password' ? PASSWORD : method === 'microsoft' ? MICROSOFT : GOOGLE,
		describe: ({ syncOnly }) => ({
			label:
				method === 'password'
					? t(
							syncOnly ? 'Mail server (IMAP, password)' : 'Mail server (IMAP + SMTP, password)',
							syncOnly ? '邮件服务器（IMAP，密码）' : '邮件服务器（IMAP + SMTP，密码）'
						)
					: method === 'microsoft'
						? t('Microsoft 365 (sign in with Microsoft)', 'Microsoft 365（使用 Microsoft 登录）')
						: t(
								'Google Workspace or Gmail (sign in with Google)',
								'Google Workspace 或 Gmail（使用 Google 登录）'
							),
			setup: syncOnly
				? syncSetup(method)
				: method === 'password'
					? PASSWORD
					: method === 'microsoft'
						? MICROSOFT
						: GOOGLE
		}),
		test: {},
		open: (ctx) => open(ctx, method, id, known, o, now)
	};
}

async function open(
	ctx: ChannelOpen,
	method: Method,
	id: string,
	known: { imap: Server; smtp: Server } | undefined,
	o: MailboxOptions,
	now: () => number
): Promise<ChannelLink> {
	const plain = o.plain === true;
	const redirect = `${ctx.webhookUrl}${OAUTH_CALLBACK}`;
	let box: Mailbox | null = isObj(ctx.credential) ? (ctx.credential as unknown as Mailbox) : null;
	let pending: { state: string; verifier: string; url: string; draft: Mailbox; at: number } | null =
		null;
	let problem: string | null = null,
		live: ConnectionState = 'connecting',
		detail: string | null = null;
	let client: ImapFlow | null = null,
		timer: ReturnType<typeof setTimeout> | undefined,
		backoff = 5_000,
		closed = false;
	let refreshing: Promise<Tokens> | null = null,
		draining: Promise<void> = Promise.resolve();
	const domainOf = (m: Mailbox) => m.address.slice(m.address.lastIndexOf('@') + 1);
	const midOf = (m: Mailbox, local: string) => `<${local}@${domainOf(m)}>`;
	const macOf = (m: Mailbox, local: string) =>
		createHmac('sha256', m.pixelKey).update(local).digest('base64url').slice(0, 22);
	const save = async (m: Mailbox) => {
		box = m;
		await ctx.save(m as unknown as Json);
	};
	const need = (): Mailbox => {
		if (box === null) throw new SendRefused('this email channel is not connected');
		return box;
	};

	/** The sign-in for `m`: its password, or a current access token (refreshed once at a time, sealed when it rotates). */
	async function login(m: Mailbox): Promise<{ user: string; pass?: string; accessToken?: string }> {
		if (m.oauth === undefined) return { user: m.user, pass: m.password ?? '' };
		const tokens = m.oauth.tokens;
		if (tokens === null) throw new OAuthRefused('the mailbox is not signed in', true);
		const next = await (refreshing ??= fresh(
			ctx.fetch,
			appOf(m, ctx.syncOnly === true),
			{ id: m.oauth.clientId, secret: m.oauth.clientSecret },
			tokens,
			now()
		).finally(() => {
			refreshing = null;
		}));
		if (next !== tokens && box !== null && box.oauth !== undefined)
			await save({ ...box, oauth: { ...box.oauth, tokens: next } });
		return { user: m.user, accessToken: next.access };
	}
	/** Only a new sign-in (or a new password) helps: the channel says so and stops retrying. */
	function refused(e: unknown): void {
		problem =
			method === 'password'
				? `The mail server refused the sign-in for ${box?.address ?? 'this mailbox'} (${messageOf(e)}). Enter the current password and connect again.`
				: `The sign-in for ${box?.address ?? 'this mailbox'} was revoked or has expired (${messageOf(e)}). Connect and sign in again.`;
		stop();
		ctx.changed();
	}
	const authFailure = (e: unknown) =>
		e instanceof OAuthRefused
			? e.revoked
			: (e as { authenticationFailed?: unknown }).authenticationFailed === true ||
				(e as { code?: unknown }).code === 'EAUTH';

	const imapOf = (m: Mailbox, auth: Awaited<ReturnType<typeof login>>) =>
		new ImapFlow({
			host: m.imap.host,
			port: m.imap.port,
			auth,
			logger: false,
			secure: !plain && m.imap.port === 993,
			doSTARTTLS: plain ? false : m.imap.port === 993 ? undefined : true,
			connectionTimeout: 30_000,
			greetingTimeout: 30_000
		});
	const smtpOf = (m: Mailbox, auth: Awaited<ReturnType<typeof login>>) => {
		if (ctx.syncOnly === true || m.smtp === undefined)
			throw new SendRefused('This mailbox only synchronizes messages.');
		return createTransport({
			host: m.smtp.host,
			port: m.smtp.port,
			secure: !plain && m.smtp.port === 465,
			requireTLS: !plain && m.smtp.port !== 465,
			ignoreTLS: plain,
			connectionTimeout: 30_000,
			greetingTimeout: 30_000,
			socketTimeout: 60_000,
			auth:
				auth.accessToken === undefined
					? { user: auth.user, pass: auth.pass ?? '' }
					: { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken }
		});
	};

	/** Signs in to the configured servers and opens the folder, before anything is kept. */
	async function verify(m: Mailbox): Promise<void> {
		const auth = await login(m);
		const imap = imapOf(m, auth);
		imap.on('error', () => undefined);
		try {
			await imap.connect().catch((e: unknown) => {
				throw new Error(`IMAP ${m.imap.host}: ${messageOf(e)}`);
			});
			await imap.mailboxOpen(m.folder, { readOnly: true }).catch(() => {
				throw new Error(`the mailbox has no folder "${m.folder}"`);
			});
		} finally {
			await imap.logout().catch(() => imap.close());
		}
		if (ctx.syncOnly === true) return;
		const smtp = smtpOf(m, auth);
		try {
			await smtp.verify().catch((e: unknown) => {
				throw new Error(`SMTP ${m.smtp?.host}: ${messageOf(e)}`);
			});
		} finally {
			smtp.close();
		}
	}
	async function adopt(m: Mailbox): Promise<void> {
		stop();
		problem = null;
		await save(m);
		ctx.changed();
		void start();
	}

	// ── watching the folder ──
	function stop(): void {
		clearTimeout(timer);
		const c = client;
		client = null;
		void c?.logout().catch(() => c.close());
	}
	function retry(): void {
		clearTimeout(timer);
		timer = setTimeout(() => void start(), backoff);
		backoff = Math.min(backoff * 2, 300_000);
	}
	async function start(): Promise<void> {
		const m = box;
		if (closed || m === null || problem !== null) return;
		try {
			const me = imapOf(m, await login(m));
			client = me;
			me.on('error', () => undefined); // `close` follows
			me.on('close', () => {
				if (client !== me) return;
				client = null;
				if (!closed && problem === null) {
					live = 'reconnecting';
					ctx.changed();
					retry();
				}
			});
			me.on('exists', () => {
				void drain(me);
			});
			await me.connect();
			const mb = await me.mailboxOpen(m.folder, { readOnly: ctx.syncOnly === true });
			const validity = String(mb.uidValidity);
			// Personal sync backfills the selected folder; messaging channels begin with new arrivals.
			if (box !== null && box.cursor?.validity !== validity)
				await save({
					...box,
					cursor: { validity, uid: ctx.syncOnly === true ? 0 : mb.uidNext - 1 }
				});
			live = 'connected';
			detail = null;
			backoff = 5_000;
			ctx.changed();
			await drain(me);
		} catch (e) {
			if (closed) return;
			if (authFailure(e)) return refused(e);
			live = 'reconnecting';
			detail = messageOf(e);
			ctx.changed();
			stop();
			retry();
		}
	}
	const drain = (me: ImapFlow) =>
		(draining = draining
			.then(() => pull(me))
			.catch(() => {
				// an emit the engine refused is redelivered: the cursor did not move past it
				setTimeout(() => {
					if (client === me) void drain(me);
				}, 60_000);
			}));
	async function pull(me: ImapFlow): Promise<void> {
		const cursor = box?.cursor;
		if (client !== me || box === null || cursor === undefined) return;
		// Search returns only UIDs; fetch bounded batches so a history import never holds the mailbox bodies in memory.
		const found = await me.search({ uid: `${cursor.uid + 1}:*` }, { uid: true });
		const ids = (found || []).filter((uid) => uid > cursor.uid).sort((a, b) => a - b);
		let at = cursor.uid;
		try {
			for (let offset = 0; offset < ids.length; offset += 25) {
				if (client !== me || box === null) return;
				const got: { uid: number; source: Uint8Array }[] = [];
				for await (const msg of me.fetch(
					ids.slice(offset, offset + 25).join(','),
					{ uid: true, source: true },
					{ uid: true }
				))
					if (msg.source !== undefined) got.push({ uid: msg.uid, source: msg.source });
				for (const msg of got.sort((a, b) => a.uid - b.uid)) {
					await deliver(box, msg.source, `imap-${cursor.validity}-${msg.uid}`);
					at = msg.uid;
				}
				if (at !== cursor.uid && box !== null)
					await save({ ...box, cursor: { validity: cursor.validity, uid: at } });
			}
		} finally {
			if (at !== cursor.uid && box !== null)
				await save({ ...box, cursor: { validity: cursor.validity, uid: at } });
		}
	}
	/** One message from the folder: a report on a message we sent, or inbound mail (never our own). */
	async function deliver(m: Mailbox, source: Uint8Array, local: string): Promise<void> {
		const read = await readMail(source, domainOf(m), midOf(m, local), ctx.syncOnly !== true);
		if (read.kind === 'report') {
			for (const providerId of read.ids)
				await ctx.emit({
					kind: 'delivery',
					channel: ctx.channel,
					providerId,
					report: { ...read.report, at: new Date(now()).toISOString(), provider: id }
				});
			return;
		}
		if (read.from === m.address && ctx.syncOnly !== true) return; // a copy of our own (the setup test, a client's sent copy)
		await ctx.emit({
			kind: 'inbound',
			channel: ctx.channel,
			message:
				ctx.syncOnly === true && isObj(read.message)
					? { ...read.message, direction: read.from === m.address ? 'outbound' : 'inbound' }
					: read.message,
			...(read.bins.length === 0 ? {} : { bins: read.bins })
		});
	}

	// ── sending ──
	/** bolt's email wire: `inReplyTo`/`references` are the provider ids earlier in the conversation (Message-IDs, ours or the sender's). */
	type Wire = {
		id: string;
		to: readonly string[];
		cc?: readonly string[];
		subject: string;
		text?: string;
		html?: string;
		inReplyTo?: string;
		references?: readonly string[];
	};
	async function submit(
		m: Mailbox,
		w: Wire,
		mid: string,
		headers: { [k: string]: string } = {},
		files: readonly OutboundAttachment[] = []
	): Promise<void> {
		let auth: Awaited<ReturnType<typeof login>>;
		try {
			auth = await login(m);
		} catch (e) {
			if (authFailure(e)) refused(e);
			throw new SendRefused(messageOf(e));
		}
		const smtp = smtpOf(m, auth);
		const msgid = (s: unknown): s is string => typeof s === 'string' && /^<[^<>\s]+>$/.test(s);
		const inReplyTo = msgid(w.inReplyTo) ? w.inReplyTo : undefined,
			refs = (w.references ?? []).filter(msgid);
		try {
			await smtp.sendMail({
				from: { name: m.fromName ?? '', address: m.address },
				to: [...w.to],
				...(w.cc === undefined ? {} : { cc: [...w.cc] }),
				subject: w.subject,
				...(w.text === undefined ? {} : { text: w.text }),
				...(w.html === undefined ? {} : { html: w.html }),
				messageId: mid,
				headers,
				...(inReplyTo === undefined ? {} : { inReplyTo }),
				...(refs.length === 0 ? {} : { references: refs }),
				...(files.length === 0
					? {}
					: {
							attachments: files.map((f) => ({
								filename: f.name,
								contentType: f.mime,
								content: Buffer.from(f.bytes)
							}))
						}),
				// sent only when the server advertises DSN; the envelope id is how a report names this message back
				dsn: {
					id: w.id,
					return: 'headers',
					notify: ['success', 'failure', 'delay'],
					recipient: m.address
				}
			});
		} catch (e) {
			const x = e as { responseCode?: unknown; response?: unknown; code?: unknown };
			if (typeof x.responseCode === 'number' && x.responseCode >= 400) {
				const response = typeof x.response === 'string' ? x.response : messageOf(e);
				if (x.code === 'EAUTH') refused(e);
				throw new SendRefused(
					`${m.smtp?.host}: ${response}`,
					codeOf(response),
					x.responseCode >= 500
				);
			}
			if (x.code === 'EENVELOPE') throw new SendRefused(messageOf(e));
			throw e; // the network: retried
		} finally {
			smtp.close();
		}
	}

	// ── the OAuth callback and the open pixel, on this channel's webhook ──
	const page = (status: number, text: string, close = false) =>
		new Response(
			`<!doctype html><meta charset="utf-8"><title>Norbital</title>` +
				`<p style="font:15px system-ui;margin:3rem auto;max-width:28rem">${escape(text)}</p>${close ? '<script>window.close()</script>' : ''}`,
			{
				status,
				headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
			}
		);
	async function callback(q: URLSearchParams): Promise<Response> {
		const p = pending;
		if (p === null || !same(q.get('state') ?? '', p.state) || now() - p.at > STATE_MS)
			return page(
				400,
				"This sign-in is unknown or has expired. Start again from the channel's setup."
			);
		pending = null;
		try {
			const error = q.get('error');
			if (error !== null)
				throw new Error(
					`the sign-in was refused (${error})${q.get('error_description') === null ? '' : `: ${q.get('error_description')!.split('\n')[0]}`}`
				);
			const oauth = p.draft.oauth!;
			const tokens = await grant(
				ctx.fetch,
				appOf(p.draft, ctx.syncOnly === true),
				{ id: oauth.clientId, secret: oauth.clientSecret },
				{
					grant_type: 'authorization_code',
					code: q.get('code') ?? '',
					redirect_uri: redirect,
					code_verifier: p.verifier
				},
				now()
			);
			const m: Mailbox = { ...p.draft, oauth: { ...oauth, tokens } };
			await verify(m);
			await adopt(m);
			return page(200, `Connected as ${m.address}. You can close this window.`, true);
		} catch (e) {
			problem = `${messageOf(e)}. Check the app registration and connect again.`;
			ctx.changed();
			return page(400, `Not connected: ${problem}`);
		}
	}

	if (box !== null) void start();
	return {
		connection() {
			const m = box;
			if (pending !== null && now() - pending.at <= STATE_MS)
				return connection(ctx.channel, 'email', 'pairing', {
					stored: m !== null,
					pairing: {
						kind: 'oauth',
						value: pending.url,
						label: SIGN_IN[method as 'microsoft' | 'google']
					}
				});
			if (problem !== null)
				return connection(ctx.channel, 'email', 'error', { stored: m !== null, error: problem });
			if (m === null) return connection(ctx.channel, 'email', 'unpaired');
			return connection(ctx.channel, 'email', live, {
				stored: true,
				pairedAs: m.address,
				...(detail === null ? {} : { detail }),
				about: {
					address: m.address,
					server: ctx.syncOnly === true ? m.imap.host : `${m.imap.host} · ${m.smtp?.host}`,
					folder: m.folder,
					openTracking: m.tracking ? 'on' : 'off'
				}
			});
		},
		async pair(input) {
			const draft = mailboxOf(method, input, known, ctx.syncOnly === true);
			if (draft.oauth === undefined) {
				await verify(draft);
				await adopt(draft);
				return;
			}
			const a = attempt();
			pending = {
				state: a.state,
				verifier: a.verifier,
				at: now(),
				draft,
				url: authorizeUrl(
					appOf(draft, ctx.syncOnly === true),
					draft.oauth.clientId,
					redirect,
					a.state,
					a.challenge,
					draft.address
				)
			};
			problem = null;
			ctx.changed();
		},
		async unpair() {
			pending = null;
			problem = null;
			stop();
			box = null;
			await ctx.save(null);
		},
		async close() {
			closed = true;
			stop();
		},
		async send(_channel, message, signal, files) {
			if (ctx.syncOnly === true) throw new SendRefused('This mailbox only synchronizes messages.');
			const m = need(),
				w = message as unknown as Wire;
			const mid = midOf(m, w.id);
			// the pixel names the message by its bolt id and a MAC under the channel's own key: nothing personal in the URL
			const html =
				w.html !== undefined && m.tracking
					? `${w.html}<img src="${ctx.webhookUrl}/open/${w.id}.${macOf(m, w.id)}.gif" width="1" height="1" alt="" style="display:none">`
					: w.html;
			if (signal.aborted) throw signal.reason;
			await submit(m, { ...w, ...(html === undefined ? {} : { html }) }, mid, {}, files);
			return { providerId: mid, presumeAfterMs: m.quietHours * 3_600_000 };
		},
		/** Sends a message to the mailbox itself and waits for it to arrive in the watched folder (or INBOX). */
		async test(signal) {
			if (ctx.syncOnly === true) throw new SendRefused('This mailbox only synchronizes messages.');
			const m = need(),
				local = randomUUID(),
				mid = midOf(m, local);
			await submit(
				m,
				{
					id: local,
					to: [m.address],
					subject: 'Norbital test message',
					text: 'This email channel is connected: sending and receiving both work.'
				},
				mid,
				{ 'X-Norbital-Test': local }
			);
			const imap = imapOf(m, await login(m));
			imap.on('error', () => undefined);
			await imap.connect();
			try {
				while (!signal.aborted) {
					for (const folder of new Set([m.folder, 'INBOX'])) {
						await imap.mailboxOpen(folder, { readOnly: true });
						const hits = await imap.search({ header: { 'message-id': mid } }, { uid: true });
						if (Array.isArray(hits) && hits.length > 0) return;
					}
					await sleep(3_000, signal);
				}
			} catch (e) {
				if (!signal.aborted) throw e;
			} finally {
				await imap.logout().catch(() => imap.close());
			}
			throw new Error(
				`The test message was sent but did not arrive in "${m.folder}": check the folder and any mail rules that move it.`
			);
		},
		async webhook(request) {
			const url = new URL(request.url),
				base = new URL(ctx.webhookUrl).pathname;
			const rest = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : '';
			if (request.method === 'GET' && rest === OAUTH_CALLBACK) return callback(url.searchParams);
			const hit = /^\/open\/([\w-]{1,64})\.([\w-]{22})\.gif$/.exec(rest);
			if (request.method === 'GET' && hit !== null) {
				const m = box;
				// answered the same either way: the pixel is no oracle for which ids exist
				if (m !== null && m.tracking && same(hit[2]!, macOf(m, hit[1]!)))
					await ctx
						.emit({
							kind: 'delivery',
							channel: ctx.channel,
							providerId: midOf(m, hit[1]!),
							report: {
								kind: 'opened',
								at: new Date(now()).toISOString(),
								provider: id,
								approximate: true
							}
						})
						.catch(() => undefined);
				return new Response(PIXEL, {
					headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, private' }
				});
			}
			return new Response(null, { status: 404 });
		}
	};
}

/**
 * The email channel's providers, one per sign-in method, so setup first asks which: a password on any IMAP + SMTP
 * server, or OAuth with Microsoft 365 or Google through the tenant's own app registration.
 */
export function mailbox(o: MailboxOptions = {}): ChannelProvider[] {
	return (['password', 'microsoft', 'google'] as const).map((m) => provider(m, o));
}
