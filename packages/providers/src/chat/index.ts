// Every chat platform, each one adapter under `chat/<id>/`, as providers of the `chat` and `whatsapp` drivers.
import { agentphone } from './agentphone/index.ts';
import { chatProvider, type ChatPlatform } from './adapter.ts';
import { blooio } from './blooio/index.ts';
import { dial } from './dial/index.ts';
import { gchat } from './gchat/index.ts';
import { github } from './github/index.ts';
import { gitlab } from './gitlab/index.ts';
import { gmail } from './gmail/index.ts';
import { instagram } from './instagram/index.ts';
import { kapso } from './kapso/index.ts';
import { lark } from './lark/index.ts';
import { line } from './line/index.ts';
import { linear } from './linear/index.ts';
import { linq } from './linq/index.ts';
import { liveblocks } from './liveblocks/index.ts';
import { mattermost } from './mattermost/index.ts';
import { messenger } from './messenger/index.ts';
import { notion } from './notion/index.ts';
import { novu } from './novu/index.ts';
import { photon } from './photon/index.ts';
import { qq } from './qq/index.ts';
import { resend } from './resend/index.ts';
import { sendblue } from './sendblue/index.ts';
import { teams } from './teams/index.ts';
import { twilioSms } from './twilio-sms/index.ts';
import { twitch } from './twitch/index.ts';
import { velt } from './velt/index.ts';
import { webex } from './webex/index.ts';
import { wecom } from './wecom/index.ts';
import { weixin } from './weixin/index.ts';
import { whatsappCloud } from './whatsapp-cloud/index.ts';
import { x } from './x/index.ts';
import { xchat } from './xchat/index.ts';
import { zalo } from './zalo/index.ts';
import { zernio } from './zernio/index.ts';

export const PLATFORMS: readonly ChatPlatform[] = [
	agentphone,
	blooio,
	dial,
	gchat,
	github,
	gitlab,
	gmail,
	instagram,
	kapso,
	lark,
	line,
	linear,
	linq,
	liveblocks,
	mattermost,
	messenger,
	notion,
	novu,
	photon,
	qq,
	resend,
	sendblue,
	teams,
	twilioSms,
	twitch,
	velt,
	webex,
	wecom,
	weixin,
	whatsappCloud,
	x,
	xchat,
	zalo,
	zernio
];
export const chatProviders = () => PLATFORMS.map(chatProvider);
