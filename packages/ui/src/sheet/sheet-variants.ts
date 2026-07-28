import { type VariantProps, tv } from 'tailwind-variants';

export const sheetVariants = tv({
	base: 'bg-popover z-50 flex origin-center flex-col gap-2 p-6 shadow-lg duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
	variants: {
		side: {
			top: 'inset-x-0 top-0 border-b',
			bottom: 'inset-x-0 bottom-0 border-t',
			left: 'inset-x-0 bottom-0 h-[min(90dvh,48rem)] max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-full max-w-full rounded-t-xl border-t pb-[env(safe-area-inset-bottom)] md:inset-y-0 md:right-auto md:left-0 md:h-full md:max-h-full md:w-[var(--sheet-width,75%)] md:max-w-[var(--sheet-max-width,90%)] md:rounded-none md:border-t-0 md:border-r md:pb-0',
			right:
				'inset-x-0 bottom-0 h-[min(90dvh,48rem)] max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-full max-w-full rounded-t-xl border-t pb-[env(safe-area-inset-bottom)] md:inset-y-0 md:right-0 md:left-auto md:h-full md:max-h-full md:w-[var(--sheet-width,75%)] md:max-w-[var(--sheet-max-width,90%)] md:rounded-none md:border-t-0 md:border-l md:pb-0'
		}
	},
	defaultVariants: {
		side: 'right'
	}
});

export type Side = VariantProps<typeof sheetVariants>['side'];
