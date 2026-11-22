/**
 * Whole-page looks that work on any site: plain CSS, applied as one undoable page preview.
 * Each is a way of seeing the page, and none of them touches its content or its source.
 */
export interface PageRemix {
  id: string;
  label: string;
  /** What the look is for, shown beside its name. */
  hint: string;
  css: string;
}

const media = 'img,video,picture,canvas,svg,iframe,embed,object';

export const PAGE_REMIXES: PageRemix[] = [
  {
    id: 'night',
    label: '夜间',
    hint: '整页反相，图片与视频保持原色',
    // Inverting the root and then the media again leaves pictures as they were.
    css: `html{background:#fff!important;filter:invert(1) hue-rotate(180deg)!important}
${media},[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}
svg ${media}{filter:none!important}`,
  },
  {
    id: 'editorial',
    label: '杂志',
    hint: '衬线字体、暖纸底色与更宽松的行距',
    css: `html,body{background:#f6f1e7!important;color:#1f1b16!important}
body,p,li,dd,blockquote,td,th,label,input,textarea,button{font-family:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif!important}
p,li,dd,blockquote{line-height:1.9!important;letter-spacing:.01em!important}
h1,h2,h3,h4{font-family:"Songti SC","Noto Serif SC",Georgia,serif!important;font-weight:900!important;letter-spacing:-.012em!important;color:#14110d!important}
a{color:#8a3b12!important;text-decoration-thickness:1px!important;text-underline-offset:3px!important}
hr{border-color:#d9cfbd!important}`,
  },
  {
    id: 'blueprint',
    label: '线框',
    hint: '去掉颜色和图片，只看结构与层级',
    css: `html,body{background:#fff!important}
*,*::before,*::after{background-color:transparent!important;background-image:none!important;color:#111!important;border-color:#111!important;box-shadow:none!important;text-shadow:none!important;border-radius:0!important;font-family:ui-monospace,"SF Mono",Menlo,monospace!important}
body *{outline:1px solid rgb(17 17 17 / 16%)!important;outline-offset:-1px!important}
${media}{opacity:.1!important;outline:1px dashed #111!important}
a{text-decoration:underline!important}`,
  },
  {
    id: 'focus',
    label: '专注',
    hint: '收起导航、侧栏与页脚，正文居中放大',
    css: `nav,aside,footer,[role="navigation"],[role="complementary"],[role="contentinfo"],[class*="sidebar" i],[id*="sidebar" i],[class*="advert" i],[class*="cookie" i],[class*="popup" i],[class*="newsletter" i]{display:none!important}
main,article,[role="main"]{max-width:760px!important;margin-inline:auto!important;float:none!important}
main p,article p,[role="main"] p,main li,article li{font-size:18px!important;line-height:1.85!important}`,
  },
];
