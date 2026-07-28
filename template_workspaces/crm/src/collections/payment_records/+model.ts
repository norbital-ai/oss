import { custom, date, defineModel, enums, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		quote_id: uuid().notNull(),
		amount: custom('money', { allowedCurrencies: ['CNY', 'USD', 'EUR', 'GBP', 'SGD'] }),
		payment_date: date().notNull(),
		method: enums([
			'bank_transfer',
			'cash',
			'cheque',
			'online',
			'wechat_pay',
			'alipay',
			'letter_of_credit',
			'other'
		]),
		reference: text(),
		notes: text()
	},
	{
		description:
			'Payments received against a confirmed or fulfilled quote/order. Used to derive paid status.',
		recordLabel: ['quote_id', 'amount'],
		icon: 'lucide:banknote',
		indexes: [{ columns: ['quote_id'] }, { columns: ['payment_date'] }]
	}
);
