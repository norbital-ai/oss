// The page's transient notices (Sonner's shape, in a few lines): `toast(text)` or `toast.success(text)` queues one, and
// the shell's one `<Toaster />` shows it for a few seconds. Module state: one queue per page, whoever calls.

/** A toast's colour and icon. */
export type ToastTone = 'default' | 'success' | 'info' | 'warning' | 'error';
/** A queued toast. */
export type ToastItem = { readonly id: number; readonly text: string; readonly description?: string; readonly tone: ToastTone };
/** `description` is a second, muted line; `duration` (ms) defaults to 4 s, 6 s for an error. */
export type ToastOptions = { description?: string; duration?: number };

let next = 0;
export const toasts = $state<ToastItem[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Removes a toast now (its close button, or the timer). */
export function dismiss(id: number): void {
	clearTimeout(timers.get(id));
	timers.delete(id);
	const i = toasts.findIndex((t) => t.id === id);
	if (i !== -1) toasts.splice(i, 1);
}

function show(tone: ToastTone, text: string, options: ToastOptions = {}): number {
	const id = ++next;
	toasts.push({ id, text, tone, ...(options.description === undefined ? {} : { description: options.description }) });
	// ponytail: at most five on screen; the oldest goes first
	if (toasts.length > 5) dismiss(toasts[0]!.id);
	timers.set(id, setTimeout(() => dismiss(id), options.duration ?? (tone === 'error' ? 6000 : 4000)));
	return id;
}

/** Shows a toast; `toast.success`, `.info`, `.warning` and `.error` pick its tone. Returns its id (`dismiss`). */
export const toast = Object.assign((text: string, options?: ToastOptions) => show('default', text, options), {
	success: (text: string, options?: ToastOptions) => show('success', text, options),
	info: (text: string, options?: ToastOptions) => show('info', text, options),
	warning: (text: string, options?: ToastOptions) => show('warning', text, options),
	error: (text: string, options?: ToastOptions) => show('error', text, options),
	dismiss
});
