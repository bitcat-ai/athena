export interface WebTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface WebToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, any>;
  isError?: boolean;
}
export interface WebPage {
  pageId: number;
  targetId: string;
  tabId: number;
  windowId: number;
  groupId?: string;
  title: string;
  url: string;
  isActive: boolean;
}
export interface WebFile {
  path: string;
  name: string;
  size: number;
}

const page = { type: 'integer', minimum: 1, description: '页面编号，来自 tabs。' };
const text = { type: ['string', 'null'] };
const flag = { type: ['boolean', 'null'] };
const number = { type: ['number', 'null'] };
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = ['page'],
): WebTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

export const TAB_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];
export const ACT_KINDS = [
  'click',
  'click_at',
  'type',
  'type_at',
  'fill',
  'press',
  'hover',
  'hover_at',
  'focus',
  'check',
  'uncheck',
  'select',
  'scroll',
  'drag',
  'drag_at',
  'dialog_accept',
  'dialog_dismiss',
];

/** The script surface documented to the model; web-script.ts implements exactly this. */
const SCRIPT_GUIDE = `在隔离环境里运行一段 async JavaScript，用一次调用完成多步网页操作。脚本只有这些全局：browser、console、setTimeout、clearTimeout、sleep(ms)；没有 fetch、require、process、window、document。用 return 返回结果，console.log 的输出会一并返回，异常会作为结果返回。
browser.open(url) → 页面句柄；browser.page(id) → 已有页面的句柄；browser.pages.list() → [{pageId,url,title,isActive}]；browser.tabGroups(opts) 与 tab_groups 工具同参。
页面句柄：id、info()、goto(url) → {status} 或 {download:true}、back()/forward() → {navigated}、reload()、snapshot({mode,depth}) → {text,refs,url}、diff() → {text,added,removed,changed}、read(selector?) → markdown、grep(pattern,{over,limit}) → 文本、click(ref)、fill(ref,value)、hover(ref)、selectOption(ref,value)、check(ref)、uncheck(ref)、focus(ref)、drag(fromRef,toRef)、type(text)、press(key)、insertText(text)、scroll(direction,amount,ref?)、clickAt(x,y)、typeAt(x,y,text)、hoverAt(x,y)、dragAt(x1,y1,x2,y2)、dialogAccept(text?)、dialogDismiss()、waitForSelector(sel,{timeout})/waitForText(text,{timeout})/waitForTime(ms) → {matched}、evaluateInPage(fn,arg?) → {value,changed}、screenshot(opts) → {mimeType,width,height,data}、pdf(opts) → {path,name,size}、download(ref) → {path,name,size}、upload(ref,files)/upload(null,files)/upload(files)、close()。
打开弹窗的动作返回 {dialogOpen:true,kind,message}；打开文件选择的点击返回 {fileChooserOpen:true,multiple}。元素引用来自 snapshot，页面变化后要重新 snapshot。`;

export const webTools: WebTool[] = [
  tool(
    'tabs',
    '列出页面（list）、查看当前页（active）、新建页面（new，返回稳定后的快照）或关闭页面（close）。',
    {
      action: { enum: ['list', 'active', 'new', 'close'] },
      groupId: { ...text, description: 'new 时加入的分组。' },
      page: { type: ['integer', 'null'], minimum: 0, description: 'close 的页面编号。' },
      url: { ...text, description: 'new 时打开的地址，默认 about:blank。' },
    },
    [],
  ),
  tool(
    'tab_groups',
    '管理页面分组：list、create（pages 建组，带 groupId 时加入已有分组）、update（改标题、颜色、折叠）、ungroup（把 pages 移出分组）、close（关闭分组内所有页面）。',
    {
      action: { enum: ['list', 'create', 'update', 'ungroup', 'close'] },
      collapsed: flag,
      color: { enum: [...TAB_GROUP_COLORS, null] },
      groupId: text,
      pages: { type: ['array', 'null'], items: { type: 'integer', minimum: 1 } },
      title: text,
    },
    [],
  ),
  tool(
    'navigate',
    '让页面打开地址（url）、后退（back）、前进（forward）或刷新（reload），返回稳定后的新快照。无法打开的地址是错误；HTTP 错误状态会注明；文件地址会直接下载且页面不变；没有历史记录时会说明。',
    {
      page,
      action: { enum: ['url', 'back', 'forward', 'reload'] },
      url: { ...text, description: 'action 为 url 时必填。' },
    },
  ),
  tool(
    'snapshot',
    '读取页面的可访问性快照，带可用于 act 的元素引用 [ref=…]；iframe 内容内联展示。页面跳转或引用失效后重新读取。',
    {
      page,
      depth: { ...number, description: '只保留前几层，1–100。' },
      mode: { enum: ['full', 'interactive', null], description: '默认 full。' },
    },
  ),
  tool('diff', '返回页面自上次 snapshot 或 diff 以来发生的变化。', { page }),
  tool(
    'act',
    '在页面上执行一个动作并返回页面变化。元素类动作用快照里的 ref；*_at 用视口内的 CSS 坐标。fill 可用 fields 一次填写整张表，并回读每个字段。type 向当前焦点输入 text。打开弹窗的动作会报告弹窗，用 dialog_accept / dialog_dismiss 处理。',
    {
      page,
      kind: { enum: ACT_KINDS },
      amount: { ...number, description: 'scroll 的滚轮格数，默认 3。' },
      button: { enum: ['left', 'middle', 'right', null] },
      clear: { ...flag, description: 'fill 默认 true（false 为追加）；type_at 默认 false。' },
      clickCount: { type: ['integer', 'null'], minimum: 1, maximum: 3 },
      diff: {
        type: ['string', 'number', 'null'],
        description: '变化的返回方式：none、summary、full（默认），或限制字符数的数字。',
      },
      direction: { enum: ['up', 'down', 'left', 'right', null] },
      endX: number,
      endY: number,
      fields: {
        type: ['array', 'null'],
        maxItems: 50,
        items: {
          type: 'object',
          properties: { ref: { type: 'string' }, value: { type: 'string' } },
          required: ['ref', 'value'],
          additionalProperties: false,
        },
      },
      key: { ...text, description: 'press 的按键，如 Enter、Control+a。' },
      ref: text,
      sensitive: { ...flag, description: '为 true 时不回显也不记录输入值。' },
      startX: number,
      startY: number,
      targetRef: { ...text, description: 'drag 的目标元素。' },
      text: { ...text, description: 'type / type_at 输入的文字；dialog_accept 的 prompt 回答。' },
      value: { ...text, description: 'fill / select 的值。' },
      x: number,
      y: number,
    },
    ['page', 'kind'],
  ),
  tool(
    'download',
    '点击会触发下载的元素并等待文件落盘，返回文件路径、名称和大小。',
    { page, ref: { type: 'string' } },
    ['page', 'ref'],
  ),
  tool(
    'upload',
    '把本机文件交给页面的文件输入框（ref）或页面已打开的文件选择（省略 ref）。files 为空数组时清空已选文件。',
    {
      page,
      file: text,
      files: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 20 },
      ref: text,
    },
  ),
  tool(
    'read',
    '读取页面内容：markdown（默认）、text、links，或 console（页面控制台与异常）。可用 selector 限定范围。',
    {
      page,
      format: { enum: ['markdown', 'text', 'links', 'console', null] },
      includeImages: flag,
      includeLinks: flag,
      selector: text,
      viewportOnly: flag,
    },
  ),
  tool(
    'grep',
    '用不区分大小写的正则在页面里查找。over 为 ax（默认）时搜索可访问性快照，匹配行保留 [ref=…]；为 content 时搜索页面正文。',
    {
      page,
      pattern: { type: 'string', maxLength: 500 },
      limit: { ...number, description: '最多返回的行数，默认 50。' },
      over: { enum: ['ax', 'content', null] },
    },
    ['page', 'pattern'],
  ),
  tool(
    'screenshot',
    '截取页面图片，敏感输入框会被遮盖。默认 JPEG、视口范围。annotate 会给可交互元素标号并返回编号与 ref 的对应表。',
    {
      page,
      annotate: flag,
      format: { enum: ['jpeg', 'png', 'webp', null] },
      fullPage: flag,
      quality: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
      scale: { enum: ['css', 'device', null] },
      size: {
        type: ['object', 'null'],
        properties: {
          width: { type: 'integer', minimum: 1, maximum: 4096 },
          height: { type: 'integer', minimum: 1, maximum: 4096 },
        },
        additionalProperties: false,
      },
    },
  ),
  tool('pdf', '把页面保存为 PDF，返回文件路径、名称和大小。', {
    page,
    background: flag,
    landscape: flag,
    preferCSSPageSize: flag,
    printBackground: flag,
  }),
  tool(
    'wait',
    '等待文字出现（text）、选择器匹配（selector）或固定时间（time，默认）。返回 { matched }，超时不报错；未匹配不能当作完成。',
    {
      page,
      for: { enum: ['text', 'selector', 'time', null] },
      timeout: { ...number, description: 'text / selector 的上限，默认 10000，最大 30000 毫秒。' },
      value: {
        type: ['string', 'number', 'null'],
        description: '要等待的文字或选择器；time 时为毫秒数，默认 2000，最大 90000。',
      },
    },
  ),
  tool(
    'evaluate_in_page',
    '在页面自身的 JavaScript 环境里执行代码并返回可序列化的结果。code 是带 return 的 async 函数体，func 是函数表达式，二选一。改动了页面的脚本会等页面稳定后返回，并标明 changed。',
    {
      page,
      code: text,
      func: text,
      maxChars: { ...number, description: '结果上限（UTF-8 字节），默认 5000，最大 200000。' },
      settle: flag,
      timeout: { ...number, description: '最大 30000 毫秒。' },
    },
  ),
  tool(
    'run',
    SCRIPT_GUIDE,
    {
      code: { type: 'string', maxLength: 200_000 },
      maxChars: { ...number, description: '输出上限，默认 25000，最大 2000000。' },
      timeout: { ...number, description: '默认且最大 30000 毫秒。' },
    },
    ['code'],
  ),
  tool(
    'request_human_help',
    '遇到登录、验证码、需要本人确认等自己不能完成的步骤时，请用户在可见页面上处理，处理完后继续。',
    {
      page,
      reason: { type: 'string', maxLength: 500 },
      details: text,
      kind: { enum: ['login', 'captcha', 'approval', 'other', null] },
      resumeHint: text,
    },
    ['page', 'reason'],
  ),
  tool(
    'await_human_help',
    '查询人工协助请求的状态：resolved、cancelled、timed_out 或 waiting。',
    { requestId: text },
    [],
  ),
];
