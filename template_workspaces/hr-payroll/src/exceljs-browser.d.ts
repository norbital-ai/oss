declare module 'exceljs/dist/exceljs.bare.min.js' {
	import type ExcelJS from 'exceljs';

	const browserDistribution: {
		readonly Workbook: typeof ExcelJS.Workbook;
	};

	export default browserDistribution;
}
