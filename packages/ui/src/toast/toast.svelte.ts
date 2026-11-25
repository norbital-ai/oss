// The page's transient notices (Sonner's shape, in a few lines): `toast(text)` or `toast.success(text)` queues one, and
// the shell's one `<Toaster />` shows it for a few seconds, pausing timers while hovered or focused.

/** A toast's colour and icon. */
export type ToastTone = 'default' | 'success' | 'info' | 'warning' | 'error';

/** Optional action button displayed inside a toast. */
export type ToastAction = {
	readonly label: string;
	readonly on_click: () => void;
};

/** A queued toast. */
export type ToastItem = {
	readonly id: number;
	readonly text: string;
	readonly description?: string;
	readonly tone: ToastTone;
	readonly action?: ToastAction;
};

/** `description` is a second, muted line; `duration` (ms) defaults to 4 s, 6 s for an error. */
export type ToastOptions = {
	readonly description?: string;
	readonly duration?: number;
	readonly action?: ToastAction;
};

type TimerState = {
	timer: ReturnType<typeof setTimeout> | undefined;
	remaining: number;
	startedAt: number;
};

let next = 0;
export const toasts = $state<ToastItem[]>([]);
const timers = new Map<number, TimerState>();

function arm(id: number, ms: number): void {
	const state = timers.get(id);
	if (state === undefined) return;
	if (state.timer !== undefined) clearTimeout(state.timer);
	state.remaining = Math.max(0, ms);
	state.startedAt = Date.now();
	state.timer = setTimeout(() => dismiss(id), state.remaining);
}

/** Pauses auto-dismiss for `id` (or every toast when omitted) while hovered or focused. */
export function pause(id?: number): void {
	const ids = id === undefined ? [...timers.keys()] : [id];
	for (const key of ids) {
		const state = timers.get(key);
		if (state === undefined || state.timer === undefined) continue;
		clearTimeout(state.timer);
		state.timer = undefined;
		state.remaining = Math.max(0, state.remaining - (Date.now() - state.startedAt));
	}
}

/** Resumes auto-dismiss for `id` (or every toast when omitted) after hover/focus leaves. */
export function resume(id?: number): void {
	const ids = id === undefined ? [...timers.keys()] : [id];
	for (const key of ids) {
		const state = timers.get(key);
		if (state === undefined || state.timer !== undefined) continue;
		if (state.remaining <= 0) dismiss(key);
		else arm(key, state.remaining);
	}
}

/** Removes a toast now (its close button, swipe, or the timer). */
export function dismiss(id: number): void {
	const state = timers.get(id);
	if (state?.timer !== undefined) clearTimeout(state.timer);
	timers.delete(id);
	const i = toasts.findIndex((t) => t.id === id);
	if (i !== -1) toasts.splice(i, 1);
}

function show(tone: ToastTone, text: string, options: ToastOptions = {}): number {
	const id = ++next;
	toasts.push({
		id,
		text,
		tone,
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.action === undefined ? {} : { action: options.action })
	});
	// ponytail: at most five on screen; the oldest goes first
	const oldest = toasts[0];
	if (toasts.length > 5 && oldest !== undefined) dismiss(oldest.id);
	const ms = options.duration ?? (tone === 'error' ? 6000 : 4000);
	timers.set(id, { timer: undefined, remaining: ms, startedAt: Date.now() });
	arm(id, ms);
	return id;
}

/** Shows a toast; `toast.success`, `.info`, `.warning` and `.error` pick its tone. Returns its id (`dismiss`). */
export const toast = Object.assign(
	(text: string, options?: ToastOptions) => show('default', text, options),
	{
		success: (text: string, options?: ToastOptions) => show('success', text, options),
		info: (text: string, options?: ToastOptions) => show('info', text, options),
		warning: (text: string, options?: ToastOptions) => show('warning', text, options),
		error: (text: string, options?: ToastOptions) => show('error', text, options),
		pause,
		resume,
		dismiss
	}
);
