// The framework's own copy (L-BOLT-535, 619, 765): the shell's strings and ui's chrome (`UI_TEXT`) in every framework
// locale. English is the key itself; `zh` is written out here, and `tests/shell-i18n.test.ts` fails on a shell key or
// a ui key it lacks. The viewer's language choice is a per-browser preference over the workspace's locale.
import type { UiTextKey } from '@norbital-ai/ui';

export const LOCALES = ['en', 'zh'] as const;
export type FrameworkLocale = typeof LOCALES[number];
/** Each locale's name in its own language: the switch's label. */
export const LANGUAGE: { readonly [l in FrameworkLocale]: string } = { en: 'English', zh: '中文' };
const CHOICE = 'bolt.locale';

/** The viewer's chosen locale, else the workspace's. Storage may be absent or refuse (a private window). */
export function chosenLocale(workspace: string): string {
	try {
		return localStorage.getItem(CHOICE) ?? workspace;
	} catch {
		return workspace;
	}
}
/** Remembers the choice and reloads, so every string (and ui's chrome, read once per component) follows it. */
export function setLocale(locale: string): void {
	try { localStorage.setItem(CHOICE, locale); } catch { /* not remembered; this load still switches */ }
	location.reload();
}

export const UI_ZH: { readonly [k in UiTextKey]: string } = {
	close: '关闭', expand: '展开', collapse: '收起', resize: '调整大小', save: '保存', saving: '保存中…', cancel: '取消',
	create: '新建', add: '添加', remove: '移除', none: '—', yes: '是', no: '否', upload: '上传文件', uploading: '上传中…',
	useMyLocation: '使用我的位置', latitude: '纬度', longitude: '经度', searchAddress: '搜索地址',
	pickOnMap: '在地图上选择', mapUnavailable: '地图不可用', locationDenied: '无法获取位置', from: '从', to: '至',
	openEnded: '无结束', pendingApproval: '已提交审批', conflict: '此记录在您打开后已被更改。请检查后再次保存。',
	unknown: '结果尚未确定。重试前请再次检查。', select: '请选择…', search: '搜索…', noResults: '无结果', optionsUnavailable: '无法加载选项',
	required: '必填', invalid: '无效的值', noAccess: '无权访问', notFound: '未找到或无权访问', field: '字段', kind: '类型', optional: '可选', fields: '字段',
	today: '今天', previous: '上一个', next: '下一个', more: '还有 {n} 项', day: '日', week: '周', month: '月', notifications: '通知',
	fullScreen: '全屏', exitFullScreen: '退出全屏', createdAt: '{who} 于 {when} 创建', updatedAt: '{who} 于 {when} 更新',
	unsaved: '未保存的更改', discard: '放弃', discardDraft: '放弃未保存的更改？', copy: '复制', copied: '已复制',
	addressSearchUnavailable: '地址搜索不可用', addFiles: '添加文件', addFile: '添加文件', fileSize: '大小', fileType: '类型', uploaded: '上传时间', uploadedBy: '上传者',
	upToFiles: '最多 {n} 个文件', sizeEach: '每个 {size}', fileCount: '{n} 个文件', download: '下载', preview: '预览', retry: '重试',
	uploadFailed: '上传失败', countryCode: '国家代码', invalidPhone: '请输入有效的电话号码', currency: '货币',
	mobileNumber: '手机号码', sendCode: '发送验证码', resendCode: '重新发送验证码', verify: '验证', code: '六位验证码', codeSent: '验证码已发送至 {phone}。', enterCode: '输入验证码', changeNumber: '更换号码',
	searchMeaning: '按语义搜索', searchPick: '输入 / 选择搜索方式', searchClear: '返回普通搜索', searchRun: '搜索',
	searchRaw: '{field} 是原始向量：请从页面中运行此搜索', searchView: '此视图无法显示排序结果：请在表格中打开', searchNone: '此处没有搜索索引', searchFields: '搜索 {fields}', searchCommands: '输入 / 使用命令',
};

export const SHELL_ZH: { readonly [key: string]: string } = {
	'AI provider not configured. An administrator must set one up (BOLT_AI_SYS_1_* and BOLT_AI_SYS_2_*) before the assistant can answer.':
		'尚未配置 AI 服务。管理员需先设置（BOLT_AI_SYS_1_* 与 BOLT_AI_SYS_2_*），助手才能回答。',
	'API key': 'API 密钥', 'API keys': 'API 密钥', 'About': '关于', 'Accept the invitation': '接受邀请', 'Active': '启用', 'Admin': '管理员',
	'Administrator': '管理员', 'Agent': '智能体', 'All steps completed': '所有步骤已完成',
	'Applications': '应用', 'Approvals': '审批',
	'Approve': '批准', 'Ask Norbius': '询问 Norbius',
	'Assign': '分配', 'Assign to': '分配给', 'Assignments': '权限分配', 'Attach': '附加',
	'Attach a nonempty image, PDF, DOCX, XLSX or text document.': '请附加非空的图片、PDF、DOCX、XLSX 或文本文件。',
	'Attach at most 8 files totaling 20 MiB.': '最多附加 8 个文件，总计不超过 20 MiB。', 'Attached': '已附加', 'Attached message': '附加的消息',
	'Attempts': '尝试次数', 'Audit': '审计', 'Automation': '自动化', 'Automations': '自动化', 'Awaiting approval': '等待审批',
	'Asking the host…': '正在询问主机…', 'Connected as {as}': '已连接为 {as}', 'Connecting': '正在连接',
	'Needs attention': '需要处理', 'Not paired': '未配对', 'Paired, not connected': '已配对，未连接', 'Pairing': '正在配对',
	'Pairing…': '正在配对…', 'Pair this channel': '配对此渠道', 'Reconnect': '重新连接', 'Disconnect': '断开连接',
	'Scannable code for {channel}': '{channel} 的扫码配对码',
	'The host stopped reporting this channel.': '主机已停止上报此渠道。',
	"This channel’s connection could not be loaded:": '此渠道的连接界面无法加载：',
	'Open a channel to pair it with its provider and to see its outbound deliveries; an automatic retry is progress, only a settled failure is terminal.': '打开某个渠道即可与服务商配对并查看其出站投递；自动重试属于进行中，只有确定失败才是终态。',
	'Connected as': '连接身份', 'Provider': '服务商', 'Setup complete': '设置完成', 'Webhook URL': 'Webhook 地址', 'Bot': '机器人',
	'Servers': '服务器', 'Invite link': '邀请链接', 'Sender': '发送方', 'Credential': '凭据', 'optional': '可选', 'Connect': '连接',
	'This channel is live: messages to it reach the workspace, and replies go out through it.': '此渠道已上线：发给它的消息会进入工作区，回复也经由它发出。',
	'This custom channel has no setup screen. Add src/channel/+{channel}.connect.svelte to the workspace.': '此自定义渠道没有设置界面。请在工作区中添加 src/channel/+{channel}.connect.svelte。',
	'This host offers no provider for this channel’s transport.': '本主机没有为此渠道的传输方式提供服务商。',
	'Choose how this channel connects': '选择此渠道的连接方式', 'Choose another provider': '选择其他服务商',
	'Send a test message': '发送测试消息', 'Test message sent': '测试消息已发送',
	'Scan this with the app on the phone this channel should answer as.': '请用此渠道应答所用手机上的应用扫描此码。',
	'Enter this code in the app on the phone this channel should answer as.': '请在此渠道应答所用手机上的应用中输入此代码。',
	'The code appears when the provider publishes it.': '服务商发布代码后会显示在这里。',
	'Sign in with Microsoft': '使用 Microsoft 登录', 'Sign in with Google': '使用 Google 登录', 'Redirect URI': '重定向 URI', 'Server': '服务器',
	'Folder': '文件夹', 'Open tracking': '打开跟踪', 'Sign in in the window that opens; this page updates when you are done.': '请在打开的窗口中登录；完成后此页面会自动更新。',
	'Building the preview…': '正在生成预览…', 'Cancel': '取消', 'Cause': '起因', 'Change': '变更', 'Changes': '变更', 'Channels': '渠道',
	'Clear': '清除', 'Collapse navigation': '收起导航', 'Collections': '数据集', 'Confirm': '确认', 'Confirm this action?': '确认执行此操作？',
	'Context checkpoint': '上下文检查点', 'Context window used': '已用上下文窗口', 'Conversation': '对话', 'Conversations': '对话',
	'Copy this key now; it is not shown again:': '请立即复制此密钥，它不会再次显示：', 'Create team': '创建团队', 'Decline': '拒绝',
	'Delete': '删除', 'Delete file': '删除文件', 'Delete plan': '删除计划',
	'Delete the team {name}? Its members keep their access through other grants only.': '删除团队 {name}？其成员仅保留通过其他授权获得的访问权限。',
	'Directive': '指令', 'Done': '完成', 'Download this conversation as Markdown': '将此对话下载为 Markdown', 'Due': '到期', 'Edit': '编辑',
	'Editing a queued message.': '正在编辑排队中的消息。', 'Email': '邮箱', 'End preview': '结束预览',
	'Environment secrets': '环境密钥', 'Error': '错误',
	'Everyone with access to this workspace. Administrators see everything; preview a member to check what their teams grant.':
		'所有可访问此工作区的人。管理员可查看全部；预览某位成员以检查其团队授予的权限。',
	'Execute plan': '执行计划', 'Expand navigation': '展开导航', 'Explain': '说明权限', 'External': '外部', 'Fields': '字段', 'Find': '查找',
	'Find an app or a record…': '查找应用或记录…', 'Goal progress': '目标进度', 'Head': '最新', 'Idle': '空闲', 'Inbox': '收件箱', 'Input': '输入',
	'Integrations': '集成', 'Invitations': '邀请', 'Invite': '邀请',
	'Invite people by email. External members can never be administrators.': '通过邮件邀请成员。外部成员不能成为管理员。',
	'Issue key': '签发密钥', 'Key name': '密钥名称', 'Keys for programmatic access. A new key is shown once.': '用于程序访问的密钥。新密钥仅显示一次。',
	'Last day': '最近一天', 'Last seen': '最后活动', 'Latest': '最新',
	'Live': '线上', 'Loading…': '加载中…', 'Locale': '语言区域', 'Logs': '日志', 'Manifest': '清单', 'Mark all read': '全部标为已读', 'Member': '成员', 'Members': '成员',
	'Message': '消息', 'Model': '模型', 'Move up': '上移', 'Name': '名称', 'New conversation': '新对话', 'New file': '新文件', 'New file path': '新文件路径',
	'No build output.': '无构建输出。', 'No conversations yet.': '暂无对话。', 'No identity changes yet.': '暂无身份变更。', 'No notices.': '暂无通知。',
	'No parent': '无上级', 'No policies assigned yet.': '尚未分配策略。', 'No preview yet.': '暂无预览。', 'No recorded commits.': '暂无提交记录。',
	'No runs yet.': '暂无运行记录。', 'No team': '无团队', 'No teams yet.': '暂无团队。', 'None declared.': '未声明。', 'Norbius': 'Norbius',
	'Not found or no access': '未找到或无权访问', 'Nothing found.': '未找到任何结果。', 'Nothing waits on you.': '没有待您处理的事项。', 'Notices': '通知',
	'Notices arrive on this device.': '通知将发送到此设备。', 'Notifications are blocked here.': '此处已阻止通知。', 'Notify me on this device': '在此设备上通知我',
	'Open': '打开', 'Open a file to edit it.': '打开文件以编辑。', 'Open navigation': '打开导航', 'Operations': '运营', 'Organization': '组织',
	'Pause': '暂停', 'Pending': '待处理', 'People': '人员', 'Plan': '计划', 'Plan first; you approve before it acts': '先制定计划；执行前需您批准',
	'Policies granted to a member, a team or an API key.': '授予成员、团队或 API 密钥的策略。', 'Policy': '策略', 'Preview': '预览', 'Preview as': '预览身份',
	'Output': '输出', 'Previewing as a team. Its grants apply; you are recorded as the previewer.': '正在以团队身份预览。适用该团队的权限；系统记录您为预览者。',
	'Previewing as another member. Their grants apply; you are recorded as the previewer.': '正在以其他成员身份预览。适用其权限；系统记录您为预览者。',
	'Progress': '进度', 'Publish': '发布', 'Queued': '排队中', 'Reason': '原因', 'Reject': '驳回', 'Reload': '重新加载', 'Remove': '移除',
	'Rename': '重命名', 'Request changes': '要求修改', 'Resend': '重新发送',
	'Respond now': '立即回复', 'Restore': '恢复', 'Restore live to this commit? The workbench keeps its source.': '将线上版本恢复到此提交？工作台保留其源代码。',
	'Result': '结果', 'Results': '结果', 'Resume': '继续', 'Revise': '修改', 'Revise plan': '修改计划',
	'Revising a message: sending supersedes it.': '正在修改消息：发送后将替代原消息。', 'Revoke': '撤销', 'Rotate': '轮换', 'Runs': '运行记录',
	'Save': '保存', 'Search teams': '搜索团队', 'Searching…': '搜索中…', 'See the workspace as this member sees it': '以此成员的视角查看工作区',
	'Send': '发送', 'Set': '设置', 'Set by the workspace source.': '由工作区源代码设定。', 'Settings': '设置', 'Sign in': '登录', 'Sign out': '退出登录',
	'Status': '状态', 'Stop': '停止', 'Stopped. Resume the stopped work, or send a follow-up.': '已停止。可继续已停止的工作，或发送后续消息。',
	'Sub-agent': '子智能体', 'Summarize the conversation into a checkpoint': '将对话总结为检查点', 'Supersede': '替代', 'Switch language': '切换语言',
	'System': '系统', 'Sites': '站点', 'Team': '团队', 'Team hierarchy': '团队层级', 'Team name': '团队名称', 'Teams': '团队',
	'Teams group members; a team inherits the grants of its parent.': '团队用于对成员分组；团队继承其上级团队的权限。',
	'The envoy answers on the channel.': '由代理在该渠道上回复。', 'A channel conversation, answered by its envoy. Read-only here.': '渠道对话，由代理回复。此处只读。',
	'The outcome is unknown; refresh to see it.': '结果未知；请刷新查看。',
	'The page {page} could not be loaded:': '页面 {page} 无法加载：', 'The request failed.': '请求失败。', 'The workbench has not built yet.': '工作台尚未构建。',
	'The workbench matches live.': '工作台与线上版本一致。', 'The workspace declares no channels.': '工作区未声明任何渠道。',
	'The workspace declares no integrations.': '工作区未声明任何集成。', 'The workspace declares no secrets.': '工作区未声明任何密钥。',
	'Thinking…': '思考中…', 'This invitation is accepted.': '此邀请已被接受。', 'This invitation is expired.': '此邀请已过期。',
	'This invitation is revoked.': '此邀请已被撤销。', 'This request is no longer pending.': '此请求已不再待处理。',
	'This workspace was updated. Reload to continue with the new version.': '此工作区已更新。请重新加载以使用新版本。', 'Time zone': '时区',
	'Tokens': '令牌', 'Unknown sender': '未知发送者', 'Unread': '未读', 'What {who} holds': '{who} 拥有的权限', 'When': '时间',
	'Who': '操作者', 'Withdraw': '撤回', 'Workbench': '工作台', 'My draft': '我的草稿', 'artifact': '构件', 'Workbench preview': '工作台预览', 'Working…': '处理中…', 'Earlier': '较早', 'Earlier messages': '较早的消息', 'outside what the assistant now reads': '助手当前读取范围之外', 'You': '你', 'Assistant': '助手', 'Reasoning': '推理', 'Interrupted': '已中断', 'Merge request title': '合并请求标题', 'Discard unsaved drafts and switch?': '放弃未保存的草稿并切换？', 'Target': '目标', 'behind live': '落后于正式版', 'Rebase': '变基', 'Open merge request': '发起合并请求', 'Review': '审查', 'Resolve the conflict markers in': '请解决以下文件中的冲突标记：', 'Preview on live data': '用正式数据预览', 'Exit preview': '退出预览', 'stale: built from': '已过时：构建自', 'expires': '到期', 'Baseline': '基线', 'checkpoint': '检查点', 'in review': '审查中', 'No merge requests.': '没有合并请求。', 'by': '由', 'Ready for review': '可供审查', 'What should change?': '需要修改什么？', 'Why reject it?': '为何拒绝？', 'Close this merge request?': '关闭此合并请求？', 'Close': '关闭', 'Merge': '合并', 'on an earlier commit': '基于较早的提交', 'Destructive schema steps an approval accepts:': '批准将接受以下破坏性结构变更：', 'Comment': '评论', 'Merge requests': '合并请求', 'Workspace': '工作区', 'Warnings': '警告', 'Diagnosis': '诊断', 'Diagnose': '诊断', 'Runtime log': '运行日志',
	'Workspace Studio': '工作区工作室', 'Workspace navigation': '工作区导航', 'You are invited to this workspace as': '您受邀以以下身份加入此工作区：',
	'Secure access': '安全访问', 'Switch to light mode': '切换到浅色模式', 'Switch to dark mode': '切换到深色模式', 'Signing in to': '正在登录',
	'Email address': '邮箱地址', 'Send sign-in code': '发送登录验证码', "We'll email you a six-digit code. No password required.": '我们会寄出六位数验证码。无需密码。',
	'Enter your code': '输入验证码', 'Sent to {email}': '已发送至 {email}', 'Six-digit code': '六位验证码', 'Verify and continue': '验证并继续',
	'The code expires in ten minutes.': '验证码十分钟内有效。', 'Change email': '更换邮箱',
	'Mobile number': '手机号码', 'Telegram': 'Telegram', 'Sign in or sign up': '登录或注册', 'Use email instead': '改用邮箱', 'Use a mobile number instead': '改用手机号码',
	'Change number': '更换号码', 'Text me': '短信发送', 'WhatsApp me': '通过 WhatsApp 发送',
	"We'll send a six-digit code by text or WhatsApp. No password required.": '我们会通过短信或 WhatsApp 发送六位数验证码。无需密码。',
	"We'll send a six-digit code by text or WhatsApp. New here? The same code creates your account.": '我们会通过短信或 WhatsApp 发送六位数验证码。新用户？同一验证码即可创建账户。',
	"We'll email you a six-digit code. New here? The same code creates your account.": '我们会寄出六位数验证码。新用户？同一验证码即可创建账户。',
	'Invite people by email or mobile number. External members can never be administrators.': '通过邮箱或手机号码邀请成员。外部成员不能成为管理员。',
	'Sign-up': '注册', 'Newcomers may sign up': '允许新用户自行注册',
	'This workspace lets people join by proving their address. Close sign-up to admit only invited members.': '此工作区允许用户验证地址后自行加入。关闭注册后仅受邀成员可加入。',
	'Change workspace': '切换工作区', 'Branding': '品牌', 'The name and logo every member sees.': '所有成员看到的名称和标志。', 'Workspace name': '工作区名称',
	'Logo': '标志', 'Remove logo': '移除标志', 'The logo must be a PNG, SVG, WebP or JPEG image of at most 256 KiB.': '标志必须是不超过 256 KiB 的 PNG、SVG、WebP 或 JPEG 图片。',
	'Apps': '应用', 'Policies': '策略', 'Envoys': '代理', 'Remotes': '远程仓库', 'Environment': '环境', 'Pipelines': '管道',
	'No environment is routed.': '没有已路由的环境。', 'The manifest is older than the source. Preview to rebuild it.': '清单比源代码旧。请预览以重新构建。', 'unrouted': '未路由', 'steps': '步骤',
	'accepted': '已接受', 'active': '活跃', 'assignment': '权限分配', 'context': '上下文', 'create': '创建', 'delete': '删除', 'done': '完成',
	'draft': '草稿', 'earlier messages are summarized here': '较早的消息已在此汇总', 'expired': '已过期', 'external': '外部', 'failed': '失败', 'host': '主机', 'in': '输入', 'invitation': '邀请', 'live': '线上',
	'member': '成员', 'members': '成员', 'next': '下次', 'no auth': '无认证', 'Not for the assistant': '不交给助手', 'open': '待接受', 'out': '输出',
	'paused': '已暂停', 'queued': '排队中', 'responding': '回复中', 'retrying': '重试中', 'revoked': '已撤销', 'running': '运行中', 'sent': '已发送',
	'set': '已设置', 'skipped': '已跳过', 'step': '步骤', 'stopped': '已停止', 'succeeded': '成功', 'team': '团队', 'unknown': '未知', 'unsaved': '未保存',
	'unset': '未设置', 'update': '更新', 'verified': '已验证', 'waiting for more…': '等待更多内容…', 'working': '处理中',
	// delivery status (§5.9): the channel sheet's Messages tab
	'Delivery': '投递', 'sending': '发送中', 'deferred': '已延迟', 'delivered': '已送达', 'read': '已读', 'opened': '已打开', 'bounced': '已退回',
	'complained': '被标为垃圾邮件', 'auto-replied': '自动回复', 'replied': '已回复', 'uncertain': '不确定', 'presumed': '推定', 'approximate': '近似',
	// the chrome restored from staging: sidebar, account menu, notifications, launcher
	'Collapse sidebar': '收起侧边栏', 'Expand sidebar': '展开侧边栏', 'Toggle sidebar': '切换侧边栏', 'Account': '账户', 'More': '更多',
	'Open account menu': '打开账户菜单', 'Switch workspace': '切换工作区', 'Role: {role}': '角色：{role}', 'Language': '语言', 'Appearance': '外观',
	'Light': '浅色', 'Dark': '深色', 'Preview as a team': '以团队身份预览', 'Choose a team': '选择团队', 'Notifications': '通知',
	'{count} unread notifications': '{count} 条未读通知', 'Nothing here yet': '暂无内容', 'Workspace overview': '工作区概览',
	'Pick an application': '选择一个应用', 'No applications yet': '暂无应用', 'Add an application to this workspace to see it here.': '向此工作区添加应用后，它会显示在这里。',
	'Connected': '已连接', 'Reconnecting': '重新连接中', 'Connection closed': '连接已关闭', 'Pages': '页面',
	// system collections in ui's Table (runs, approvals, notices, people, teams, keys, channels, integrations, secrets)
	'Action': '操作', 'Actions': '操作', 'Add a member': '添加成员', 'Address': '地址', 'Assign a policy': '分配策略', 'Collection': '数据集', 'Record': '记录',
	'Collection integrations, connections and MCP servers the workspace declares.': '工作区声明的数据集集成、连接与 MCP 服务器。',
	'Connection': '连接', 'Created': '创建时间', 'Detail': '详情',
	'Every automation run, newest first. Stop a queued or running run; retry a failed one.': '所有自动化运行记录，最新在前。可停止排队中或运行中的运行；可重试失败的运行。',
	'Expires': '到期时间', 'Grants': '权限', 'Identity changes, newest first.': '身份变更，最新在前。', 'Integration': '集成', 'Key': '密钥', 'Kind': '类型',
	'Last used': '最后使用', 'New value': '新值', 'No API keys yet.': '暂无 API 密钥。', 'No members': '暂无成员', 'No teams match this search.': '没有匹配此搜索的团队。',
	'No unread notices.': '没有未读通知。', 'No': '否', 'Nobody is in this team yet.': '此团队暂无成员。',
	'Outbound deliveries over the last day; an automatic retry is progress, only a settled failure is terminal.': '最近一天的外发投递；自动重试属于进行中，只有最终失败才算终止。',
	'Parent team': '上级团队', 'Read': '已读', 'Requested by': '申请人', 'Retry': '重试', 'Revoke the key {name}? Programs using it stop at once.': '撤销密钥 {name}？使用它的程序将立即停止。',
	'Scope': '范围', 'Started': '开始时间', 'Step': '步骤', 'Title': '标题', 'Transport': '传输方式', 'Values are write-only: open a secret to set it.': '值只可写入：打开密钥以设置。',
	'Variable': '变量', 'Yes': '是', 'Staff': '员工', 'Sent': '已发送', 'Retrying': '重试中', 'Failed': '失败', 'Skipped': '已跳过', 'Next retry': '下次重试', 'Channel': '渠道',
	// Workspace Studio restored from staging: rails, toolbar, review, diagnosis, live and the runtime log
	'Workspace navigator': '工作区导航器', 'Open the navigator': '打开导航器', 'Browse': '浏览', 'changed files': '个文件已变更', 'Serving now': '正在提供服务',
	'Edit safely, preview the exact result, then ask for review.': '安全编辑、预览准确结果，然后请求审核。', 'Preview on sample data': '用示例数据预览',
	'Rebuild preview': '重新构建预览', 'on live data': '使用正式数据', 'on sample data': '使用示例数据', 'against Live': '对比线上版本', 'against MR head': '对比合并请求最新提交',
	'Current': '最新', 'Live moved on': '线上已更新', 'Closed': '已关闭', 'Author': '作者', 'Reviewer': '审查者', 'Build details': '构建详情',
	'No diagnosis yet. Run one to check this source.': '尚无诊断。运行诊断以检查此源代码。', 'These findings cover an earlier version.': '这些结果针对的是较早的版本。',
	'No diagnosis errors.': '诊断无错误。', 'Run diagnosis': '运行诊断', 'Warning': '警告', 'The runtime log is an administrator’s.': '运行日志仅限管理员查看。',
	'Environments': '环境', 'This commit is already live.': '此提交已在线上。', 'This commit has no restore point.': '此提交没有还原点。', 'Source': '源代码',
	'Files': '文件', 'Switch to this merge request to see its files.': '切换到此合并请求以查看其文件。',
	'against the Live commit this change sits on': '对比此变更所基于的线上提交', 'Before': '修改前', 'After': '修改后', 'No comments yet.': '暂无评论。',
	'Leave a comment': '发表评论', 'Decision': '决定', 'Live moved on. Rebase before review.': '线上已更新。请先变基再审查。', 'Waiting for a reviewer.': '等待审查者。',
	'base': '基准', 'Rejected': '已驳回', 'Changes requested': '已要求修改', 'Draft': '草稿', 'Merged': '已合并', 'Level': '级别', 'All': '全部',
	'Filter the log': '筛选日志', 'Filter by event or attribute': '按事件或属性筛选', 'No runtime records.': '暂无运行记录。', 'Load older': '加载更早记录',
	'Following': '跟随中', 'Follow': '跟随', 'File path': '文件路径', 'No source files': '没有源文件', 'Filter source files': '筛选源文件', 'Filter': '筛选',
	'No matches.': '无匹配项。', 'Action failed': '操作失败', 'Action required': '需要处理', 'Updated': '已更新', 'Update from Live': '从线上更新',
	// the agent panel (staging's copy)
	'No conversations yet': '暂无对话', 'Start a conversation. Ask for help or switch to Plan to work through an approach.': '开始对话。寻求帮助，或切换到“计划”梳理思路。',
	'Ask anything, or type /plan, /compact or /export': '可直接提问，或输入 /plan、/compact、/export', 'Attach media or files': '附加媒体或文件',
	'Jump to latest': '跳到最新', 'Summarize this conversation and keep its transcript available.': '总结此对话，并保留其完整记录。', 'Cost': '费用',
	'Switch between Agent and Plan (Tab)': '在智能体与计划之间切换（Tab）', 'Queue message': '加入队列',
	'Worked for': '已处理', 'Thought': '思考', 'Copy': '复制', 'Copied': '已复制', 'Conversation transcript': '对话记录',
	'Planning': '规划中', 'Executing': '执行中', 'Verified': '已验证', 'Compaction': '压缩', 'Prior transcript': '先前的记录', 'In progress': '进行中', 'Goal steps': '目标步骤',
	'About this context': '关于此上下文', 'Summary': '摘要', 'Transcript': '记录', 'Draft plan': '计划草稿', 'Revision': '修订',
	'Web UI': '网页端', 'Group': '群组', 'reply pending': '待回复', 'Answer': '回答', 'Verdict': '判定', 'Wait': '等待', 'Context': '上下文',
	'respond': '回复', 'wait': '等待', 'ignore': '忽略', 'decided': '已决定',
	'Every message in and out of this channel, newest first.': '此渠道收发的每条消息，最新的在前。', 'No messages on this channel yet.': '此渠道暂无消息。',
	'Refresh': '刷新', 'Older': '更早', 'Messages': '消息', 'file': '个文件', 'files': '个文件',
	'Delete plan and return to Agent mode': '删除计划并返回智能体模式', 'Starting…': '正在启动…', 'Execute': '执行',
	'Discuss the approach here. Expand the draft Plan above the prompt to review it.': '在此讨论思路。展开输入框上方的计划草稿即可查看。',
	'The agent continues from this plan and the messages below. Earlier messages are saved in Transcript.': '智能体将基于此计划及下方消息继续。较早的消息保存在“记录”中。',
	'The agent continues from this summary and the messages below. Earlier messages are saved in Transcript.': '智能体将基于此摘要及下方消息继续。较早的消息保存在“记录”中。',
	'Delete this plan?': '删除此计划？', 'Stop this response?': '停止此回复？', 'The agent stops working from it. Conversation history stays available.': '智能体将不再依据此计划工作。对话历史仍可查看。',
	'The current response will stop. Completed work is kept; queued messages are cancelled.': '当前回复将停止。已完成的工作会保留；排队中的消息将被取消。',
	'Keep plan': '保留计划', 'Keep working': '继续运行', 'Stop response': '停止回复',
	'you asked for it': '由你发起', 'the assistant asked for it': '由助手发起', 'the context was full': '上下文已满',
};

/** The framework copy of a locale (none for English: the key is the text). */
export const frameworkText = (locale: string): { readonly [key: string]: string } => locale.startsWith('zh') ? SHELL_ZH : {};
/** ui's chrome in a locale, for `setUiText` (English is ui's own default). */
export const uiTextFor = (locale: string): Partial<{ [k in UiTextKey]: string }> => locale.startsWith('zh') ? UI_ZH : {};
