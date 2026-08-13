import { type VariantProps, tv } from 'tailwind-variants';

export const indicatorVariants = tv({
	base: 'pointer-events-none absolute z-10 rounded-full motion-reduce:animate-none',
	variants: {
		variant: {
			default: 'bg-primary',
			success: 'bg-green-500',
			warning: 'bg-yellow-500',
			error: 'bg-red-500',
			info: 'bg-brand'
		},
		size: {
			sm: 'h-1.5 w-1.5',
			md: 'h-2 w-2',
			lg: 'h-3 w-3'
		},
		position: {
			'top-right': 'right-0 top-0',
			'top-left': 'left-0 top-0',
			'bottom-right': 'right-0 bottom-0',
			'bottom-left': 'left-0 bottom-0'
		},
		animated: {
			true: 'animate-pulse'
		}
	},
	defaultVariants: {
		variant: 'default',
		size: 'md',
		position: 'top-right',
		animated: true
	}
});

type IndicatorProps = VariantProps<typeof indicatorVariants>;
export type IndicatorVariant = IndicatorProps['variant'];
export type IndicatorSize = IndicatorProps['size'];
export type IndicatorPosition = IndicatorProps['position'];
