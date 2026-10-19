<!--
@component
A mobile number proven on the page: the number and "Send code" side by side; the six-digit code opens in a popover
beneath them, and the sixth digit verifies. `session` sends and checks the code (a Bolt page passes `bolt.session`,
which signs the viewer in, signing a newcomer up where the workspace allows it, and reloads the page as them).
-->
<script lang="ts" module>
	import type { Effect as EffectType } from 'effect';
	type Said = EffectType.Effect<void, { readonly message: string }>;
	/** What sends a code to a number and proves it. */
	export type CodeSession = {
		sendCode(address: string): Said;
		verify(address: string, code: string): Said;
	};
	/** The props of `PhoneVerify`. */
	export interface PhoneVerifyProps {
		session: CodeSession;
		/** The number's label; the kit's "Mobile number" by default. */
		label?: string;
		id?: string;
	}
</script>

<script lang="ts">
	import { Effect, FiberHandle } from 'effect';
	import { attach, fork } from '../effect/index.js';
	import { Cluster, Stack } from '../layout/index.js';
	import { Button, Label, Spinner } from '../primitives/index.js';
	import { Popover, PopoverContent } from '../primitives/popover/index.js';
	import { uiText } from '../primitives/utils.js';
	import PhoneInput from '../kinds/phone-input.svelte';
	import PinInput from './pin-input.svelte';

	let { session, label, id = 'phone-verify' }: PhoneVerifyProps = $props();
	const t = uiText();

	let phone = $state<string | null>(null);
	let code = $state('');
	/** A code is out for `phone`; `open` shows its popover. */
	let sent = $state(false);
	let open = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let row = $state<HTMLElement | null>(null);

	let request: FiberHandle.FiberHandle | undefined;
	const lifetime = attach(() =>
		Effect.gen(function* () {
			request = yield* FiberHandle.make();
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					request = undefined;
				})
			);
			yield* Effect.never;
		})
	);
	const start = (work: Said, success: () => void, rejected: () => void = () => {}) => {
		if (request === undefined) return;
		busy = true;
		error = null;
		fork(
			FiberHandle.run(
				request,
				work.pipe(
					Effect.tap(() => Effect.sync(success)),
					Effect.catch((failure) =>
						Effect.sync(() => {
							error = failure.message;
							rejected();
						})
					),
					Effect.ensuring(
						Effect.sync(() => {
							busy = false;
						})
					)
				)
			)
		);
	};
	function send() {
		if (phone !== null)
			start(session.sendCode(phone), () => {
				sent = open = true;
				code = '';
			});
	}
	function verify() {
		if (phone !== null && code.length === 6 && !busy)
			start(
				session.verify(phone, code),
				() => {},
				() => {
					code = '';
				}
			);
	}
</script>

<Stack gap="sm">
	<Label for={id}>{label ?? t('mobileNumber')}</Label>
	<!-- a phone narrower than the number and its button puts the button beneath -->
	<div bind:this={row} {@attach lifetime}>
		<Cluster gap="sm" align="center">
			<div class="min-w-64 flex-1">
				<PhoneInput
					{id}
					value={phone}
					disabled={busy}
					invalid={error !== null && !open}
					onChange={(v) => {
						phone = typeof v === 'string' ? v : null;
						sent = open = false;
						code = '';
					}}
				/>
			</div>
			<Button disabled={phone === null || busy} onclick={() => (sent ? (open = true) : send())}>
				{#if busy && !open}<Spinner class="h-4 w-4" />{/if}{sent ? t('enterCode') : t('sendCode')}
			</Button>
		</Cluster>
	</div>
	{#if error !== null && !open}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
</Stack>

<Popover bind:open>
	<PopoverContent customAnchor={row} side="bottom" align="start" sameWidth sideOffset={8}>
		<Stack gap="md">
			<Stack gap="xs">
				<p class="text-sm font-semibold">{t('enterCode')}</p>
				<p class="text-caption">{t('codeSent').replace('{phone}', phone ?? '')}</p>
			</Stack>
			<PinInput
				aria-label={t('code')}
				bind:value={code}
				aria-invalid={error !== null}
				onComplete={verify}
			/>
			{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
			<Button class="w-full" disabled={code.length !== 6 || busy} onclick={verify}>
				{#if busy}<Spinner class="h-4 w-4" />{/if}{t('verify')}
			</Button>
			<Cluster gap="md" justify="between">
				<button
					type="button"
					class="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
					disabled={busy}
					onclick={send}
				>
					{t('resendCode')}
				</button>
				<button
					type="button"
					class="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
					onclick={() => {
						sent = open = false;
						code = '';
						error = null;
					}}
				>
					{t('changeNumber')}
				</button>
			</Cluster>
		</Stack>
	</PopoverContent>
</Popover>
