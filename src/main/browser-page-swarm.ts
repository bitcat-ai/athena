/**
 * Edit choreography for the page bridge: when the agent changes an element, cursors fly to it
 * and carry out the change in view, the way collaborators would in a design tool.
 *
 * The idea follows Swarm by Joel Califa (https://github.com/DhvanilPatel/swarm-cursors). This is
 * an independent implementation; none of its code or artwork is used.
 *
 * The page is always edited first. What plays afterwards only withholds pixels: opacity and
 * interpolated styles through script animations, pending text through a custom highlight, and for
 * page scripts the snapshot a view transition keeps of the page as it was. The DOM, styles and
 * the accessibility tree already hold the result.
 */
export const browserSwarmCss = [
  '.swarm{position:absolute;inset:0;overflow:hidden;pointer-events:none}',
  '.sw-cur,.sw-sel,.sw-caret,.sw-rule{position:absolute;left:0;top:0;pointer-events:none}',
  '.sw-cur{width:0;height:0;z-index:3}.sw-cur svg{position:absolute;display:none;overflow:visible;filter:drop-shadow(0 1px 2px #151b3466)}',
  '.sw-cur path{fill:none;stroke-linecap:round;stroke-linejoin:round}.sw-cur .rim{stroke:#fff;stroke-width:3.5}.sw-cur .ink{stroke:var(--c);stroke-width:1.5}',
  '.sw-cur .arrow{left:-1px;top:-1px;width:18px;height:24px}.sw-cur .arrow path{fill:var(--c);stroke:#fff;stroke-width:1.5}',
  '.sw-cur .cross{left:-9.5px;top:-9.5px;width:19px;height:19px}.sw-cur .ibeam{left:-4.5px;top:-10px;width:9px;height:20px}',
  '.sw-cur[data-mode=arrow] .arrow,.sw-cur[data-mode=cross] .cross,.sw-cur[data-mode=ibeam] .ibeam{display:block}',
  '.sw-cur .tag{position:absolute;left:14px;top:19px;padding:2px 7px;border-radius:3px 8px 8px 8px;background:var(--c);color:#fff;font:600 11px/16px system-ui,sans-serif;white-space:nowrap}',
  '.sw-sel{box-sizing:border-box;border:1px solid var(--c);z-index:1}.sw-sel i{position:absolute;box-sizing:border-box;width:7px;height:7px;background:#fff;border:1px solid var(--c)}',
  '.sw-sel i:nth-of-type(1){left:-4px;top:-4px}.sw-sel i:nth-of-type(2){right:-4px;top:-4px}.sw-sel i:nth-of-type(3){right:-4px;bottom:-4px}.sw-sel i:nth-of-type(4){left:-4px;bottom:-4px}',
  '.sw-sel b{position:absolute;left:50%;top:calc(100% + 7px);transform:translateX(-50%);padding:1px 6px;border-radius:4px;background:var(--c);color:#fff;font:500 11px/16px ui-monospace,SFMono-Regular,monospace;white-space:nowrap;transition:opacity .2s}.sw-sel b.up{top:auto;bottom:calc(100% + 7px)}.sw-sel.quiet b{opacity:0}',
  '.sw-sel u{position:absolute;inset:0;background:#8b90a83d;opacity:0;transition:opacity .2s}.sw-sel.ghost u{opacity:1}',
  '.sw-caret{width:1.5px;background:var(--c);z-index:2}.sw-caret.idle{animation:sw-blink 1s steps(1) infinite}',
  '.sw-rule{background:#f2664b;z-index:2}.sw-rule::before,.sw-rule::after{content:"";position:absolute;background:#f2664b}',
  '.sw-rule.flat::before,.sw-rule.flat::after{top:-3px;width:1px;height:7px}.sw-rule.flat::before{left:0}.sw-rule.flat::after{right:0}',
  '.sw-rule:not(.flat)::before,.sw-rule:not(.flat)::after{left:-3px;width:7px;height:1px}.sw-rule:not(.flat)::before{top:0}.sw-rule:not(.flat)::after{bottom:0}',
  '.sw-rule b{position:absolute;padding:0 5px;border-radius:4px;background:#f2664b;color:#fff;font:500 10px/15px ui-monospace,SFMono-Regular,monospace;white-space:nowrap;opacity:0;transition:opacity .15s}.sw-rule.done b{opacity:1}',
  '.sw-rule.flat b{left:50%;bottom:5px;transform:translateX(-50%)}.sw-rule:not(.flat) b{left:6px;top:50%;transform:translateY(-50%)}',
  '@keyframes sw-blink{50%{opacity:0}}',
].join('\n');

// Plain JavaScript for the isolated world, like the bridge that embeds it.
export const browserSwarmSource = String.raw`
  function createSwarm(env) {
    const palette=['#7e8dfa','#f2664b','#19b47c','#e3a008','#e25fb4','#27a9d8'];
    const veilName='athena-swarm-pending';
    const shows=new Set();
    const canVeil=typeof Highlight==='function' && !!globalThis.CSS?.highlights && typeof CSSStyleSheet==='function';
    const coverName='athena-swarm-page';
    const canCover=typeof document.startViewTransition==='function' && typeof CSSStyleSheet==='function' && 'adoptedStyleSheets' in document;
    let stage, sheet, tints=0, suspended=false, mutedUntil=0, unmuteTimer, armed=null, stalledUntil=0;
    // Looks a page script may change, read as longhands so they can be compared.
    const looks=['color','background-color','background-image','font-family','font-size','font-weight','font-style','letter-spacing','line-height','text-transform','text-align','text-decoration-line','opacity','box-shadow','backdrop-filter',
      'border-top-left-radius','border-top-right-radius','border-bottom-right-radius','border-bottom-left-radius','border-top-width','border-right-width','border-bottom-width','border-left-width',
      'border-top-color','border-right-color','border-bottom-color','border-left-color','padding-top','padding-right','padding-bottom','padding-left'];
    const inherited=new Set(['color','font-family','font-size','font-weight','font-style','letter-spacing','line-height','text-transform','text-align']);
    const ease=p=>p<0.5 ? 4*p*p*p : 1-Math.pow(-2*p+2,3)/2;
    const linear=p=>p;
    const camel=name=>name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
    const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
    const make=(tag,className)=>{ const node=document.createElement(tag); node.className=className; return node; };
    const twin=d=>'<path class="rim" d="'+d+'"/><path class="ink" d="'+d+'"/>';
    const art='<svg class="arrow" viewBox="0 0 18 24"><path d="M1 1L16 14L9 15L6 22Z"/></svg>'
      +'<svg class="cross" viewBox="0 0 19 19">'+twin('M9.5 1.5V17.5M1.5 9.5H17.5')+'</svg>'
      +'<svg class="ibeam" viewBox="0 0 9 20">'+twin('M1.5 1.5H3Q4.5 1.5 4.5 3V17Q4.5 18.5 3 18.5H1.5M7.5 1.5H6Q4.5 1.5 4.5 3M7.5 18.5H6Q4.5 18.5 4.5 17')+'</svg>';
    const onscreen=rect=>rect.width>0 && rect.height>0 && rect.right>0 && rect.bottom>0 && rect.left<innerWidth && rect.top<innerHeight;
    const tint=()=>palette[tints++%palette.length];
    const box=rect=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height});
    // Cursors stop at the viewport edge, so work on an element larger than the view stays in sight.
    const within=(x,y)=>[clamp(x,4,innerWidth-24),clamp(y,4,innerHeight-28)];
    // Scrolls an element to where its change can be watched. One that is in view stays put.
    function reveal(el) {
      if (env.reduced.matches || document.visibilityState!=='visible') return el;
      const rect=el.getBoundingClientRect();
      if (!rect.width && !rect.height) return el;
      const high=Math.min(rect.bottom,innerHeight)-Math.max(rect.top,0), wide=Math.min(rect.right,innerWidth)-Math.max(rect.left,0);
      // Inside this viewport it can still be scrolled away in a container or an outer frame.
      if (high>=rect.height-0.5 && wide>=rect.width-0.5) el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      else if (high<0.6*Math.min(rect.height,innerHeight) || wide<0.6*Math.min(rect.width,innerWidth)) el.scrollIntoView({block:rect.height<=innerHeight*0.8 ? 'center' : 'start',inline:'nearest',behavior:'instant'});
      return el;
    }
    // The element itself, or the closest ancestor that can be brought into view.
    function watchable(el) {
      for (let node=el; node; node=env.parent(node)) {
        if (onscreen(reveal(node).getBoundingClientRect())) return node;
      }
      return null;
    }
    function mount() {
      const root=env.root();
      if (!stage?.isConnected || stage.getRootNode()!==root) { stage=make('div','swarm'); root.appendChild(stage); }
      return stage;
    }
    function add(show,node) { mount().appendChild(node); show.nodes.push(node); return node; }
    // Every motion is driven by one frame loop per show, so a show that is settled simply stops.
    function loop(show) {
      if (show.over) return;
      if (!stage?.isConnected) return settle(show);
      for (const frame of [...show.live]) {
        try { frame(); } catch { return settle(show); }
        if (show.over) return;
      }
      show.frame=requestAnimationFrame(()=>loop(show));
    }
    function tween(show,ms,frame,easing=ease) {
      return new Promise(resolve=> {
        const total=Math.max(1,ms*show.speed), started=performance.now();
        const step=()=> {
          const p=Math.min(1,(performance.now()-started)/total);
          frame(easing(p));
          if (p>=1) { show.live.delete(step); resolve(); }
        };
        show.live.add(step);
      });
    }
    const pause=(show,ms)=>tween(show,ms,()=>{});
    // Script animations on page elements are tracked so observations can look past them.
    function keep(show,el,frames,timing) {
      const player=el.animate(frames,timing);
      show.players.add(player);
      return player;
    }
    function cursor(show,color,from,tagged,appear=true) {
      const node=make('div','sw-cur');
      node.style.setProperty('--c',color);
      node.innerHTML=art+(tagged ? '<span class="tag">Athena</span>' : '');
      const me={node,x:0,y:0,bend:show.cursors.length%2 ? -1 : 1,
        to(x,y) { me.x=x; me.y=y; node.style.transform='translate('+x.toFixed(1)+'px,'+y.toFixed(1)+'px)'; },
        mode(value) { node.dataset.mode=value; }};
      me.to(from[0],from[1]); me.mode('arrow');
      show.cursors.push(me); add(show,node);
      if (appear) node.animate([{opacity:0},{opacity:1}],{duration:160});
      return me;
    }
    // Where the nth cursor of a show comes from: near the target first, then the viewport edges.
    function entry(rect,index) {
      const spots=[[rect.right+150,rect.bottom+110],[-24,rect.top-40],[innerWidth+24,rect.top+rect.height/2],[rect.left+rect.width/2,innerHeight+24],[rect.left-120,-24]];
      const spot=spots[index%spots.length];
      return [clamp(spot[0],-24,innerWidth+24),clamp(spot[1],-24,innerHeight+24)];
    }
    function fly(show,pointer,target,ms) {
      const x0=pointer.x, y0=pointer.y;
      return tween(show,ms,p=> {
        const goal=target();
        if (!goal) return;
        const dx=goal[0]-x0, dy=goal[1]-y0, arc=Math.sin(Math.PI*p)*0.12*pointer.bend;
        pointer.to(x0+dx*p-dy*arc,y0+dy*p+dx*arc);
      });
    }
    // A selection frame with corner handles and a live size badge. "from" and "mix" blend it
    // out of an earlier geometry; "grow" draws it out of its top left corner.
    function select(show,color,read) {
      const node=make('div','sw-sel');
      node.style.setProperty('--c',color);
      node.innerHTML='<u></u><i></i><i></i><i></i><i></i><b></b>';
      const badge=node.lastChild;
      const me={node,rect:null,grow:1,from:null,mix:1,
        place() {
          const now=read();
          if (!now || (now.width<=0 && now.height<=0)) { node.style.display='none'; me.rect=null; return; }
          let x=now.x, y=now.y, width=now.width, height=now.height;
          if (me.from && me.mix<1) {
            const rest=1-me.mix;
            x+=me.from.dx*rest; y+=me.from.dy*rest; width+=(me.from.width-width)*rest; height+=(me.from.height-height)*rest;
          }
          width*=me.grow; height*=me.grow;
          me.rect={x,y,width,height};
          node.style.display='block';
          node.style.transform='translate('+x.toFixed(1)+'px,'+y.toFixed(1)+'px)';
          node.style.width=width.toFixed(1)+'px'; node.style.height=height.toFixed(1)+'px';
          const text=Math.round(width)+' × '+Math.round(height);
          if (badge.textContent!==text) badge.textContent=text;
          const low=y+height>innerHeight-30, high=y<30;
          badge.classList.toggle('up',low && !high);
          badge.style.top=low && high ? Math.round(innerHeight-28-y)+'px' : '';
          badge.style.left=((Math.max(x,0)+Math.min(x+width,innerWidth))/2-x).toFixed(1)+'px';
        },
        corner(fx,fy) { return ()=>me.rect && within(me.rect.x+me.rect.width*fx,me.rect.y+me.rect.height*fy); }};
      add(show,node); show.live.add(me.place); me.place();
      return me;
    }
    function dismiss(frame,delay) {
      frame.node.animate([{opacity:1},{opacity:0}],{duration:220,delay,fill:'forwards'});
    }
    function caretAt(node,index) {
      const range=document.createRange(), at=Math.min(index,node.nodeValue.length);
      range.setStart(node,at); range.collapse(true);
      let rects=range.getClientRects();
      if (rects.length) { const rect=rects[rects.length-1]; return {x:rect.x,y:rect.y,height:rect.height}; }
      if (!at) return null;
      range.setStart(node,at-1); range.setEnd(node,at);
      rects=range.getClientRects();
      const rect=rects[rects.length-1];
      return rect ? {x:rect.right,y:rect.y,height:rect.height} : null;
    }
    // Text that is not typed yet stays in the document and is only painted transparent.
    function veil(show,node,start=0) {
      if (!canVeil) return null;
      try {
        const root=node.getRootNode();
        if (!('adoptedStyleSheets' in root)) return null;
        if (!sheet) { sheet=new CSSStyleSheet(); sheet.replaceSync('::highlight('+veilName+'){color:transparent;-webkit-text-fill-color:transparent;text-shadow:none;text-decoration-color:transparent}'); }
        if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets=[...root.adoptedStyleSheets,sheet];
        let pending=CSS.highlights.get(veilName);
        if (!pending) { pending=new Highlight(); CSS.highlights.set(veilName,pending); }
        const range=document.createRange();
        range.setStart(node,start); range.setEnd(node,node.nodeValue.length);
        pending.add(range); show.roots.add(root);
        show.undo.push(()=> {
          pending.delete(range);
          if (!pending.size) CSS.highlights.delete(veilName);
          if (![...shows].some(other=>other!==show && other.roots.has(root))) root.adoptedStyleSheets=root.adoptedStyleSheets.filter(item=>item!==sheet);
        });
        return index=> { if (node.isConnected) range.setStart(node,Math.min(index,node.nodeValue.length)); };
      } catch { return null; }
    }
    async function type(show,pointer,color,node,unveil,budget,start=0) {
      const length=node.nodeValue.length;
      if (!length) return;
      const bar=add(show,make('div','sw-caret'));
      bar.style.setProperty('--c',color);
      let index=start;
      const place=()=> {
        const at=node.isConnected ? caretAt(node,index) : null;
        if (!at) { bar.style.display='none'; return null; }
        bar.style.display='block'; bar.style.height=at.height+'px';
        bar.style.transform='translate('+at.x.toFixed(1)+'px,'+at.y.toFixed(1)+'px)';
        return [at.x+3,at.y+at.height/2];
      };
      show.live.add(place);
      pointer.mode('ibeam');
      await fly(show,pointer,place,150);
      if (length>start) await tween(show,clamp((length-start)*30,240,budget),p=> {
        index=start+Math.round(p*(length-start)); unveil?.(index);
        const at=place();
        if (at) pointer.to(at[0],at[1]);
      },linear);
      bar.classList.add('idle');
    }
    // The edge an element is spaced from on its left or top: the nearest sibling on that side,
    // otherwise the first container that leaves room.
    function reach(el,flat) {
      const rect=el.getBoundingClientRect();
      for (let node=el,depth=0; depth<4; depth++) {
        const host=env.parent(node);
        if (!host || node===document.body) return null;
        let near=null, edge=-Infinity;
        for (const other of [...(node.parentNode?.children || [])].slice(0,80)) {
          if (other===node) continue;
          const box=other.getBoundingClientRect();
          if (!box.width || !box.height) continue;
          const end=flat ? box.right : box.bottom;
          const across=flat ? box.bottom>rect.top && box.top<rect.bottom : box.right>rect.left && box.left<rect.right;
          if (across && end<=(flat ? rect.left : rect.top)+0.5 && end>edge) { near=other; edge=end; }
        }
        if (near) return ()=>flat ? near.getBoundingClientRect().right : near.getBoundingClientRect().bottom;
        const box=host.getBoundingClientRect();
        if ((flat ? rect.left-box.left : rect.top-box.top)>=6) return ()=>flat ? host.getBoundingClientRect().left : host.getBoundingClientRect().top;
        node=host;
      }
      return null;
    }
    // Spacing around an element, drawn as guides with their distance.
    function measures(el) {
      const lines=[], left=reach(el,true), top=reach(el,false);
      if (left) lines.push(()=> { const r=el.getBoundingClientRect(), y=r.top+r.height/2; return [left(),y,r.left,y]; });
      if (top) lines.push(()=> { const r=el.getBoundingClientRect(), x=r.left+r.width/2; return [x,top(),x,r.top]; });
      return lines.filter(read=> {
        const line=read(), length=line[2]-line[0]+line[3]-line[1];
        return length>=6 && length<=640 && line[0]>=0 && line[1]>=0 && line[2]<=innerWidth && line[3]<=innerHeight;
      });
    }
    function rule(show,read) {
      const node=make('div','sw-rule');
      node.innerHTML='<b></b>';
      const me={node,draw:0,tip:null,
        place() {
          const line=el.isConnected ? read() : null;
          if (!line) { node.style.display='none'; me.tip=null; return; }
          const flat=line[1]===line[3], full=flat ? line[2]-line[0] : line[3]-line[1], span=Math.max(1,full*me.draw);
          node.style.display='block';
          node.style.transform='translate('+line[0].toFixed(1)+'px,'+line[1].toFixed(1)+'px)';
          node.style.width=(flat ? span : 1)+'px'; node.style.height=(flat ? 1 : span)+'px';
          node.className='sw-rule'+(flat ? ' flat' : '')+(me.draw>=1 ? ' done' : '');
          const text=String(Math.round(full));
          if (node.firstChild.textContent!==text) node.firstChild.textContent=text;
          me.tip=flat ? [line[0]+span,line[1]] : [line[0],line[1]+span];
        }};
      const el=show.el;
      add(show,node); show.live.add(me.place);
      return me;
    }
    async function survey(show,el,index) {
      const lines=measures(el);
      if (!lines.length) return;
      const pointer=cursor(show,tint(),entry(el.getBoundingClientRect(),index),false);
      for (const read of lines) {
        const guide=rule(show,read);
        await fly(show,pointer,()=> { const line=read(); return [line[0],line[1]]; },260);
        pointer.mode('cross');
        await tween(show,220,p=> { guide.draw=p; guide.place(); if (guide.tip) pointer.to(guide.tip[0],guide.tip[1]); });
        pointer.mode('arrow');
      }
    }
    function difference(el,before) {
      const computed=getComputedStyle(el), from={}, to={};
      for (const [name,last] of Object.entries(before.styles)) {
        const next=computed.getPropertyValue(name);
        if (!last || !next || last===next) continue;
        from[camel(name)]=last; to[camel(name)]=next;
      }
      return Object.keys(from).length ? {from,to} : null;
    }
    // Text, style and animation changes, and their undo.
    async function revise(show,spec) {
      const el=spec.el, before=spec.before, color=tint();
      const live=()=>el.isConnected ? el.getBoundingClientRect() : null;
      const now=el.getBoundingClientRect();
      const morph=before ? difference(el,before) : null;
      const moved=!!before && [before.rect.x-now.x,before.rect.y-now.y,before.rect.width-now.width,before.rect.height-now.height].some(delta=>Math.abs(delta)>0.5);
      // Text both versions start with stays put; only the rest is typed.
      let kept=0;
      if (spec.text && typeof spec.was==='string') while (kept<spec.was.length && spec.was[kept]===spec.text.nodeValue[kept]) kept++;
      const unveil=spec.text ? veil(show,spec.text,kept) : null;
      // Until a cursor gets there, the element keeps the look it had.
      const held=morph ? keep(show,el,[morph.from,morph.from],{duration:1e8,fill:'both'}) : null;
      const lead=cursor(show,color,before?.origin || entry(now,0),true,!before?.origin);
      const frame=select(show,color,live);
      if (moved && !morph) { frame.from={dx:before.rect.x-now.x,dy:before.rect.y-now.y,width:before.rect.width,height:before.rect.height}; frame.mix=0; }
      frame.node.style.visibility='hidden';
      const corner=frame.corner(1,1);
      const ride=(pointer,ms)=>tween(show,ms,()=> { const at=corner(); if (at) pointer.to(at[0],at[1]); });
      await fly(show,lead,spec.text ? frame.corner(0.3,0.5) : corner,before?.origin ? 180 : 320);
      // The size badge makes room for the caret and its name tag while text is typed.
      if (spec.text) frame.node.classList.add('quiet');
      frame.node.style.visibility='';
      const work=[survey(show,el,1).catch(()=>{})];
      if (morph) {
        held.cancel();
        keep(show,el,[morph.from,morph.to],{duration:420*show.speed,easing:'cubic-bezier(0.65,0,0.35,1)'});
        await (spec.text ? pause(show,420) : ride(lead,420));
      } else if (moved) {
        // The content already has its new size; a second cursor drags the frame out to it.
        const sizer=cursor(show,tint(),entry(now,2),false);
        work.push(fly(show,sizer,corner,240).then(()=>tween(show,300,p=> { frame.mix=p; frame.place(); const at=corner(); if (at) sizer.to(at[0],at[1]); })));
      }
      if (spec.text) work.push(type(show,lead,color,spec.text,unveil,900,kept).then(()=>frame.node.classList.remove('quiet')));
      else if (spec.animation) work.push(ride(lead,900));
      await Promise.all(work);
      await pause(show,420);
    }
    // Inserted structures are drawn layer by layer, containers before their content.
    async function construct(show,spec) {
      const layers=[], queue=[[spec.el,null]];
      while (queue.length && layers.length<12) {
        const [el,owner]=queue.shift();
        let layer=owner;
        if (el.localName!=='br' && onscreen(el.getBoundingClientRect())) {
          const texts=[...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE && node.nodeValue.trim());
          layer={el,owner,text:!el.children.length && texts.length===1 ? texts[0] : null,drawn:false};
          layers.push(layer);
        }
        for (const child of el.children) queue.push([child,layer]);
      }
      if (!layers.length) return;
      for (const layer of layers) layer.opacity=getComputedStyle(layer.el).opacity;
      for (const layer of layers) {
        layer.held=keep(show,layer.el,[{opacity:0},{opacity:0}],{duration:1e8,fill:'both'});
        layer.unveil=layer.text ? veil(show,layer.text) : null;
      }
      const crew=Math.min(4,layers.length), home=spec.el.getBoundingClientRect();
      show.speed=clamp(2600/(Math.ceil(layers.length/crew)*640),0.45,1);
      const builder=async(pointer,color)=> {
        while (layers.length) {
          const next=layers.findIndex(layer=>!layer.owner || layer.owner.drawn);
          if (next<0) { await pause(show,40); continue; }
          await build(show,pointer,color,layers.splice(next,1)[0]);
        }
      };
      await Promise.all(Array.from({length:crew},(_,index)=> {
        const color=tint();
        return builder(cursor(show,color,(!index && spec.before?.origin) || entry(home,index),!index,!!index || !spec.before?.origin),color);
      }));
      if (crew<2) await survey(show,spec.el,1).catch(()=>{});
      await pause(show,380);
    }
    async function build(show,pointer,color,layer) {
      const el=layer.el;
      const frame=select(show,color,()=>el.isConnected ? el.getBoundingClientRect() : null);
      frame.grow=0; frame.place();
      frame.node.classList.add('ghost'); frame.node.style.visibility='hidden';
      await fly(show,pointer,frame.corner(0,0),240);
      pointer.mode('cross'); frame.node.style.visibility='';
      await tween(show,260,p=> { frame.grow=p; frame.place(); const at=frame.corner(1,1)(); if (at) pointer.to(at[0],at[1]); });
      layer.held.cancel();
      keep(show,el,[{opacity:0},{opacity:layer.opacity}],{duration:200});
      frame.node.classList.remove('ghost'); frame.node.classList.add('quiet');
      layer.drawn=true;
      if (layer.text) await type(show,pointer,color,layer.text,layer.unveil,520);
      else await pause(show,120);
      pointer.mode('arrow');
      dismiss(frame,240);
    }
    // Where removed content was, carried along when the page around it has moved since.
    function vacated(spec) {
      const rect=spec.gone, from=spec.before?.rect;
      if (!from || !spec.near?.isConnected) return rect;
      const now=spec.near.getBoundingClientRect();
      return new DOMRect(rect.x+now.x-from.x,rect.y+now.y-from.y,rect.width,rect.height);
    }
    // An undone insertion: its outline is selected and collapses.
    async function erase(show,spec) {
      const color=tint(), rect=vacated(spec);
      const frame=select(show,color,()=>vacated(spec));
      frame.node.classList.add('ghost');
      const lead=cursor(show,color,spec.before?.origin || entry(rect,0),true,!spec.before?.origin);
      await fly(show,lead,frame.corner(0.5,0.5),300);
      await pause(show,140);
      await tween(show,240,p=> { frame.grow=1-p; frame.place(); frame.node.style.opacity=String(1-p); });
      await pause(show,200);
    }
    const ownText=el=> { let text=''; for (const node of el.childNodes) if (node.nodeType===3) text+=node.nodeValue; return text; };
    // An element the page animates itself changes without anyone editing it.
    const moving=el=>el.getAnimations().some(item=>item.playState==='running' && !(typeof CSSTransition==='function' && item instanceof CSSTransition));
    // Where running CSS transitions will land; until then computed styles read as their start.
    function landings() {
      const ends=new Map();
      if (typeof CSSTransition!=='function' || !document.getAnimations) return ends;
      for (const item of document.getAnimations()) {
        if (!(item instanceof CSSTransition) || !item.effect?.target || item.effect.pseudoElement) continue;
        try {
          const frames=item.effect.getKeyframes(), value=frames[frames.length-1]?.[camel(item.transitionProperty)];
          if (typeof value!=='string') continue;
          if (!ends.has(item.effect.target)) ends.set(item.effect.target,{});
          ends.get(item.effect.target)[item.transitionProperty]=value;
        } catch {}
      }
      return ends;
    }
    // What is in view, as it looks before a script runs.
    function census() {
      const seen=new Map(), every=document.body.getElementsByTagName('*');
      let pool;
      if (every.length<=4000) pool=[document.documentElement,document.body,...every];
      else {
        // Too much to walk: what lies under a grid of points stands for the view.
        pool=new Set();
        for (let row=0; row<14; row++) for (let column=0; column<10; column++) for (const el of document.elementsFromPoint((column+0.5)*innerWidth/10,(row+0.5)*innerHeight/14)) pool.add(el);
      }
      for (const el of pool) {
        if (seen.size>=500) break;
        if (env.ours(el)) continue;
        const rect=el.getBoundingClientRect();
        if (!onscreen(rect)) continue;
        const computed=getComputedStyle(el), styles={};
        for (const name of looks) styles[name]=computed.getPropertyValue(name);
        seen.set(el,{rect:box(rect),styles,text:ownText(el)});
      }
      return seen;
    }
    // What a script changed in view since the census: the parts cursors will uncover, each with
    // the changes around it that follow along.
    function changes(watch) {
      const ends=landings(), found=new Map(), view=innerWidth*innerHeight;
      // The region in view, widened where a shadow reaches past its box.
      const region=(rect,cast)=> {
        const pad=cast ? 8 : 0, x=Math.max(0,Math.floor(rect.x-pad)), y=Math.max(0,Math.floor(rect.y-pad));
        const width=Math.min(innerWidth,Math.ceil(rect.x+rect.width+pad))-x, height=Math.min(innerHeight,Math.ceil(rect.y+rect.height+pad))-y;
        return width>0 && height>0 ? {x,y,width,height} : null;
      };
      const join=(a,b)=> {
        if (!a || !b) return a || b;
        const x=Math.min(a.x,b.x), y=Math.min(a.y,b.y);
        return {x,y,width:Math.max(a.x+a.width,b.x+b.width)-x,height:Math.max(a.y+a.height,b.y+b.height)-y};
      };
      // The page background paints the whole view, whatever box its element has.
      const canvas=el=>el===document.body || el===document.documentElement;
      const note=(el,rect,own)=> {
        if (canvas(el)) rect={x:0,y:0,width:innerWidth,height:innerHeight};
        if (rect) found.set(el,{el,rect,own,members:[],open:0});
      };
      let lost=0;
      for (const [el,was] of watch.seen) {
        const cast=was.styles['box-shadow']!=='none';
        if (!el.isConnected) { lost++; note(el,region(was.rect,cast),true); continue; }
        const computed=getComputedStyle(el), land=ends.get(el), now=el.getBoundingClientRect();
        let styled=false, boxy=false;
        for (const name of looks) {
          const last=was.styles[name], next=land?.[name] ?? computed.getPropertyValue(name);
          if (!last || !next || last===next) continue;
          // The colour of a border that is not drawn only follows the text colour.
          if (name.startsWith('border-') && name.endsWith('-color')) { const width=name.replace('color','width'); if (was.styles[width]==='0px' && computed.getPropertyValue(width)==='0px') continue; }
          styled=true;
          if (!inherited.has(name)) boxy=true;
        }
        const wrote=ownText(el)!==was.text;
        const shifted=[was.rect.x-now.x,was.rect.y-now.y,was.rect.width-now.width,was.rect.height-now.height].some(delta=>Math.abs(delta)>0.5);
        if ((!styled && !wrote && !shifted) || moving(el)) continue;
        const shade=cast || computed.getPropertyValue('box-shadow')!=='none';
        // A wrapper that only passes a look on, or only moved, is not a part of its own.
        note(el,join(region(was.rect,shade),region(now,shade)),boxy || wrote || (styled && !!ownText(el).trim()));
      }
      // A page that was mostly replaced has moved on rather than been edited.
      if (lost>watch.seen.size/2) return [];
      for (const el of watch.fresh) {
        if (el.isConnected && !found.has(el) && !watch.seen.has(el) && !env.ours(el)) note(el,region(el.getBoundingClientRect(),false),true);
      }
      const size=item=>item.rect.width*item.rect.height;
      const under=(el,among)=> { for (let node=env.parent(el); node; node=env.parent(node)) if (among.has(node)) return true; return false; };
      const outer=list=> { const among=new Set(list.map(item=>item.el)); return list.filter(item=>!under(item.el,among)); };
      const all=[...found.values()], fit=all.filter(item=>size(item)<=view*0.6);
      // A large part that holds several changes is uncovered change by change.
      const spread=item=> {
        if (size(item)<=view*0.2) return [item];
        const inner=outer(fit.filter(other=>other.own && under(other.el,new Set([item.el]))));
        return inner.length>1 ? inner.flatMap(spread) : [item];
      };
      let parts=outer(fit.filter(item=>item.own)).flatMap(spread);
      if (!parts.length) parts=outer(fit);
      // Only something that fills most of the view changed: it is uncovered as one.
      if (!parts.length) parts=all.sort((a,b)=>size(a)-size(b)).slice(0,1);
      parts=parts.sort((a,b)=>size(b)-size(a)).slice(0,12).sort((a,b)=>a.rect.y-b.rect.y || a.rect.x-b.rect.x);
      // Everything else comes into view with the part closest to it.
      const chosen=new Set(parts.map(item=>item.el)), above=new Set();
      for (const part of parts) for (let node=env.parent(part.el); node; node=env.parent(node)) above.add(node);
      const rest=outer(fit.filter(item=>!chosen.has(item.el) && !above.has(item.el) && !under(item.el,chosen))).sort((a,b)=>size(b)-size(a)).slice(0,24);
      for (const item of rest) {
        let near=null, best=Infinity;
        for (const part of parts) {
          const distance=Math.hypot(item.rect.x+item.rect.width/2-part.rect.x-part.rect.width/2,item.rect.y+item.rect.height/2-part.rect.y-part.rect.height/2);
          if (distance<best) { best=distance; near=part; }
        }
        near.members.push(item.rect);
      }
      return parts;
    }
    // Rectangles as rows that do not overlap, so each is cut out of the snapshot exactly once.
    function rows(rects) {
      const edges=[...new Set(rects.flatMap(rect=>[rect.y,rect.y+rect.height]))].sort((a,b)=>a-b), cut=[];
      for (let row=0; row+1<edges.length; row++) {
        const top=edges[row], bottom=edges[row+1], runs=[];
        for (const rect of rects.filter(rect=>rect.y<bottom && rect.y+rect.height>top).sort((a,b)=>a.x-b.x)) {
          const run=runs[runs.length-1];
          if (run && rect.x<=run[1]) run[1]=Math.max(run[1],rect.x+rect.width);
          else runs.push([rect.x,rect.x+rect.width]);
        }
        for (const run of runs) cut.push('M'+run[0]+' '+top+'H'+run[1]+'V'+bottom+'H'+run[0]+'Z');
      }
      return cut.join('');
    }
    // Keeps the page as it looks on top of itself: a view transition that captures the document
    // for its old state only. Underneath, the document is painted, hit tested and scripted as usual.
    function cover(watch) {
      const host=env.root().host, page=new CSSStyleSheet();
      page.replaceSync(':root{view-transition-name:'+coverName+'!important}:not(:root){view-transition-name:none!important}'
        +'::view-transition{pointer-events:none!important}'
        +'::view-transition-group(*),::view-transition-image-pair(*),::view-transition-new(*){animation:none!important;mix-blend-mode:normal!important}'
        +'::view-transition-old(*){display:none!important}'
        +'::view-transition-old('+coverName+'){display:block!important;mix-blend-mode:normal!important;animation:'+coverName+' 1000000s linear both!important}'
        +'@keyframes '+coverName+'{from{opacity:1}to{opacity:1}}'
        +'::view-transition-old('+coverName+'){}');
      watch.rule=page.cssRules[page.cssRules.length-1];
      document.adoptedStyleSheets=[...document.adoptedStyleSheets,page];
      // The cursors are captured apart from the page, so they stay live above its snapshot.
      host.style.setProperty('view-transition-name',coverName+'-cursors','important');
      watch.undo.push(()=> {
        document.adoptedStyleSheets=document.adoptedStyleSheets.filter(item=>item!==page);
        host.style.setProperty('view-transition-name','initial','important');
      });
      // Someone using the page sees it as it is.
      const types=['pointerdown','keydown','wheel','scroll'];
      const used=event=> { if (event.isTrusted && (event.type!=='scroll' || event.target===document)) drop(watch); };
      for (const type of types) addEventListener(type,used,{capture:true,passive:true});
      watch.undo.push(()=> { for (const type of types) removeEventListener(type,used,{capture:true}); });
      const transition=document.startViewTransition(()=> { page.cssRules[0].style.setProperty('view-transition-name','none','important'); });
      watch.undo.push(()=>transition.skipTransition());
      // The page may end the transition itself, for instance with one of its own.
      transition.finished.then(()=>drop(watch),()=>drop(watch));
      transition.updateCallbackDone.catch(()=>{});
      return transition.ready;
    }
    // Takes the snapshot away, so the page shows as it is.
    function release(watch) {
      if (watch.done) return;
      watch.done=true; watch.observer.disconnect(); clearTimeout(watch.timer);
      for (const undo of watch.undo.splice(0).reverse()) { try { undo(); } catch {} }
    }
    function drop(watch) {
      if (watch.done) return;
      if (watch.show) settle(watch.show); else { if (armed===watch) armed=null; release(watch); }
    }
    // Ends what a script is shown with: the watch on one that runs and the show of one that returned.
    function quit() {
      if (armed) drop(armed);
      for (const show of [...shows]) if (show.script) settle(show);
    }
    // A change by script: cursors drag the new look open part by part, then the rest follows.
    async function uncover(show,watch,parts) {
      let path='';
      show.live.add(()=> {
        const open=[];
        for (const part of parts) {
          if (!part.open) continue;
          for (const rect of [part.rect,...part.members]) {
            const width=Math.round(rect.width*part.open), height=Math.round(rect.height*part.open);
            if (width>0 && height>0) open.push({x:rect.x,y:rect.y,width,height});
          }
        }
        const next='path(evenodd,"M-9 -9H'+(innerWidth+9)+'V'+(innerHeight+9)+'H-9Z'+rows(open)+'")';
        if (next!==path) watch.rule.style.setProperty('clip-path',path=next,'important');
      });
      const queue=[...parts], crew=Math.min(4,queue.length), first=queue[0].rect;
      const home={left:first.x,top:first.y,right:first.x+first.width,bottom:first.y+first.height,width:first.width,height:first.height};
      show.speed=clamp(2400/(Math.ceil(queue.length/crew)*700),0.5,1);
      const worker=async(pointer,color)=> { while (queue.length) await drag(show,pointer,color,queue.shift()); };
      await Promise.all(Array.from({length:crew},(_,index)=> {
        const color=tint();
        return worker(cursor(show,color,(!index && watch.origin) || entry(home,index),!index,!!index || !watch.origin),color);
      }));
      await pause(show,160);
      await tween(show,300,p=>watch.rule.style.setProperty('opacity',String(1-p),'important'));
      release(watch);
    }
    async function drag(show,pointer,color,part) {
      const frame=select(show,color,()=>part.rect);
      frame.grow=0; frame.place();
      frame.node.style.visibility='hidden';
      await fly(show,pointer,frame.corner(0,0),260);
      pointer.mode('cross'); frame.node.style.visibility='';
      await tween(show,clamp(160+Math.hypot(part.rect.width,part.rect.height)*0.4,260,460),p=> {
        frame.grow=part.open=p; frame.place();
        const at=frame.corner(1,1)();
        if (at) pointer.to(at[0],at[1]);
      });
      pointer.mode('arrow');
      dismiss(frame,140);
      await pause(show,90);
    }
    function finish(show) {
      if (show.over) return;
      for (const node of show.nodes) node.animate([{opacity:getComputedStyle(node).opacity},{opacity:0}],{duration:200,fill:'forwards'});
      show.fade=setTimeout(()=>settle(show),210);
    }
    function settle(show) {
      if (!shows.delete(show)) return;
      show.over=true; show.live.clear();
      cancelAnimationFrame(show.frame); clearTimeout(show.guard); clearTimeout(show.fade);
      for (const player of show.players) player.cancel();
      for (const undo of show.undo.splice(0)) { try { undo(); } catch {} }
      for (const node of show.nodes) node.remove();
      if (shows.size) return;
      // The success wash of the same edit must not replay once the cursors leave.
      clearTimeout(unmuteTimer);
      unmuteTimer=setTimeout(()=> { if (!shows.size) env.mute(false); },Math.max(0,mutedUntil-performance.now()));
    }
    return {
      /** The displayed state before a change: geometry, the named styles and where the agent cursor is. */
      capture(el,names) {
        if (env.reduced.matches) return null;
        const rect=el.getBoundingClientRect(), computed=getComputedStyle(el), styles={};
        for (const name of names) if (name!=='display' && !name.startsWith('--')) styles[name]=computed.getPropertyValue(name);
        return {rect:box(rect),styles,origin:env.origin()};
      },
      reveal,
      /** Inline properties that differ between the element and another inline style text. */
      inline(el,cssText) {
        const probe=document.createElement('i');
        probe.style.cssText=cssText;
        return [...new Set([...el.style,...probe.style])];
      },
      /** Plays a change that has already been applied. Returns false when nothing is shown. */
      play(spec) {
        try {
          quit();
          if (spec.el) this.settle(spec.el);
          if (env.reduced.matches || document.visibilityState!=='visible') return false;
          if (!onscreen(spec.gone ? vacated(spec) : spec.el.getBoundingClientRect())) {
            // A change with nothing to see in view is shown on the closest element that has.
            const el=watchable(spec.el || spec.near);
            if (!el) return false;
            const rect=box(el.getBoundingClientRect());
            spec=el===spec.el ? {...spec,before:spec.before && {...spec.before,rect}} : {el,before:{rect,styles:{},origin:spec.before?.origin}};
            this.settle(el);
          }
          while (shows.size>=4) settle(shows.values().next().value);
          if (!shows.size) tints=0;
          mount();
          const show={el:spec.el,speed:1,over:false,live:new Set(),players:new Set(),roots:new Set(),nodes:[],cursors:[],undo:[]};
          shows.add(show);
          mutedUntil=performance.now()+950; clearTimeout(unmuteTimer); env.mute(true);
          // Frames may never come, for instance in a hidden tab; the page must not stay withheld.
          show.guard=setTimeout(()=>settle(show),8000);
          if (spec.el) show.live.add(()=> { if (!spec.el.isConnected) settle(show); });
          (spec.gone ? erase : spec.inserted ? construct : revise)(show,spec).then(()=>finish(show),()=>settle(show));
          loop(show);
          return true;
        } catch { return false; }
      },
      /** Ends the shows touching an element, or all of them, leaving the page as edited. */
      settle(el) {
        quit();
        for (const show of [...shows]) if (!el || (show.el && (show.el.contains(el) || el.contains(show.el)))) settle(show);
      },
      /** Runs an observation against the page as edited, not a frame of a running show. */
      truth(read) {
        if (suspended || !shows.size) return read();
        const saved=[];
        suspended=true;
        for (const show of shows) for (const player of show.players) {
          if (player.playState!=='running') continue;
          saved.push([show,player,player.currentTime]); player.cancel();
        }
        try { return read(); }
        finally {
          for (const [show,player,time] of saved) if (!show.over) { player.play(); player.currentTime=time; }
          suspended=false;
        }
      },
      /**
       * Notes what is in view before a page script of the agent runs and keeps it on screen.
       * Resolves true once the page is covered by its own snapshot.
       */
      watch() {
        quit();
        if (!canCover || shows.size || env.reduced.matches || document.visibilityState!=='visible' || !document.body || document.activeViewTransition || performance.now()<stalledUntil) return false;
        const watch={seen:census(),scroll:[scrollX,scrollY],origin:env.origin(),fresh:new Set(),undo:[],held:false,done:false,show:null};
        if (!watch.seen.size) return false;
        watch.observer=new MutationObserver(records=> { for (const record of records) for (const node of record.addedNodes) if (node.nodeType===1) watch.fresh.add(node); });
        watch.observer.observe(document,{subtree:true,childList:true});
        armed=watch;
        return new Promise(resolve=> {
          // A document that renders no frames takes no snapshot; it is not asked again for a while.
          watch.timer=setTimeout(()=> { stalledUntil=performance.now()+30000; drop(watch); resolve(false); },250);
          const held=()=> {
            if (watch.done) return resolve(false);
            watch.held=true; clearTimeout(watch.timer);
            // A script that never reports back must not leave the page covered.
            watch.timer=setTimeout(()=>drop(watch),3000);
            resolve(true);
          };
          try { cover(watch).then(held,()=> { drop(watch); resolve(false); }); } catch { drop(watch); resolve(false); }
        });
      },
      /** Plays what changed in view since watch(), or only uncovers the page. Returns the number of shows it started. */
      replay(play=true) {
        const watch=armed;
        if (!watch) return 0;
        armed=null; clearTimeout(watch.timer);
        for (const record of watch.observer.takeRecords()) for (const node of record.addedNodes) if (node.nodeType===1) watch.fresh.add(node);
        watch.observer.disconnect();
        let parts=[];
        try {
          if (play && watch.held && !env.reduced.matches && document.visibilityState==='visible' && scrollX===watch.scroll[0] && scrollY===watch.scroll[1]) parts=changes(watch);
        } catch {}
        if (!parts.length) { release(watch); return 0; }
        tints=0;
        mount();
        const show=watch.show={el:null,script:true,speed:1,over:false,live:new Set(),players:new Set(),roots:new Set(),nodes:[],cursors:[],undo:[()=>release(watch)]};
        shows.add(show);
        mutedUntil=performance.now()+950; clearTimeout(unmuteTimer); env.mute(true);
        show.guard=setTimeout(()=>settle(show),8000);
        uncover(show,watch,parts).then(()=>finish(show),()=>settle(show));
        loop(show);
        return 1;
      },
      /** Resolves once every show is over, or after the limit. */
      rest(limit) {
        return new Promise(resolve=> {
          const until=performance.now()+limit;
          const check=()=>!shows.size || performance.now()>=until ? resolve() : setTimeout(check,50);
          check();
        });
      },
      get active() { return shows.size; },
    };
  }
`;
