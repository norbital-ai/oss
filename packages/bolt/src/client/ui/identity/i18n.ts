import { defineMessages } from '@norbital-ai/std/i18n';

export const boltIdentityMessages = defineMessages({
	en: {
		'bolt.identity.headingSignIn': 'Sign in',
		'bolt.identity.emailLabel': 'Email address',
		'bolt.identity.emailPlaceholder': 'you@company.com',
		'bolt.identity.sendCode': 'Send sign-in code',
		'bolt.identity.noPasswordHint': "We'll email you a six-digit code. No password required.",
		'bolt.identity.headingEnterCode': 'Enter your code',
		'bolt.identity.sentTo': 'Sent to {email}',
		'bolt.identity.codeLabel': 'Six-digit code',
		'bolt.identity.verifyAndContinue': 'Verify and continue',
		'bolt.identity.changeEmail': 'Change email',
		'bolt.identity.codeExpiresPrefix': 'The code expires in ten minutes.',
		'bolt.identity.invalidEmail': 'Enter a valid email address.',
		'bolt.identity.incorrectCode': 'That code is not correct.',
		'bolt.identity.noAccess': 'That email does not have access to this workspace.',
		'bolt.identity.unknownWorkspace': 'That organization does not exist. Check the handle and try again.',
		'bolt.identity.tooManyAttempts': 'Too many attempts. Wait a few minutes and try again.',
		'bolt.identity.genericError': 'Something went wrong. Please try again.'
	},
	zh: {
		'bolt.identity.headingSignIn': '登录',
		'bolt.identity.emailLabel': '邮箱地址',
		'bolt.identity.emailPlaceholder': 'you@company.com',
		'bolt.identity.sendCode': '发送登录验证码',
		'bolt.identity.noPasswordHint': '我们会寄出六位数验证码。无需密码。',
		'bolt.identity.headingEnterCode': '输入验证码',
		'bolt.identity.sentTo': '已发送至 {email}',
		'bolt.identity.codeLabel': '六位验证码',
		'bolt.identity.verifyAndContinue': '验证并继续',
		'bolt.identity.changeEmail': '更换邮箱',
		'bolt.identity.codeExpiresPrefix': '验证码十分钟内有效。',
		'bolt.identity.invalidEmail': '请输入有效的电子邮箱。',
		'bolt.identity.incorrectCode': '验证码不正确。',
		'bolt.identity.noAccess': '该邮箱无权访问此工作区。',
		'bolt.identity.unknownWorkspace': '该组织不存在。请检查名称后重试。',
		'bolt.identity.tooManyAttempts': '尝试次数过多。请稍候几分钟后重试。',
		'bolt.identity.genericError': '出了点问题，请再试一次。'
	}
});

export type IdentityLocale = 'en' | 'zh';
/**
 * The refusals a sign-in surface can render precisely.
 *
 * Anything outside this set falls through to one generic sentence, which is the right default and
 * the reason the set has to cover what actually happens: a host that answered with a *message*
 * rather than one of these codes rendered every refusal as "Something went wrong", including the
 * two most common ones — a mistyped organization and a rate limit — so the one thing the person
 * could have acted on was the one thing the screen would not say.
 */
export type IdentityFailure =
	| 'invalid-email'
	| 'invalid-code'
	| 'no-access'
	| 'unknown-workspace'
	| 'too-many-attempts'
	| 'mint-failed';

export type SignInTransport = {
	readonly sendCode: (
		email: string
	) => Promise<{ ok: true } | { ok: false; reason: IdentityFailure | string }>;
	readonly verifyCode: (
		email: string,
		code: string
	) => Promise<{ ok: true } | { ok: false; reason: IdentityFailure | string }>;
};

/** Tenant-owned strings for the email and OTP surfaces. */
export const identityCopy = (locale: IdentityLocale) => boltIdentityMessages[locale];

export const identityFailureMessage = (
	locale: IdentityLocale,
	reason: IdentityFailure | string
): string => {
	const copy = identityCopy(locale);
	if (reason === 'invalid-email') return copy['bolt.identity.invalidEmail'];
	if (reason === 'invalid-code') return copy['bolt.identity.incorrectCode'];
	if (reason === 'no-access') return copy['bolt.identity.noAccess'];
	if (reason === 'unknown-workspace') return copy['bolt.identity.unknownWorkspace'];
	if (reason === 'too-many-attempts') return copy['bolt.identity.tooManyAttempts'];
	return copy['bolt.identity.genericError'];
};
