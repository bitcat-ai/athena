/**
 * Guiding for the page bridge: the agent points, the user acts. One step at a time the page shows
 * where to look, what to click or what to fill in, next to the element itself, and reports back
 * when the user has done it. The agent's cursor only points; every click and keystroke is the
 * user's own.
 *
 * Nothing the user types is read here. A step reports that it was passed, how, and whether a
 * field ended up filled, never the content.
 */
export const browserGuideCss = [
  '.gd{position:absolute;inset:0;overflow:hidden;pointer-events:none;font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;color:#16181d}',
  '.gd-ring{position:absolute;left:0;top:0;box-sizing:border-box;display:none;border:2px solid #7e8dfa;border-radius:10px;box-shadow:0 0 0 4px #7e8dfa33,0 0 0 200vmax #0f121e47}',
  '.gd[data-at=target] .gd-ring{display:block}.gd[data-action=click] .gd-ring{animation:gd-pulse 1.6s ease-in-out infinite}',
  '.gd-cur{position:absolute;left:0;top:0;width:0;height:0;display:none}.gd[data-at=target] .gd-cur{display:block}',
  '.gd-cur svg{position:absolute;left:-1px;top:-1px;width:18px;height:24px;overflow:visible;filter:drop-shadow(0 1px 2px #151b3466)}',
  '.gd.glide .gd-ring{transition:left .32s cubic-bezier(.3,.7,.2,1),top .32s cubic-bezier(.3,.7,.2,1),width .32s cubic-bezier(.3,.7,.2,1),height .32s cubic-bezier(.3,.7,.2,1)}',
  '.gd.glide .gd-cur{transition:transform .42s cubic-bezier(.3,.7,.2,1)}.gd.glide .gd-card{transition:transform .32s cubic-bezier(.3,.7,.2,1)}',
  '.gd-card{position:absolute;left:0;top:0;box-sizing:border-box;width:min(340px,calc(100vw - 24px));padding:14px 14px 12px;background:#fff;border-radius:16px;box-shadow:0 12px 36px #0f121e2e,0 0 0 1px #0f121e14;pointer-events:auto;user-select:none;-webkit-user-select:none;cursor:default}',
  '.gd-head{display:flex;align-items:center;gap:6px;margin:0 0 6px;font-size:12px;line-height:18px;color:#6b7080;white-space:nowrap}',
  '.gd-head b{font-weight:600;color:#7e8dfa}.gd-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}.gd-count{font-style:normal;font-variant-numeric:tabular-nums}',
  '.gd-note{margin:0;font-size:14px;line-height:21px;color:#16181d;overflow-wrap:anywhere;white-space:pre-line}',
  '.gd[data-practice] .gd-note{max-height:36vh;overflow:auto}',
  '.gd-hint{margin:4px 0 0;font-size:12px;line-height:18px;color:#6b7080}.gd-hint:empty{display:none}',
  '.gd-row{display:flex;flex-wrap:nowrap;align-items:center;gap:6px;margin:12px 0 0}.gd-gap{flex:1}',
  '.gd-row button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border-radius:15px;background:#f1f2f5;color:#16181d;font:500 12px/1 system-ui,-apple-system,"PingFang SC",sans-serif;white-space:nowrap;cursor:pointer}',
  '.gd-row button:hover{background:#e6e8ed}.gd-row button[hidden]{display:none}',
  '.gd-row button.gd-quiet{background:none;color:#6b7080;padding:0 8px}.gd-row button.gd-quiet:hover{background:#f1f2f5}',
  '.gd-row button.gd-main{background:#16181d;color:#fff}.gd-row button.gd-main:hover{background:#2b2e36}',
  '.gd[data-busy] .gd-card{opacity:.6}.gd[data-busy] .gd-row{pointer-events:none}',
  '.gd[data-bye] .gd-title,.gd[data-bye] .gd-count,.gd[data-bye] .gd-hint,.gd[data-bye] .gd-row{display:none}.gd[data-bye] .gd-card{width:auto;max-width:min(340px,calc(100vw - 24px))}',
  '@keyframes gd-pulse{0%,100%{box-shadow:0 0 0 3px #7e8dfa40,0 0 0 200vmax #0f121e47}50%{box-shadow:0 0 0 9px #7e8dfa1f,0 0 0 200vmax #0f121e47}}',
  '@media(prefers-reduced-motion:reduce){.gd-ring{animation:none!important}.gd.glide .gd-ring,.gd.glide .gd-cur,.gd.glide .gd-card{transition:none}}',
].join('\n');

// Plain JavaScript for the isolated world, like the bridge that embeds it.
export const browserGuideSource = String.raw`
  function createGuide(env) {
    const swallowed=['pointerdown','mousedown','pointerup','mouseup','click','dblclick','auxclick','contextmenu','touchstart','touchend'];
    const skipped=/^(html|head|body|script|style|meta|link|noscript|template|title)$/;
    let layer=null, ring, cursor, card, parts={}, state=null, target=null, press=null;
    let frame=0, glideTimer=0, busyTimer=0, byeTimer=0, seekAt=0, placed='', boxed='', pointed='';
    const norm=value=>String(value==null ? '' : value).replace(/\s+/g,' ').trim().toLowerCase();
    const field=el=>/^(input|textarea|select)$/.test(el.localName) || el.isContentEditable;
    const interactive=el=>/^(a|button|input|select|textarea|summary|label|option)$/.test(el.localName) || el.isContentEditable
      || /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|option|checkbox|radio|switch|combobox|textbox|searchbox)$/.test(el.getAttribute('role') || '');
    // What a control is called on screen. Field values are never among them.
    function names(el) {
      const out=[el.getAttribute('aria-label'),el.getAttribute('placeholder'),el.getAttribute('title'),el.getAttribute('alt')];
      if(el.localName==='input' && /^(button|submit|reset)$/.test(el.type)) out.push(el.value);
      if(el.labels) for(const label of el.labels) out.push(label.textContent);
      return out.filter(Boolean).map(norm).filter(Boolean);
    }
    // 2 when a name or the whole text is the wanted text, 1 when it contains it, 0 otherwise.
    function match(el,needle) {
      const hidden=env.sensitive(el), control=field(el), room=needle.length*4+40;
      let best=0;
      if(!hidden || control) for(const name of names(el)) {
        if(name===needle) return 2;
        if(name.includes(needle) && name.length<=room) best=1;
      }
      // Protected content is not matched by what it says, and a field not by what it holds.
      if(hidden || control) return best;
      const raw=el.textContent || '';
      if(raw.length>needle.length*8+400 || !norm(raw).includes(needle)) return best;
      const text=norm(env.safeText(el,room+40));
      if(text===needle) return 2;
      return text.includes(needle) && text.length<=room ? 1 : best;
    }
    function byText(needle,pool) {
      let found=null, top=-1, area=Infinity;
      for(const el of pool) {
        if(skipped.test(el.localName)) continue;
        const hit=match(el,needle);
        if(!hit || !env.visible(el)) continue;
        const rect=el.getBoundingClientRect();
        const inView=rect.bottom>0 && rect.top<innerHeight && rect.right>0 && rect.left<innerWidth;
        const score=hit*4+(interactive(el) ? 2 : 0)+(inView ? 1 : 0), size=rect.width*rect.height;
        if(score>top || (score===top && size<area)) {found=el;top=score;area=size;}
      }
      return found;
    }
    function locatePractice(step) {
      const p=step.practice;
      if(location.origin!==p.origin) return {reason:'wrong_origin'};
      if(location.pathname!==p.pathname) return {reason:'wrong_page'};
      if(!step.text && !step.selector) return {none:true};
      const needle=norm(step.text), scan=env.scan();
      if(scan.truncated) return {reason:'ambiguous_target'};
      const candidates=scan.found.filter(el=>{
        if(el.localName!==p.tag || env.sensitive(el)) return false;
        if(needle && match(el,needle)!==2) return false;
        if(!needle && (!step.selector || !el.matches(step.selector))) return false;
        if(!env.visible(el)) return false;
        const row=el.closest('tr,[role=row],li');
        if(!row) return !p.inRow;
        const key=norm(p.object);
        const heading=norm(env.scopeText(el));
        return heading===key || heading.split(/[^\p{L}\p{N}_-]+/u).includes(key);
      });
      if(candidates.length===1) return {el:candidates[0]};
      return {reason:candidates.length ? 'ambiguous_target' : 'not_found'};
    }
    function locate(step) {
      if(step.practice) return locatePractice(step);
      if(step.ref) {
        try { const el=env.resolve(step.ref); return env.visible(el) ? {el} : {reason:'hidden'}; }
        catch { return {reason:'stale_ref'}; }
      }
      const needle=norm(step.text);
      if(step.selector) {
        let list;
        try { list=[...document.querySelectorAll(step.selector)].filter(el=>!env.ours(el)); }
        catch { return {reason:'invalid_selector'}; }
        if(!list.length) return {reason:'not_found'};
        const seen=list.filter(env.visible);
        if(!seen.length) return {reason:'hidden'};
        if(!needle) return {el:seen[0]};
        const el=byText(needle,seen) || seen.find(item=>!env.sensitive(item) && norm(item.textContent).includes(needle));
        return el ? {el} : {reason:'text_not_found'};
      }
      if(needle) {
        const el=byText(needle,env.scan().found);
        return el ? {el} : {reason:'text_not_found'};
      }
      return {none:true};
    }
    // A step that asks for input points at the field itself, not at its label or wrapper.
    function editable(el) {
      if(field(el)) return el;
      if(el.localName==='label' && el.control) return el.control;
      const inner=el.querySelector('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]');
      return inner && env.visible(inner) ? inner : el;
    }
    const aim=(el,action)=>action==='input' ? editable(el) : el;
    function filled(el) {
      if('value' in el) return el.type==='checkbox' || el.type==='radio' ? !!el.checked : String(el.value).length>0;
      return (el.textContent || '').trim().length>0;
    }
    function brief(el) {
      const found=env.describe(el);
      return found ? {tag:found.tag,role:found.role,name:found.name,selector:found.selector} : undefined;
    }
    function make(tag,className,text) {
      const node=document.createElement(tag);
      if(className) node.className=className;
      if(text) node.textContent=text;
      return node;
    }
    function button(name,label,className) {
      const node=make('button',className,label);
      node.type='button';node.tabIndex=-1;node.dataset.do=name;
      return node;
    }
    function build() {
      if(layer) return;
      layer=make('div','gd');ring=make('div','gd-ring');cursor=make('div','gd-cur');card=make('div','gd-card');
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'), path=document.createElementNS('http://www.w3.org/2000/svg','path');
      svg.setAttribute('viewBox','0 0 18 24');svg.setAttribute('aria-hidden','true');
      path.setAttribute('d','M1 1L16 14L9 15L6 22Z');path.setAttribute('fill','#7e8dfa');path.setAttribute('stroke','white');
      path.setAttribute('stroke-width','1.5');path.setAttribute('stroke-linejoin','round');
      svg.appendChild(path);cursor.appendChild(svg);
      const head=make('div','gd-head'), row=make('div','gd-row');
      parts={title:make('span','gd-title'),count:make('i','gd-count'),note:make('p','gd-note'),hint:make('p','gd-hint'),
        back:button('back','上一步'),handover:button('handover','交给 Athena'),next:button('next','下一步','gd-main')};
      head.append(make('b','','Athena'),parts.title,parts.count);
      row.append(button('end','结束','gd-quiet'),make('span','gd-gap'),parts.back,parts.handover,parts.next);
      card.append(head,parts.note,parts.hint,row);
      layer.append(ring,cursor,card);
    }
    function fill() {
      layer.dataset.action=state.action;
      layer.toggleAttribute('data-practice',!!state.practice);
      delete layer.dataset.busy;delete layer.dataset.bye;
      parts.title.textContent=state.title;
      parts.count.textContent=state.total>1 ? (state.index+1)+' / '+state.total : '';
      parts.note.textContent=state.note;
      parts.hint.textContent=state.wanted && !target ? '还没找到这一步的位置，出现后会自动高亮'
        : state.action==='click' ? '点一下高亮的位置，我接着带你'
        : state.action==='input' ? '填好后点“'+(state.index+1>=state.total ? '完成' : '下一步')+'”' : '';
      parts.back.hidden=!state.back;
      parts.handover.hidden=!(state.handover && state.action!=='look');
      parts.next.textContent=state.action==='click' ? '跳过' : state.index+1>=state.total ? '完成' : '下一步';
      parts.next.className=state.action==='click' ? '' : 'gd-main';
    }
    function reveal() {
      const rect=target.getBoundingClientRect();
      if(rect.top>=12 && rect.bottom<=innerHeight-12 && rect.left>=0 && rect.right<=innerWidth) return;
      target.scrollIntoView({block:'center',inline:'nearest',behavior:env.reduced.matches ? 'auto' : 'smooth'});
    }
    // The ring and the cursor travel to a new step, then follow the element without lag.
    function glide() {
      clearTimeout(glideTimer);
      layer.classList.add('glide');
      glideTimer=setTimeout(()=>layer?.classList.remove('glide'),460);
    }
    const clamp=(value,low,high)=>Math.max(low,Math.min(Math.max(low,high),value));
    function paint() {
      frame=0;
      if(!state) return;
      // Clearing the other overlays takes the host element away; the guide moves into the new one.
      const root=env.root();
      if(layer.getRootNode()!==root) root.appendChild(layer);
      if(target && !target.isConnected) {target=null;fill();}
      if(target && state.practice && performance.now()-seekAt>400) {
        seekAt=performance.now();
        if(locate(state).el!==target) {target=null;fill();}
      }
      if(!target && state.wanted && !state.busy && performance.now()-seekAt>300) {
        seekAt=performance.now();
        const hit=locate(state);
        if(hit.el) {target=aim(hit.el,state.action);fill();reveal();glide();}
      }
      const rect=target && !state.busy && env.visible(target) ? target.getBoundingClientRect() : null;
      const at=rect ? 'target' : 'page';
      if(layer.dataset.at!==at) layer.dataset.at=at;
      const width=card.offsetWidth, height=card.offsetHeight;
      let left=(innerWidth-width)/2, top=innerHeight-height-24;
      if(rect) {
        const box='left:'+(rect.left-4)+'px;top:'+(rect.top-4)+'px;width:'+(rect.width+8)+'px;height:'+(rect.height+8)+'px';
        if(boxed!==box) {ring.style.cssText=box;boxed=box;}
        const point='translate('+clamp(rect.left+rect.width*0.7,rect.left+4,rect.right-4)+'px,'+(rect.top+Math.min(24,rect.height*0.5))+'px)';
        if(pointed!==point) {cursor.style.transform=point;pointed=point;}
        const below=rect.bottom+16, above=rect.top-16-height;
        left=rect.left+rect.width/2-width/2;
        if(below+height<=innerHeight-12) top=below;
        else if(above>=12) top=above;
        else {top=innerHeight-height-12;left=rect.left+rect.width/2<innerWidth/2 ? innerWidth-width-12 : 12;}
      }
      const where='translate('+Math.round(clamp(left,12,innerWidth-width-12))+'px,'+Math.round(clamp(top,12,innerHeight-height-12))+'px)';
      if(placed!==where) {card.style.transform=where;placed=where;}
      frame=requestAnimationFrame(paint);
    }
    function emit(event,extra) {
      env.send({kind:'guide',token:state.token,index:state.index,event,...extra});
    }
    // The answer to a report is the next step. A host that never answers has gone away.
    function hold() {
      const token=state.token;
      state.busy=true;layer.dataset.busy='';
      clearTimeout(busyTimer);
      busyTimer=setTimeout(()=>{ if(state && state.token===token) clear(); },8000);
    }
    function advance(by) {
      emit('advance',{by,located:!!target,...(state.action==='input' && target ? {filled:filled(target)} : {})});
      hold();
    }
    function act(name) {
      if(name==='next' && state.practice && state.wanted && (!target || locate(state).el!==target)) return;
      if(name==='next' && state.practice?.checked!==undefined && target?.checked!==state.practice.checked) {
        parts.hint.textContent=state.practice.checked ? '请先勾选这个选项' : '请先取消勾选这个选项';
        return;
      }
      if(name==='next') advance(state.action==='click' ? 'skip' : 'button');
      else if(name==='back' || name==='handover') {emit(name);hold();}
      else if(name==='end') {emit('end');clear();}
    }
    for(const type of swallowed) window.addEventListener(type,event=>{
      if(!state || !layer) return;
      const path=event.composedPath(), host=env.host();
      if(host && path.includes(host)) {
        // The card belongs to Athena: the page neither sees these events nor loses focus to them.
        event.stopImmediatePropagation();
        if(event.cancelable) event.preventDefault();
        if(type!=='click' || !event.isTrusted || state.busy) return;
        const hit=layer.getRootNode().elementFromPoint?.(event.clientX,event.clientY);
        const control=hit?.closest?.('[data-do]');
        if(control && layer.contains(control)) act(control.dataset.do);
        return;
      }
      if(!target || state.busy || state.action!=='click' || !event.isTrusted) return;
      if(state.practice && locate(state).el!==target) {press=null;return;}
      const inside=path.includes(target);
      if(type==='click' && inside) {press=null;advance('click');return;}
      if(type==='pointerdown') press=inside ? target.getBoundingClientRect() : null;
      if(type==='pointerup' && press && !state.practice) {
        // Pages that redraw the element while it is pressed never deliver the click to it.
        const rect=press, token=state.token;press=null;
        if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom) return;
        setTimeout(()=>{ if(state && state.token===token && !state.busy) advance('click'); },160);
      }
    },true);
    window.addEventListener('change',event=>{
      if(!state || state.busy || !target || state.action!=='input' || !event.isTrusted) return;
      if(event.composedPath().includes(target) && (!state.practice || locate(state).el===target)) advance('input');
    },true);
    function show(step) {
      if(!step || typeof step!=='object' || typeof step.token!=='string') throw new Error('Invalid guide step');
      const hit=locate(step);
      if(hit.reason && step.require!==false) return {shown:false,reason:hit.reason};
      clearTimeout(busyTimer);clearTimeout(byeTimer);
      state={token:step.token,index:step.index|0,total:step.total|0,title:String(step.title || '').slice(0,80),note:String(step.note || '').slice(0,step.practice ? 1600 : 280),
        action:step.action==='click' || step.action==='input' ? step.action : 'look',selector:step.selector,text:step.text,ref:step.ref,practice:step.practice,
        back:!!step.back,handover:!!step.handover,wanted:!hit.none,busy:false};
      target=hit.el ? aim(hit.el,state.action) : null;
      press=null;seekAt=performance.now();
      // A guide that was not on screen appears in place; only a step that follows another travels.
      const moving=!!layer && layer.isConnected;
      build();fill();
      if(target) reveal();
      if(moving) glide(); else layer.classList.remove('glide');
      if(!frame) paint();
      return {shown:true,located:!!target,target:target ? brief(target) : undefined};
    }
    function clear(farewell) {
      clearTimeout(busyTimer);clearTimeout(byeTimer);clearTimeout(glideTimer);
      cancelAnimationFrame(frame);frame=0;
      const shown=!!state;
      state=null;target=null;press=null;placed='';boxed='';pointed='';
      if(!layer) return;
      const node=layer;
      if(!farewell || !shown || !node.isConnected) {node.remove();return;}
      // A closing word stays for a moment where the last step was.
      node.dataset.bye='';node.dataset.at='page';delete node.dataset.busy;
      parts.note.textContent=String(farewell).slice(0,80);
      byeTimer=setTimeout(()=>{ if(!state) node.remove(); },1600);
    }
    return {
      show,clear,
      state() { return state ? {token:state.token,index:state.index,located:!!target,busy:state.busy} : null; },
    };
  }
`;
