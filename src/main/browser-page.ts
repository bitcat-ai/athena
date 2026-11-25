import {
  ELEMENT_STYLE_PROPERTIES,
  ELEMENT_ANIMATION_PROPERTIES,
  ELEMENT_BACKGROUND_FUNCTIONS,
  ELEMENT_PREVIEW_LIMITS,
  ELEMENT_UNSAFE_CSS_PATTERN,
  ELEMENT_INSERT_TAGS,
  ELEMENT_INSERT_ATTRIBUTES,
} from '../shared/types';
import { browserGuideCss, browserGuideSource } from './browser-page-guide';
import { browserSwarmCss, browserSwarmSource } from './browser-page-swarm';

// Keep this as plain JavaScript: the isolated world must not depend on bundler helpers.
export const browserPageSource = String.raw`(() => {
  if (globalThis.__workbenchPage) return;
  const docId = 'd' + (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
  const ids = new WeakMap();
  const elements = new Map();
  const observers = new Map();
  const overlays = new WeakSet();
  const patches = new Map();
  const editOrder = [];
  const ownedAnimations = new Map();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const textLimit = 20000;
  const styleNames = ${JSON.stringify(ELEMENT_STYLE_PROPERTIES)};
  const limits = ${JSON.stringify(ELEMENT_PREVIEW_LIMITS)};
  const unsafeCss = new RegExp(${JSON.stringify(ELEMENT_UNSAFE_CSS_PATTERN)},'i');
  const editableStyles = new Set(styleNames);
  const animationStyles = new Set(${JSON.stringify(ELEMENT_ANIMATION_PROPERTIES)});
  const backgroundFunctions = new Set(${JSON.stringify(ELEMENT_BACKGROUND_FUNCTIONS)});
  const insertTags = new Set(${JSON.stringify(ELEMENT_INSERT_TAGS)});
  const insertAttributes = new Set(${JSON.stringify(ELEMENT_INSERT_ATTRIBUTES)});
  const attributeNames = new Set(['id','class','role','aria-label','aria-labelledby','aria-describedby','aria-hidden','aria-expanded','aria-checked','aria-selected','title','alt','name','type','placeholder','data-testid','tabindex','disabled','readonly']);
  const blockedTextTags = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','META','LINK','BASE','INPUT','TEXTAREA','SELECT','OPTION','IMG','IFRAME','OBJECT','EMBED','VIDEO','AUDIO','CANVAS','HTML','BODY','SVG','PATH','RECT','CIRCLE']);
  const blockedEditTags = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','META','LINK','BASE','OBJECT','EMBED']);
  let nextId = 0;
  let nextEditId = 0;
  let nextAnimationId = 0;
  let source = 'human';
  let recordingId, privateTrial=false, feedbackWindow, interactionSequence=0;
  let actorId = 'host';
  let maskNodes = [];
  let inspecting = false;
  let overlayHost, overlayRoot, overlayFrame = 0;
  let hoverElement, selectedElement, feedbackElement, feedbackPhase, feedbackTimer;
  let feedbackAgent = false, agentCursor, cursorTarget, cursorMotion;
  let hoverPoint, overlayMute;
  // After a person's own edit the frame steps aside so the result is seen as it is; the element stays selected.
  let selectionResting=false;
  const overlayBoxes = {};
  const clean = (text, limit=180) => String(text ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [hidden]').replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[hidden]').replace(/\b(password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[hidden]').slice(0, limit);
  const parent = el => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  const leafText = el => [...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.nodeValue || '').join('');
  function sensitive(el) {
    if (!(el instanceof Element)) return false;
    for (let node=el, depth=0; node && depth<20; node=parent(node),depth++) {
      if (node.hasAttribute('data-private') || node.hasAttribute('data-sensitive') || node.classList.contains('rr-block')) return true;
      if (/password|secret|token|api.?key|credit|card.?number|cvv|cvc|ssn|email|phone|mobile|address/i.test([node.getAttribute('type'),node.getAttribute('name'),node.id,node.getAttribute('autocomplete'),node.getAttribute('aria-label')].filter(Boolean).join(' '))) return true;
    }
    return false;
  }
  function forget(node) {
    if (!(node instanceof Element)) return;
    const pending=[node];
    while (pending.length) {
      const current=pending.pop();
      const ref=ids.get(current);
      if (ref) { elements.delete(ref); ids.delete(current); }
      ownedAnimations.get(current)?.player?.cancel();
      ownedAnimations.delete(current);
      pending.push(...current.children);
      if (current.shadowRoot) {
        observers.get(current.shadowRoot)?.disconnect();
        observers.delete(current.shadowRoot);
        pending.push(...current.shadowRoot.children);
      }
    }
  }
  function changes(records) {
    for (const record of records) for (const removed of record.removedNodes) forget(removed);
  }
  function observe(root) {
    if (observers.has(root)) return;
    const observer = new MutationObserver(changes);
    observer.observe(root, {childList:true,subtree:true});
    observers.set(root, observer);
  }
  function flush() {
    for (const observer of observers.values()) changes(observer.takeRecords());
  }
  observe(document);
  function unique(root, candidate, el) {
    try { const found=root.querySelectorAll(candidate); return found.length===1 && found[0]===el; } catch { return false; }
  }
  function selector(el) {
    const root=el.getRootNode();
    if (!(root instanceof Document || root instanceof ShadowRoot)) return undefined;
    if (el.id) { const value='#'+CSS.escape(el.id); if (unique(root,value,el)) return value; }
    const testId=el.getAttribute('data-testid');
    if (testId) { const value='[data-testid="'+CSS.escape(testId)+'"]'; if (unique(root,value,el)) return value; }
    const parts=[];
    for (let node=el; node && parts.length<256; node=node.parentElement) {
      const owner=node.parentElement || root;
      const siblings=[...owner.children].filter(child=>child.localName===node.localName && child.namespaceURI===node.namespaceURI);
      parts.unshift(CSS.escape(node.localName)+':nth-of-type('+(siblings.indexOf(node)+1)+')');
      const value=parts.join(' > ');
      if (unique(root,value,el)) return value;
    }
    return undefined;
  }
  function shadowPath(el) {
    const result=[];
    let root=el.getRootNode();
    while (root instanceof ShadowRoot) {
      observe(root);
      result.unshift(selector(root.host));
      root=root.host.getRootNode();
    }
    return result;
  }
  function visible(el) {
    if (!el.isConnected || overlays.has(el)) return false;
    const rect=el.getBoundingClientRect();
    const style=getComputedStyle(el);
    return rect.width>0 && rect.height>0 && style.visibility!=='hidden' && style.visibility!=='collapse' && style.display!=='none';
  }
  function safeText(el, limit=4000, separateNodes=false) {
    const pieces=[];
    const seen=new Set();
    let length=0;
    function visit(node,depth=0) {
      if (!node || seen.has(node) || length>limit || depth>256 || seen.size>10000) return;
      seen.add(node);
      if (node.nodeType===Node.TEXT_NODE) {
        const value=node.nodeValue || '';
        pieces.push(value); if(separateNodes) pieces.push(' '); length+=value.length; return;
      }
      if (!(node instanceof Element) || overlays.has(node) || sensitive(node) || ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','TEXTAREA','INPUT','SELECT'].includes(node.localName.toUpperCase())) return;
      const style=getComputedStyle(node);
      if (style.display==='none' || style.visibility==='hidden') return;
      if (node instanceof HTMLSlotElement) {
        const assigned=node.assignedNodes({flatten:true});
        for (const child of assigned.length ? assigned : node.childNodes) visit(child,depth+1);
      } else if (node.shadowRoot) {
        observe(node.shadowRoot);
        for (const child of node.shadowRoot.childNodes) visit(child,depth+1);
      } else for (const child of node.childNodes) visit(child,depth+1);
      if (['block','flex','grid','list-item','table-row'].includes(style.display)) { pieces.push('\n'); length++; }
    }
    visit(el);
    return clean(pieces.join('').trim(),limit);
  }
  function role(el) {
    const explicit=el.getAttribute('role');
    if (explicit) return explicit;
    const tag=el.localName;
    if (tag==='a' && el.hasAttribute('href')) return 'link';
    if (tag==='input') return ({checkbox:'checkbox',radio:'radio',range:'slider',button:'button',submit:'button',reset:'button',search:'searchbox',hidden:undefined})[el.type] || (el.type==='hidden' ? undefined : 'textbox');
    if (tag==='select') return el.multiple ? 'listbox' : 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return ({button:'button',textarea:'textbox',img:'img',option:'option',ul:'list',ol:'list',li:'listitem',nav:'navigation',main:'main',aside:'complementary',table:'table',tr:'row',td:'cell',th:'columnheader'})[tag];
  }
  function semantics(el) {
    const explicit=el.getAttribute('role'), native=role(el);
    if (native) return {kind:native,source:explicit?'aria':'html',evidence:[explicit?'role='+explicit:'tag='+el.localName]};
    const evidence=[];
    if (el.hasAttribute('onclick')) evidence.push('onclick attribute');
    if (el.tabIndex>=0) evidence.push('keyboard focusable');
    if (getComputedStyle(el).cursor==='pointer') evidence.push('pointer cursor');
    return {kind:evidence.includes('onclick attribute') || evidence.length>=2 ? 'button':'element',source:evidence.length?'inferred':'unknown',evidence};
  }
  function describe(el, shallow=false) {
    if (!(el instanceof Element) || overlays.has(el)) return null;
    flush();
    observe(el.getRootNode());
    if (!ids.has(el)) { const ref=docId+':'+(++nextId); ids.set(el,ref); elements.set(ref,el); }
    const rect=el.getBoundingClientRect();
    const hidden=sensitive(el);
    const text=hidden ? '[hidden]' : shallow === true ? (el.isContentEditable || /^(input|textarea|select|option)$/i.test(el.localName) ? '' : clean(leafText(el).trim(),100)) : safeText(el,180);
    const label=el.getAttribute('aria-label') || (el.labels && [...el.labels].map(label=>safeText(label,180)).join(' ')) || el.getAttribute('placeholder') || el.getAttribute('title') || text || el.getAttribute('alt') || el.localName;
    return {ref:ids.get(el),documentId:docId,tag:el.localName,role:role(el),name:hidden ? '[hidden]' : clean(label),selector:selector(el),shadowPath:shadowPath(el),text,
      value:shallow !== true && 'value' in el ? (hidden ? '[hidden]' : clean(el.value)) : undefined,
      bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
  }
  function resolve(ref) {
    flush();
    if (typeof ref!=='string' || !ref.startsWith(docId+':')) throw new Error('Element reference belongs to an old document. Query the page again.');
    const el=elements.get(ref);
    if (!el || !el.isConnected || el.ownerDocument!==document) throw new Error('Element reference is stale or the node was removed. Query the page again.');
    return el;
  }
  function scan() {
    const found=[];
    const pending=[...document.children].reverse();
    while (pending.length && found.length<10000) {
      const el=pending.pop();
      if (overlays.has(el)) continue;
      found.push(el);
      pending.push(...[...el.children].reverse());
      if (el.shadowRoot) { observe(el.shadowRoot); pending.push(...[...el.shadowRoot.children].reverse()); }
    }
    return {found,truncated:pending.length>0};
  }
  function atPoint(x,y) {
    let el=document.elementFromPoint(x,y);
    for (let depth=0; el?.shadowRoot && depth<256; depth++) {
      observe(el.shadowRoot);
      const inner=el.shadowRoot.elementFromPoint(x,y);
      if (!inner || inner===el) break;
      el=inner;
    }
    return el && !overlays.has(el) ? el : null;
  }
  function eventTarget(event) {
    return event.composedPath().find(node=>node instanceof Element && !overlays.has(node)) || null;
  }
  function overlaySurface() {
    if (!overlayHost?.isConnected) {
      overlayHost=document.createElement('div'); overlays.add(overlayHost);
      overlayHost.setAttribute('data-workbench-overlay',''); overlayHost.setAttribute('aria-hidden','true');
      overlayHost.style.cssText='all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;contain:layout style!important;';
      overlayRoot=overlayHost.attachShadow({mode:'closed'});
      const css=document.createElement('style');
      css.textContent=[
        ':host{pointer-events:none}.box{position:absolute;box-sizing:border-box;pointer-events:none;border-radius:4px;display:none}.hover{border:1px solid #8291ed;background:#7e8dfa18;box-shadow:0 0 0 1px #fff9}.selected{border:2px solid #7e8dfa;box-shadow:0 0 0 1px #151b3480}',
        '.label{position:absolute;left:0;bottom:calc(100% + 5px);max-width:min(320px,90vw);box-sizing:border-box;padding:4px 7px;background:#202639;color:#fff;border:1px solid #6471b1;border-radius:5px;font:500 11px/16px ui-monospace,SFMono-Regular,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.feedback{border:1px solid #8291ed;box-shadow:0 0 0 1px #fff9}.handle{position:absolute;width:5px;height:5px;background:#fff;border:1px solid #8291ed;border-radius:1px}.handle:nth-of-type(1){left:-4px;top:-4px}.handle:nth-of-type(2){right:-4px;top:-4px}.handle:nth-of-type(3){right:-4px;bottom:-4px}.handle:nth-of-type(4){left:-4px;bottom:-4px}',
        '.scan{position:absolute;inset:0;overflow:hidden;border-radius:inherit}.scan::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,#969fff30 50%,transparent 70%);transform:translateX(-100%);animation:sweep 1.4s ease-in-out infinite}.applied .scan::after{animation:sweep 250ms cubic-bezier(0.23,1,0.32,1) both}',
        '.agent-cursor{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}.agent-cursor svg{position:absolute;width:18px;height:24px;overflow:visible;filter:drop-shadow(0 1px 2px #151b3466)}.agent-cursor .label{left:15px;top:20px;bottom:auto;border-radius:3px 8px 8px 8px;font-family:system-ui,sans-serif}.agent-cursor.flip .label{left:auto;right:5px}.agent-cursor.above .label{top:auto;bottom:5px}',
        '.feedback.applied,.agent-cursor.applied{animation:finish 900ms linear both}@keyframes sweep{to{transform:translateX(100%)}}@keyframes finish{0%,75%{opacity:1}100%{opacity:0}}',
        '@media(prefers-reduced-motion:reduce){.feedback,.agent-cursor,.scan::after{animation:none!important}.scan{display:none}}',
        ${JSON.stringify(browserSwarmCss)},
        ${JSON.stringify(browserGuideCss)},
      ].join('\n');
      overlayRoot.appendChild(css); document.documentElement.appendChild(overlayHost);
      cursorMotion?.cancel();agentCursor=null;cursorTarget=null;
      for(const name of Object.keys(overlayBoxes)) delete overlayBoxes[name];
    }
    return overlayRoot;
  }
  function overlayBox(kind) {
    overlaySurface();
    if(!overlayBoxes[kind]) {
      const box=document.createElement('div'); box.className='box '+kind; box.dataset.kind=kind;
      const label=document.createElement('span');label.className='label';box.appendChild(label);
      if(kind==='feedback') {
        const scan=document.createElement('span');scan.className='scan';box.appendChild(scan);
        for(let i=0;i<4;i++) {const handle=document.createElement('i');handle.className='handle';box.appendChild(handle);}
      }
      overlayRoot.appendChild(box);overlayBoxes[kind]=box;
    }
    return overlayBoxes[kind];
  }
  function drawOverlay(kind,el) {
    if(!el?.isConnected || !visible(el)) { if(overlayBoxes[kind]) {overlayBoxes[kind].style.display='none';overlayBoxes[kind].lastBounds='';}return; }
    const rect=el.getBoundingClientRect();
    const left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(innerWidth,rect.right),bottom=Math.min(innerHeight,rect.bottom);
    if(right<=left || bottom<=top) { if(overlayBoxes[kind]) {overlayBoxes[kind].style.display='none';overlayBoxes[kind].lastBounds='';}return; }
    const box=overlayBox(kind);
    const css='display:block;left:'+left+'px;top:'+top+'px;width:'+(right-left)+'px;height:'+(bottom-top)+'px;';
    if(box.lastBounds!==css) {box.style.cssText=css;box.lastBounds=css;}
    const label=box.firstChild;
    const text=el.localName+' · '+Math.round(rect.width)+' × '+Math.round(rect.height);
    if(label.textContent!==text) label.textContent=text;
    label.style.bottom=top<30 ? 'auto' : 'calc(100% + 5px)';
    label.style.top=top<30 ? 'calc(100% + 5px)' : 'auto';
    label.style.maxWidth=Math.max(30,innerWidth-left-6)+'px';
  }
  function drawAgentCursor() {
    const box=overlayBoxes.feedback;
    if(!feedbackAgent || !feedbackElement || box?.style.display!=='block') {
      if(agentCursor) agentCursor.style.display='none';
      cursorMotion?.cancel();cursorTarget=null;return;
    }
    if(!agentCursor) {
      agentCursor=document.createElement('div');agentCursor.className='agent-cursor';
      agentCursor.innerHTML='<svg viewBox="0 0 18 24" aria-hidden="true"><path d="M1 1L16 14L9 15L6 22Z" fill="#7e8dfa" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg><span class="label"></span>';
      overlayRoot.appendChild(agentCursor);
    }
    const x=Math.max(0,Math.min(innerWidth-20,parseFloat(box.style.left)+parseFloat(box.style.width)*0.7));
    const y=Math.max(0,Math.min(innerHeight-26,parseFloat(box.style.top)+Math.min(24,parseFloat(box.style.height)*0.5)));
    const transform='translate('+x+'px,'+y+'px)';
    const changed=cursorTarget!==feedbackElement;
    const from=changed && cursorTarget ? getComputedStyle(agentCursor).transform : 'translate('+(x+18)+'px,'+(y+24)+'px)';
    if(changed || agentCursor.lastTransform!==transform || reducedMotion.matches) cursorMotion?.cancel();
    if(agentCursor.lastTransform!==transform) {agentCursor.style.transform=transform;agentCursor.lastTransform=transform;}
    agentCursor.style.display='block';
    const className='agent-cursor'+(feedbackPhase==='applied' ? ' applied' : '')+(x>innerWidth-150 ? ' flip' : '')+(y>innerHeight-55 ? ' above' : '');
    if(agentCursor.className!==className) agentCursor.className=className;
    const label=agentCursor.lastChild;
    const text=feedbackPhase==='applied' ? 'Athena · 已执行' : 'Athena · 处理中';
    if(label.textContent!==text) label.textContent=text;
    if(changed && !reducedMotion.matches) cursorMotion=agentCursor.animate([{transform:from},{transform}],{duration:200,easing:'cubic-bezier(0.77,0,0.175,1)'});
    cursorTarget=feedbackElement;
  }
  function paintOverlays() {
    overlayFrame=0;
    if(inspecting && hoverPoint) {
      const target=atPoint(hoverPoint.x,hoverPoint.y);
      hoverElement=target?.localName==='iframe' ? null : target;
    }
    if(hoverElement && !hoverElement.isConnected) hoverElement=null;
    if(selectedElement && !selectedElement.isConnected) selectedElement=null;
    if(feedbackElement && !feedbackElement.isConnected) feedbackElement=null;
    drawOverlay('selected',selectionResting ? null : selectedElement);
    drawOverlay('hover',inspecting && hoverElement!==selectedElement ? hoverElement : null);
    drawOverlay('feedback',feedbackElement);
    drawAgentCursor();
    if(hoverPoint || selectedElement || feedbackElement) overlayFrame=requestAnimationFrame(paintOverlays);
  }
  function refreshOverlays() { if(!overlayFrame) paintOverlays(); }
  function feedback(ref,phase) {
    if(phase===null && feedbackPhase==='applied') return;
    if(phase===null && ref && feedbackElement!==elements.get(ref)) return;
    clearTimeout(feedbackTimer);
    feedbackElement=phase && ref ? resolve(ref) : null;feedbackPhase=phase;
    feedbackAgent=!!phase && (phase==='working' || source==='agent');
    if(feedbackElement) {
      const box=overlayBox('feedback');box.className='box feedback'+(phase==='applied' ? ' applied' : '');
      for(const player of box.getAnimations({subtree:true})) {player.currentTime=0;player.play();}
      for(const player of agentCursor?.getAnimations() || []) if(player instanceof CSSAnimation) {player.currentTime=0;player.play();}
      // A completed action stays legible briefly; it never delays the actual edit.
      if(phase==='applied') feedbackTimer=setTimeout(()=>{feedbackElement=null;feedbackPhase=null;refreshOverlays();},900);
    }
    refreshOverlays();
  }
  ${browserSwarmSource}
  // While cursors carry out an edit they are the feedback; the regular boxes keep their state unseen.
  function muteOverlays(muted) {
    if(muted && overlayMute?.isConnected) return;
    overlayMute?.remove();overlayMute=null;
    if(!muted || !overlayHost?.isConnected) return;
    overlayMute=document.createElement('style');overlayMute.textContent='.selected,.feedback,.agent-cursor{visibility:hidden}';
    overlayRoot.appendChild(overlayMute);
  }
  let scriptWatchVersion=0;
  const swarm=createSwarm({root:overlaySurface,parent,sensitive,roots:()=>observers.keys(),interrupted:()=>{scriptWatchVersion++;},reduced:reducedMotion,mute:muteOverlays,motion:()=>send({kind:'cursor-motion'}),ours:node=>overlays.has(node),origin() {
    if(!agentCursor?.isConnected || agentCursor.style.display!=='block') return null;
    const rect=agentCursor.getBoundingClientRect();
    return [rect.x,rect.y];
  }});
  function presentElement(spec) {
    if(source==='agent') swarm.present(spec);
    else swarm.present({actor:source,targets:[spec.el || spec.near],gone:spec.gone,near:spec.near});
  }
  document.addEventListener('mousemove',event=>{
    if(selectionResting && selectedElement && event.target instanceof Node && selectedElement.contains(event.target)) {selectionResting=false;refreshOverlays();}
    if(!inspecting) return;
    if(!hoverPoint) send({kind:'hover-frame'});
    hoverPoint={x:event.clientX,y:event.clientY};refreshOverlays();
  },true);
  document.addEventListener('mouseout',event=>{
    if(!event.relatedTarget || event.relatedTarget?.localName==='iframe') {hoverPoint=null;hoverElement=null;refreshOverlays();}
  },true);
  ${browserGuideSource}
  const guide=createGuide({root:overlaySurface,host:()=>overlayHost,visible,sensitive,safeText,scopeText,resolve,scan,describe,send,reduced:reducedMotion,ours:node=>overlays.has(node)});
  window.addEventListener('pagehide',()=>{guide.clear();globalThis.__workbenchPage?.clearOverlays();});
  function send(payload) {
    if(privateTrial && payload.target) payload={...payload,value:undefined,target:{...payload.target,value:undefined}};
    if(payload.kind==='edit') { const patch=patches.get(payload.editId); if(patch && !patch.at) {patch.at=Date.now();patch.by=source;} }
    try { globalThis.__workbenchEvent(JSON.stringify({docId,source,actorId,at:Date.now(),recordingId,interaction:feedbackWindow?.interaction,...payload})); } catch {}
    if(['edit','undo','layout-invalidated'].includes(payload.kind)) reportTimeline();
  }
  // The committed preview edits of this document in order, and how many of the newest are held back.
  // Moving along the timeline only takes edits back and puts them on again; nothing is forgotten until
  // a new edit is made from an earlier point, which drops what came after it.
  let rewound=0;
  const timelineIds=()=>editOrder.filter(id=>!patches.get(id)?.transient);
  function timelineState() {
    const ids=timelineIds();
    return {position:ids.length-rewound,entries:ids.map(id=> {
      const patch=patches.get(id);
      let name='';
      try { if(!patch.sheet && !privateTrial) name=describe(patch.el,true)?.name || ''; } catch {}
      return {id,kind:patch.inserted ? 'insert' : patch.pairHost ? 'layout' : patch.sheet ? 'restyle' : patch.hasText ? 'text' : patch.hasAnimation && !patch.hasStyles ? 'animation' : 'style',
        name:clean(name,60),by:patch.by==='agent' ? 'agent' : 'human',at:patch.at || 0};
    })};
  }
  function reportTimeline() {
    try { globalThis.__workbenchEvent(JSON.stringify({docId,kind:'timeline',timeline:timelineState()})); } catch {}
  }
  function dropFuture() {
    if(!rewound) return;
    const ids=timelineIds().slice(-rewound).reverse();
    rewound=0;
    for(const id of ids) {
      const patch=patches.get(id);
      patch.guard?.disconnect();
      patches.delete(id);editOrder.splice(editOrder.indexOf(id),1);
      let target;
      try { target=describe(patch.inserted ? patch.anchor : patch.el,true) || undefined; } catch {}
      send({kind:'undo',target,editId:id,value:JSON.stringify({editId:id})});
    }
  }
  function rewindPatch(patch) {
    if(patch.sheet) {
      patch.guard?.disconnect();
      document.adoptedStyleSheets=document.adoptedStyleSheets.filter(item=>item!==patch.sheet);
      // Text the page has rewritten since is newer than this preview and stays.
      for(const change of [...patch.texts].reverse()) {
        change.held=!change.node.isConnected || change.node.nodeValue!==change.after;
        if(change.held) continue;
        if(change.created) {change.host=change.node.parentNode;change.node.remove();} else change.node.nodeValue=change.before;
      }
      return;
    }
    const el=patch.el;
    if(patch.inserted) {
      const nodes=treeNodes(el);
      if(el.parentNode!==patch.container || nodes.length!==patch.nodes.length || nodes.some((node,index)=>node!==patch.nodes[index])) throw new Error('Created content changed after this preview');
      swarm.settle(el);
      patch.next=el.nextSibling;el.remove();
      return;
    }
    if(resolve(patch.ref)!==el || sensitive(el)) throw new Error('The edited element is no longer safe to restore');
    if(patch.hasText) {
      const structure=[...el.childNodes];
      if(structure.length!==patch.textStructure.length || structure.some((node,index)=>node!==patch.textStructure[index]) || patch.textNodes.some((node,index)=>node.nodeValue!==patch.afterText[index])) throw new Error('Page text changed after this edit');
    }
    if(patch.hasStyles && el.style.cssText!==patch.afterCssText) throw new Error('Page styles changed after this edit');
    if(patch.hasAnimation) {
      const current=ownedAnimations.get(el);
      if(current?.token!==patch.afterAnimationToken) throw new Error('Preview animation changed after this edit');
      checkAnimation(current);
      patch.afterAnimation=animationSnapshot(current);
    }
    swarm.settle(el);
    if(patch.hasText) {
      if(patch.created) patch.textNodes[0].remove();
      else patch.textNodes.forEach((node,index)=> { node.nodeValue=patch.beforeText[index]; });
    }
    if(patch.hasStyles) el.style.cssText=patch.beforeCssText;
    if(patch.hasAnimation) applyAnimation(el,patch.beforeAnimation ? prepareAnimation(el,patch.beforeAnimation.config,patch.beforeAnimation,patch.beforeAnimation.token) : null);
  }
  function replayPatch(patch) {
    if(patch.sheet) {
      document.adoptedStyleSheets=[...document.adoptedStyleSheets,patch.sheet];
      if(patch.pairHost) {
        if(!patch.active()) {
          document.adoptedStyleSheets=document.adoptedStyleSheets.filter(item=>item!==patch.sheet);
          throw new Error('The elements this layout arranged have changed');
        }
        patch.watch();
      }
      for(const change of patch.texts) {
        if(change.held) continue;
        if(change.created) { if(change.host?.isConnected) change.host.appendChild(change.node); }
        else if(change.node.isConnected && change.node.nodeValue===change.before) change.node.nodeValue=change.after;
      }
      return;
    }
    const el=patch.el;
    if(patch.inserted) {
      if(!patch.container.isConnected || (patch.next && patch.next.parentNode!==patch.container)) throw new Error('The place this element was added to has changed');
      patch.container.insertBefore(el,patch.next || null);
      return;
    }
    if(resolve(patch.ref)!==el || sensitive(el)) throw new Error('The edited element is no longer there');
    if(patch.hasText && !patch.created && patch.textNodes.some((node,index)=>node.parentNode!==el || node.nodeValue!==patch.beforeText[index])) throw new Error('Page text changed since this edit was taken back');
    if(patch.hasStyles && el.style.cssText!==patch.beforeCssText) throw new Error('Page styles changed since this edit was taken back');
    swarm.settle(el);
    if(patch.hasText) {
      if(patch.created) el.appendChild(patch.textNodes[0]);
      patch.textNodes.forEach((node,index)=> { node.nodeValue=patch.afterText[index]; });
    }
    if(patch.hasStyles) el.style.cssText=patch.afterCssText;
    if(patch.hasAnimation) applyAnimation(el,patch.afterAnimation ? prepareAnimation(el,patch.afterAnimation.config,patch.afterAnimation,patch.afterAnimation.token) : null);
  }
  function textEditState(el) {
    if (sensitive(el)) return {editableText:false,editReason:'Sensitive fields cannot be edited.'};
    if (blockedTextTags.has(el.localName.toUpperCase())) return {editableText:false,editReason:'Select a plain text leaf element.'};
    if ([...el.children].some(child=>child.tagName!=='BR') || el.shadowRoot) return {editableText:false,editReason:'This element contains child elements. Select the text leaf to preserve its structure.'};
    const text=leafText(el);
    if (text.length>textLimit || clean(text,textLimit+1)!==text) return {editableText:false,editReason:'This text exceeds 20000 characters or contains sensitive content.'};
    return {editableText:true};
  }
  function validateStyles(value, animated=false) {
    if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid style changes');
    const entries=Object.entries(value);
    if (entries.length>limits.styleCount || (animated && !entries.length)) throw new Error('Invalid number of style changes');
    const output={};
    for (const [name,raw] of entries) {
      if (!(animated ? animationStyles : editableStyles).has(name) || typeof raw!=='string' || raw.length>limits.styleValueLength) throw new Error('Unsupported CSS property or value: '+name);
      const text=raw.trim();
      if ((animated && !text) || unsafeCss.test(text) || (text!=='' && !CSS.supports(name,text))) throw new Error('Unsupported CSS property or value: '+name);
      if (name==='background' || name==='background-image') for (const match of text.matchAll(/([a-z_-][a-z0-9_-]*)\s*\(/gi)) if (!backgroundFunctions.has(match[1].toLowerCase())) throw new Error('Unsupported background image function');
      output[name]=text;
    }
    return output;
  }
  function validEasing(value) {
    if (typeof value!=='string' || value.length>limits.easingLength || unsafeCss.test(value)) return false;
    const easing=value.trim().toLowerCase();
    if (/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/.test(easing)) return true;
    const bezier=easing.match(/^cubic-bezier\(([^()]*)\)$/);
    if (bezier) {
      const parts=bezier[1].split(',').map(part=>part.trim());
      const numbers=parts.map(Number);
      return parts.length===4 && parts.every(Boolean) && numbers.every(Number.isFinite) && numbers[0]>=0 && numbers[0]<=1 && numbers[2]>=0 && numbers[2]<=1 && CSS.supports('animation-timing-function',easing);
    }
    const steps=easing.match(/^steps\(\s*(\d+)\s*(?:,\s*(start|end|jump-start|jump-end|jump-none|jump-both))?\s*\)$/);
    return !!steps && Number(steps[1])>=1 && Number(steps[1])<=limits.stepsMax && !(steps[2]==='jump-none' && Number(steps[1])<2) && CSS.supports('animation-timing-function',easing);
  }
  function normalizeAnimation(value) {
    if (value===null) return null;
    if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!['keyframes','duration','iterations','easing','direction'].includes(key))) throw new Error('Invalid preview animation configuration');
    if (!Array.isArray(value.keyframes) || value.keyframes.length<limits.keyframesMin || value.keyframes.length>limits.keyframesMax) throw new Error('Animation requires 2 to 12 keyframes');
    if (typeof value.duration!=='number' || !Number.isFinite(value.duration) || value.duration<limits.durationMin || value.duration>limits.durationMax) throw new Error('Animation duration must be between 100 and 60000ms');
    const iterations=value.iterations ?? 1;
    if (iterations!=='infinite' && (typeof iterations!=='number' || !Number.isFinite(iterations) || iterations<1 || iterations>limits.iterationsMax)) throw new Error('Animation iterations must be 1 to 100 or infinite');
    const easing=value.easing ?? 'linear';
    if (!validEasing(easing)) throw new Error('Unsupported animation easing');
    const direction=value.direction ?? 'normal';
    if (!['normal','reverse','alternate','alternate-reverse'].includes(direction)) throw new Error('Invalid animation direction');
    let lastOffset=-1;
    const keyframes=value.keyframes.map(frame=> {
      if (!frame || typeof frame!=='object' || Array.isArray(frame) || Object.keys(frame).some(key=>!['offset','styles'].includes(key))) throw new Error('Invalid animation keyframe');
      if (frame.offset!==undefined) {
        if (typeof frame.offset!=='number' || !Number.isFinite(frame.offset) || frame.offset<0 || frame.offset>1 || frame.offset<lastOffset) throw new Error('Keyframe offsets must be ordered between 0 and 1');
        lastOffset=frame.offset;
      }
      return {...(frame.offset===undefined ? {} : {offset:frame.offset}),styles:validateStyles(frame.styles,true)};
    });
    return {keyframes,duration:value.duration,iterations,easing:easing.trim(),direction};
  }
  const clone = value => value===null ? null : JSON.parse(JSON.stringify(value));
  function animationSnapshot(record) {
    if (!record) return null;
    return {token:record.token,config:clone(record.config),currentTime:record.player ? record.player.currentTime : record.currentTime,playState:record.player ? record.player.playState : record.playState,playbackRate:record.player ? record.player.playbackRate : record.playbackRate};
  }
  function prepareAnimation(el,config,snapshot,token={}) {
    const record={token,config:clone(config),player:null,effect:null,currentTime:snapshot?.currentTime ?? 0,playState:snapshot?.playState || (config ? 'running' : 'idle'),playbackRate:snapshot?.playbackRate ?? 1};
    if (config && !reducedMotion.matches) {
      const frames=config.keyframes.map(frame=> {
        const result={...(frame.offset===undefined ? {} : {offset:frame.offset})};
        for (const [name,value] of Object.entries(frame.styles)) result[name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;
        return result;
      });
      record.effect=new KeyframeEffect(el,frames,{duration:config.duration,iterations:config.iterations==='infinite' ? Infinity : config.iterations,easing:config.easing,direction:config.direction,fill:'none'});
      record.player=new Animation(record.effect,document.timeline);
      record.player.id='workbench-preview:'+docId+':'+(++nextAnimationId);
      record.keyframesSignature=JSON.stringify(record.effect.getKeyframes());
      record.timingSignature=JSON.stringify(record.effect.getTiming());
    }
    return record;
  }
  function checkAnimation(record) {
    if (!record?.player) return;
    if (record.player.effect!==record.effect || JSON.stringify(record.effect.getKeyframes())!==record.keyframesSignature || JSON.stringify(record.effect.getTiming())!==record.timingSignature) throw new Error('Page animation changed after this edit; refusing to overwrite newer changes');
  }
  function applyAnimation(el,record) {
    ownedAnimations.get(el)?.player?.cancel();
    if (!record) { ownedAnimations.delete(el); return; }
    ownedAnimations.set(el,record);
    if (!record.player) return;
    record.player.playbackRate=record.playbackRate;
    if (record.playState==='running') record.player.play();
    else if (record.playState==='paused') record.player.pause();
    else if (record.playState==='finished') record.player.finish();
    if (record.playState!=='idle' && typeof record.currentTime==='number') record.player.currentTime=record.currentTime;
  }
  reducedMotion.addEventListener('change',()=> {
    for (const [el,record] of ownedAnimations) {
      if (!el.isConnected) { record.player?.cancel(); ownedAnimations.delete(el); continue; }
      if (!record.config) continue;
      const saved=animationSnapshot(record);
      applyAnimation(el,prepareAnimation(el,record.config,saved,record.token));
    }
  });
  // Observations report the page as edited, never a frame of a running edit choreography.
  const inspect = (ref,withLayout) => swarm.truth(()=>details(ref,withLayout));
  function details(ref,withLayout=false) {
    const el=resolve(ref);
    const attributes={};
    for (const attribute of el.attributes) if (attributeNames.has(attribute.name)) attributes[attribute.name]=sensitive(el) && !['type','role','disabled','readonly','tabindex'].includes(attribute.name) ? '[hidden]' : clean(attribute.value,512);
    const computed={};
    const style=getComputedStyle(el);
    for (const name of styleNames) computed[name]=clean(style.getPropertyValue(name),2000);
    const ancestors=[];
    for (let node=parent(el); node && ancestors.length<8; node=parent(node)) ancestors.push(describe(node,withLayout));
    const textContent=sensitive(el) ? '[hidden]' : el.children.length || el.shadowRoot ? safeText(el,textLimit) : clean(leafText(el),textLimit);
    const animation=ownedAnimations.get(el);
    let layout;
    if(withLayout && el.parentElement && !sensitive(el)){
      const host=el.parentElement, css=getComputedStyle(host);
      const neighbor=node=>node && !sensitive(node) && visible(node) && !overlays.has(node) && !skippedLayoutTag.test(node.localName) ? describe(node,true) : undefined;
      layout={parentDisplay:css.display,parentDirection:css.display.includes('flex') ? css.flexDirection : undefined,
        parentColumns:css.display.includes('grid') ? clean(css.gridTemplateColumns,180) : undefined,childCount:host.childElementCount,
        previous:neighbor(el.previousElementSibling),next:neighbor(el.nextElementSibling)};
    }
    return {...describe(el),semantics:semantics(el),textContent,...textEditState(el),attributes,computed,ancestors,layout,animation:animation?.config ? clone(animation.config) : null,animationState:animation?.config ? reducedMotion.matches && !animation.player ? 'reduced-motion' : animation.player?.playState || 'idle' : 'idle'};
  }
  const skippedLayoutTag=/^(script|style|template|noscript|link|meta)$/;
  function scopeText(el) {
    const row=el?.closest('tr,[role="row"],li');
    if(!row || sensitive(el)) return undefined;
    const heading=[...row.children].find(node=>node.matches('th,[role="rowheader"]') && visible(node))
      || [...row.children].find(node=>node.matches('td,[role="cell"],[role="gridcell"],h1,h2,h3,h4,h5,h6') && visible(node));
    if(!heading || sensitive(heading)) return undefined;
    const hint=safeText(heading,120,true).replace(/\s+/g,' ').trim();
    if (/\[hidden\]|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\d[ -]?){11,}/i.test(hint)) return undefined;
    return hint || undefined;
  }
  function feedbackText(value) {
    return clean(value,500).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[hidden]')
      .replace(/(?:\d[ -]?){11,}/g,'[hidden]').replace(/\s+/g,' ').trim().slice(0,240);
  }
  function visibleFeedback() {
    const messages=new Map();
    const nodes=document.querySelectorAll('[role="alert"],[role="status"]');
    for(let i=0;i<Math.min(nodes.length,24);i++) {
      const el=nodes[i], rect=el.getBoundingClientRect();
      if(overlays.has(el) || el.closest('[aria-hidden=true]') || sensitive(el) || !visible(el) ||
        rect.bottom<=0 || rect.right<=0 || rect.top>=innerHeight || rect.left>=innerWidth ||
        el.checkVisibility?.({opacityProperty:true,visibilityProperty:true})===false) continue;
      const role=el.getAttribute('role'), text=feedbackText(safeText(el,500));
      if(text) messages.set(role+'\n'+text,{role,text});
    }
    return messages;
  }
  function stopFeedback() {
    if(!feedbackWindow) return;
    feedbackWindow.observer.disconnect(); clearTimeout(feedbackWindow.timer);
    cancelAnimationFrame(feedbackWindow.frame); feedbackWindow=undefined;
  }
  function feedbackMessage(role,text) {
    const window=feedbackWindow;
    const key=role+'\n'+text;
    if(!text || !window || window.seen.has(key) || performance.now()>window.deadline) return;
    window.seen.add(key);
    send({kind:'feedback',recordingId,role,text});
    if(++window.count>=3) stopFeedback();
  }
  function flushFeedback() {
    if(!feedbackWindow) return;
    feedbackWindow.frame=0;
    for(const {role,text} of visibleFeedback().values()) feedbackMessage(role,text);
  }
  function armFeedback(event,el) {
    if(!recordingId || !event.isTrusted || !el || event.composedPath().some(node=>overlays.has(node))) return;
    if(sensitive(el)) {stopFeedback();return;}
    if(feedbackWindow) flushFeedback();
    stopFeedback();
    const observer=new MutationObserver(()=>{
      if(feedbackWindow && !feedbackWindow.frame) feedbackWindow.frame=requestAnimationFrame(flushFeedback);
    });
    feedbackWindow={interaction:++interactionSequence,seen:new Set(visibleFeedback().keys()),count:0,deadline:performance.now()+1800,observer,
      frame:0,timer:setTimeout(stopFeedback,1800)};
    observer.observe(document,{subtree:true,childList:true,characterData:true,attributes:true,
      attributeFilter:['role','class','style','aria-hidden','hidden']});
  }
  function setRecording(id,privateInputs) {
    if(recordingId!==id) stopFeedback();
    recordingId=id; privateTrial=!!privateInputs;
  }
  // Native form controls store their live values in properties and may emit one input per character.
  // Keep a baseline only for the current agent command, then draw once from the final field values.
  let fieldWatch=null;
  function fieldValue(el) {
    if(!el || sensitive(el)) return undefined;
    if(el instanceof HTMLInputElement) {
      if(['password','file','hidden'].includes(el.type)) return undefined;
      return ['checkbox','radio'].includes(el.type) ? el.checked : el.value;
    }
    if(el instanceof HTMLSelectElement) return el.multiple ? JSON.stringify([...el.selectedOptions].map(o=>o.value)) : el.value;
    if(el instanceof HTMLTextAreaElement) return el.value;
    if(el.isContentEditable) return el.textContent;
  }
  function rememberField(el) {
    if(!fieldWatch || !el || fieldWatch.before.has(el)) return;
    const value=fieldValue(el);
    if(value!==undefined) fieldWatch.before.set(el,value);
  }
  function endFields(show=false) {
    if(!fieldWatch) return false;
    const {before,touched,timer}=fieldWatch;fieldWatch=null;clearTimeout(timer);
    if(!show || source!=='agent') return false;
    const targets=[...touched].filter(el=>{
      const value=el.isConnected ? fieldValue(el) : undefined;
      return value!==undefined && before.has(el) && before.get(el)!==value;
    });
    return !!(targets.length && swarm.present({targets,script:true}));
  }
  function beginFields(only,select=false) {
    endFields();
    if(source!=='agent' || reducedMotion.matches || document.visibilityState!=='visible') return false;
    fieldWatch={before:new Map(),touched:new Set(),timer:setTimeout(endFields,30000)};
    if(only) rememberField(only);
    else {
      rememberField(document.activeElement);
      // Some drivers set selects directly, without a focus or beforeinput event.
      if(select) {
        const list=document.getElementsByTagName('select');
        for(let i=0;i<32 && list[i];i++) rememberField(list[i]);
        let roots=0;
        for(const root of observers.keys()) if(root instanceof ShadowRoot) {
          rememberField(root.querySelector('select'));
          if(++roots===8) break;
        }
      }
    }
    return true;
  }
  for(const type of ['focusin','beforeinput','pointerdown','keydown']) document.addEventListener(type,event=>{
    if(fieldWatch) rememberField(eventTarget(event));
  },true);
  document.addEventListener('invalid',event=>{
    const el=eventTarget(event);
    if(feedbackWindow && event.isTrusted && el?.validity?.valid===false && !sensitive(el) && visible(el) && typeof el.validationMessage==='string')
      feedbackMessage('alert',feedbackText(el.validationMessage));
  },true);
  document.addEventListener('click', event=> {
    const el=eventTarget(event);
    const anchor=el?.closest('a[href]');
    // Used only for transient matching to Chrome's download event; never persist this URL.
    const href=anchor && /^(https?:|blob:)/i.test(anchor.href) && anchor.href.length<=4096 ? anchor.href : undefined;
    if (!event.isTrusted && source!=='agent') {
      if(href && anchor.hasAttribute('download') && feedbackWindow && performance.now()<=feedbackWindow.deadline)
        send({kind:'download-link',href,recordingId});
      return;
    }
    armFeedback(event,el);
    const target=describe(el);
    if (target) {send({kind:'click',target,href,scopeText:scopeText(el)});if(source==='agent' && !fieldWatch) feedback(target.ref,'applied');}
  },true);
  document.addEventListener('input', event=> {
    if (!event.isTrusted && source!=='agent') return;
    const el=eventTarget(event);
    if (!el) return;
    armFeedback(event,el);
    const target=describe(el);
    const checked=event.isTrusted && el instanceof HTMLInputElement && ['checkbox','radio'].includes(el.type) && !sensitive(el) ? el.checked : undefined;
    send({kind:el.tagName==='SELECT' ? 'select' : 'fill',target,value:target.value || '',scopeText:scopeText(el),checked});
    if(fieldWatch) fieldWatch.touched.add(el);
  },true);
  document.addEventListener('change', event=> {
    if (!event.isTrusted && source!=='agent') return;
    const el=eventTarget(event);
    if(fieldWatch && el) fieldWatch.touched.add(el);
    if (el instanceof HTMLSelectElement) { const target=describe(el); send({kind:'select',target,value:target.value || '',scopeText:scopeText(el)}); }
  },true);
  document.addEventListener('keydown', event=> {
    if (!event.isTrusted && source!=='agent') return;
    if (!['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
    if(event.key==='Enter') armFeedback(event,eventTarget(event));
    send({kind:'key',target:describe(eventTarget(event)),value:event.key});
  },true);
  let scrollTimer, pendingScroll;
  function flushScroll() {
    clearTimeout(scrollTimer);
    if (pendingScroll) { send(pendingScroll); pendingScroll=undefined; }
  }
  document.addEventListener('scroll',()=> {
    clearTimeout(scrollTimer);
    pendingScroll={kind:'scroll',value:JSON.stringify({x:scrollX,y:scrollY}),source,actorId};
    scrollTimer=setTimeout(flushScroll,180);
  },true);
  const treeNodes = root => { const nodes=[]; const walk=node=>{nodes.push(node);for(const child of node.childNodes) walk(child);};walk(root);return nodes; };
  const formStates = root => [root,...root.querySelectorAll('input,textarea,select')].filter(node=>['INPUT','TEXTAREA','SELECT'].includes(node.tagName)).map(node=>({node,value:node.value,checked:node.checked,selectedIndex:node.selectedIndex}));
  function insertElement(ref,insertion) {
    if (!insertion || typeof insertion!=='object' || Array.isArray(insertion) || Object.keys(insertion).some(key=>!['position','node'].includes(key)) || JSON.stringify(insertion).length>60000) throw new Error('Invalid element structure');
    const anchor=resolve(ref), position=insertion.position || 'append';
    if (!['append','prepend','before','after'].includes(position) || sensitive(anchor) || blockedEditTags.has(anchor.tagName) || anchor.namespaceURI!=='http://www.w3.org/1999/xhtml' || anchor.isContentEditable) throw new Error('This element cannot receive a structural preview');
    const inside=position==='append' || position==='prepend';
    if (inside && ['INPUT','TEXTAREA','IMG','BR','HR'].includes(anchor.tagName)) throw new Error('This element cannot contain child elements');
    const container=inside ? anchor : anchor.parentNode;
    if (!container?.isConnected || container===document.documentElement || container===document.head) throw new Error('Choose a container inside the page body');
    let count=0, textLength=0;const newIds=new Set();
    const validate=(node,depth)=> {
      if (++count>80 || depth>8) throw new Error('Element structure is too large');
      if (!node || typeof node!=='object' || Array.isArray(node) || !insertTags.has(node.tag) || Object.keys(node).some(key=>!['tag','text','attributes','styles','children'].includes(key))) throw new Error('Only safe HTML element structures are supported');
      if(node.text!==undefined && (typeof node.text!=='string' || (textLength+=node.text.length)>textLimit || clean(node.text,textLimit+1)!==node.text)) throw new Error('Invalid or sensitive element text');
      if(node.attributes!==undefined) {
        if(!node.attributes || typeof node.attributes!=='object' || Array.isArray(node.attributes) || Object.keys(node.attributes).length>20) throw new Error('Invalid element attributes');
        if(/password|secret|token|api.?key|credit|card.?number|cvv|cvc|ssn|email|phone|mobile|address/i.test([node.attributes.type,node.attributes.id,node.attributes['aria-label']].filter(Boolean).join(' ')) || String(node.attributes.class || '').split(/\s+/).includes('rr-block')) throw new Error('Sensitive controls cannot be created as previews');
        for(const [key,value] of Object.entries(node.attributes)) {
          if(!insertAttributes.has(key) || typeof value!=='string' || value.length>4096) throw new Error('Unsupported element attribute');
          if(key==='href' || key==='src') {
            if(!(key==='src' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value))) {
              const url=new URL(value,'https://athena.invalid');
              if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) links are supported');
            }
          }
          if(key==='type' && (node.tag==='button' ? value!=='button' : node.tag!=='input' || !['text','search','number','checkbox','radio'].includes(value))) throw new Error('Unsupported input type');
          if(key==='id' && value) {
            if(newIds.has(value) || anchor.getRootNode().querySelector('#'+CSS.escape(value))) throw new Error('This element ID already exists');
            newIds.add(value);
          }
        }
      }
      if(node.styles!==undefined) validateStyles(node.styles);
      if(node.children!==undefined) {
        if(!Array.isArray(node.children)) throw new Error('Invalid child elements');
        node.children.forEach(child=>validate(child,depth+1));
      }
      if(['input','img','br','hr'].includes(node.tag) && ((node.text!==undefined && node.text!=='') || node.children?.length)) throw new Error('Void elements cannot contain children');
    };
    validate(insertion.node,1);
    const build=node=> {
      const el=document.createElement(node.tag);
      for(const [key,value] of Object.entries(node.attributes || {})) el.setAttribute(key,value);
      if(node.tag==='button') el.type='button';
      if(['input','textarea','select'].includes(node.tag)) el.setAttribute('form','athena-preview-'+docId);
      if(node.text!==undefined && !['input','img','br','hr'].includes(node.tag)) el.appendChild(document.createTextNode(node.text));
      for(const [key,value] of Object.entries(node.styles || {})) if(value) el.style.setProperty(key,value);
      for(const child of node.children || []) el.appendChild(build(child));
      if(sensitive(el)) throw new Error('Sensitive controls cannot be created as previews');
      return el;
    };
    const el=build(insertion.node);
    const before=source==='agent' ? swarm.capture(anchor,[]) : null;
    const next=position==='prepend' ? anchor.firstChild : position==='before' ? anchor : position==='after' ? anchor.nextSibling : null;
    container.insertBefore(el,next);
    const element=describe(el), editId=docId+':edit:'+(++nextEditId);
    dropFuture();patches.set(editId,{ref:element.ref,el,inserted:true,anchor,anchorRef:ref,container,nodes:treeNodes(el),after:el.cloneNode(true),fields:formStates(el)});
    editOrder.push(editId);
    send({kind:'edit',target:element,editId,value:JSON.stringify({insert:insertion})});
    if(source==='agent') el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    feedback(element.ref,'applied');
    const result={editId,element:inspect(element.ref)};
    presentElement({el,inserted:true,before});
    return result;
  }
  // A page restyle is one adopted stylesheet plus text replacements by selector. The styling
  // touches no node, so a re-render of the page keeps it, and one edit ID takes all of it back.
  const sheetLimit=60000;
  const sheetRuleKinds=new Set(['CSSStyleRule','CSSMediaRule','CSSSupportsRule','CSSContainerRule','CSSLayerBlockRule','CSSLayerStatementRule','CSSScopeRule','CSSStartingStyleRule','CSSNestedDeclarations','CSSKeyframesRule','CSSKeyframeRule']);
  // The sheet is applied without asking the user, so it must not be able to fetch anything.
  const remoteCss=/url\(\s*(?!["']?data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,])|(?:^|[^a-z-])(?:image-set|image|cross-fade|element|paint|src)\(|-webkit-(?:image-set|cross-fade)\(/i;
  function sheetRules(sheet) {
    const rules=[], pending=[...sheet.cssRules].reverse();
    while (pending.length) {
      const rule=pending.pop();
      if (rules.length>=2000) throw new Error('Too many CSS rules');
      if (!sheetRuleKinds.has(rule.constructor.name)) throw new Error('Unsupported at-rule: only style rules, @media, @supports, @container, @layer, @scope and @keyframes are allowed');
      rules.push(rule);
      // Custom properties keep their source text, where an escape could spell a function name.
      if (rule.style) for (const name of rule.style) if (name.startsWith('--') && /\\|url\(/i.test(rule.style.getPropertyValue(name))) throw new Error('Custom properties cannot contain escapes or url()');
      if (rule.cssRules) pending.push(...[...rule.cssRules].reverse());
    }
    // The parsed form is checked, not the source: escapes are resolved in it.
    if (remoteCss.test([...sheet.cssRules].map(rule=>rule.cssText).join('\n'))) throw new Error('External resources are not allowed: use colors, gradients or data:image URLs');
    return rules;
  }
  // The text nodes a replacement may write to: all of a leaf, or the single text beside child elements.
  function textSlot(el) {
    if (overlays.has(el) || sensitive(el) || blockedTextTags.has(el.localName.toUpperCase()) || el.shadowRoot || el.isContentEditable) return null;
    const nodes=[...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE);
    if (nodes.some(node=>node.nodeValue.length>textLimit || clean(node.nodeValue,textLimit+1)!==node.nodeValue)) return null;
    if (![...el.children].some(child=>child.tagName!=='BR')) return nodes;
    const filled=nodes.filter(node=>node.nodeValue.trim());
    return filled.length===1 ? filled : null;
  }
  function writeText(el,nodes,text,changed) {
    if (!nodes.length) { const node=document.createTextNode(text); el.appendChild(node); changed.push({node,after:text,created:true}); return; }
    nodes.forEach((node,index)=> {
      const before=node.nodeValue, edge=el.children.length ? [before.match(/^\s*/)[0],before.match(/\s*$/)[0]] : ['',''];
      const after=index===0 ? edge[0]+text+edge[1] : '';
      if (after!==before) { node.nodeValue=after; changed.push({node,before,after}); }
    });
  }
  function readSheetSample(el,names,pseudo) {
    const style=getComputedStyle(el,pseudo);
    return names.map(name=>style.getPropertyValue(name));
  }
  function sheetSampleChanged(el,names,before,pseudo) {
    const style=getComputedStyle(el,pseudo);
    return names.some((name,i)=>style.getPropertyValue(name)!==before[i]) ||
      el.getAnimations().some(player=>player instanceof CSSTransition && names.includes(player.transitionProperty));
  }
  async function restyle(request) {
    // Nothing is applied unless all of it is valid; a rejection says why instead of throwing.
    const refuse=(reason,more={})=>({applied:false,reason,...more});
    if (!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).some(key=>!['css','texts'].includes(key))) return refuse('Only css and texts are supported');
    const css=request.css ?? '', texts=request.texts ?? [];
    if (typeof css!=='string' || css.length>sheetLimit) return refuse('css must be a string of at most '+sheetLimit+' characters');
    if (!Array.isArray(texts) || texts.length>60) return refuse('texts must be a list of at most 60 replacements');
    let length=0;
    for (const item of texts) {
      if (!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).some(key=>!['selector','text'].includes(key)) || typeof item.selector!=='string' || !item.selector.trim() || item.selector.length>1000 || typeof item.text!=='string') return refuse('Each text replacement needs a selector and a text');
      if ((length+=item.text.length)>textLimit || clean(item.text,textLimit+1)!==item.text) return refuse('Replacement text is too long or looks like a secret');
      try { document.querySelector(item.selector); } catch { return refuse('Invalid selector: '+clean(item.selector,120)); }
    }
    let sheet, rules;
    try { sheet=new CSSStyleSheet(); sheet.replaceSync(css); rules=sheetRules(sheet); } catch (error) { return refuse(clean(error?.message || error,300)); }
    const styled=rules.filter(rule=>rule.constructor.name==='CSSStyleRule');
    if (!styled.length && !texts.length) return refuse('No style rule or text replacement was provided');
    // Which elements each rule reaches, and how a few of them look before it applies.
    const reached=new Set(), unmatched=[], dropped=[], samples=[];
    for (const rule of styled) {
      if (!rule.style.length && !rule.cssRules?.length) { if (dropped.length<20) dropped.push(clean(rule.selectorText,120)); continue; }
      const probe=rule.selectorText.replace(/::[a-z-]+(?:\([^)]*\))?/gi,'').replace(/:(?:hover|focus-visible|focus-within|focus|active|visited|target|checked|disabled|placeholder-shown)(?![\w-])/gi,'').trim() || '*';
      let found;
      try { found=[...document.querySelectorAll(probe)].filter(el=>!overlays.has(el)); } catch { continue; }
      if (!found.length) { if (unmatched.length<20) unmatched.push(clean(rule.selectorText,120)); continue; }
      for (const el of found.slice(0,2000)) reached.add(el);
      const selector=rule.selectorText.trim(), pseudo=selector.match(/(::(?:before|after|marker|placeholder))$/)?.[1];
      if ((!selector.includes('::') || (pseudo && !selector.includes(','))) && rule.style.length && samples.length<200) {
        const names=[...rule.style].slice(0,24), els=found.slice(0,3);
        samples.push({rule,names,els,pseudo,probe,report:probe===selector,before:els.map(el=>readSheetSample(el,names,pseudo))});
      }
    }
    const jobs=texts.map(item=> {
      const found=[...document.querySelectorAll(item.selector)].filter(el=>!overlays.has(el)).slice(0,200);
      return {item,found,slots:found.map(el=>[el,textSlot(el)]).filter(pair=>pair[1])};
    });
    const report=()=>jobs.map(job=>({selector:clean(job.item.selector,120),matched:job.found.length,changed:job.changed || 0,...(job.slots.length<job.found.length ? {skipped:job.found.length-job.slots.length,hint:'Target the element that directly holds the text'} : {})}));
    if (!reached.size && !jobs.some(job=>job.slots.length)) return refuse('Nothing on the page matches these selectors',{unmatched,dropped,texts:report()});
    if (source==='agent') await swarm.watch();
    document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];
    const changed=[],targets=new Set(),witnesses=[];
    for (const job of jobs) {
      job.changed=0;
      for (const [el,nodes] of job.slots) {
        const size=changed.length;
        if (el.isConnected) writeText(el,nodes,job.item.text,changed);
        if (changed.length>size) {job.changed++;targets.add(el);}
      }
    }
    const unchanged=[];
    for (const sample of samples) {
      let affected=false;
      for(const [i,el] of sample.els.entries()) {
        // A currently overridden rule may become the effective rule before someone undoes it.
        if(witnesses.length<24) witnesses.push({el,names:sample.names,selector:sample.probe,pseudo:sample.pseudo});
        if(sheetSampleChanged(el,sample.names,sample.before[i],sample.pseudo)) {affected=true;targets.add(el);}
      }
      if (!affected && sample.report && unchanged.length<20) unchanged.push(clean(sample.rule.selectorText,120));
    }
    const root=describe(document.documentElement), editId=docId+':edit:'+(++nextEditId);
    dropFuture();patches.set(editId,{ref:root.ref,el:document.documentElement,sheet,texts:changed,witnesses});
    editOrder.push(editId);
    send({kind:'edit',target:root,editId,value:JSON.stringify({sheet:css,...(texts.length ? {texts} : {})})});
    // The cursors only withhold pixels of a page that is already restyled, so the answer does not wait for them.
    if(!swarm.replay(source==='agent') && targets.size) swarm.present({actor:source,targets:[...targets]});
    return {applied:true,editId,element:root,rules:styled.length,matched:reached.size,unmatched,unchanged,dropped,texts:report()};
  }
  // Place two adjacent business elements without moving their DOM or reflowing the other children into columns.
  function layoutPair(request) {
    const refuse=reason=>({applied:false,reason});
    if(!request || !['row','column'].includes(request.direction)) return refuse('invalid_direction');
    let first,second;
    try { first=resolve(request.ref); second=request.otherRef===undefined ? null : resolve(request.otherRef); }
    catch {return refuse('stale_ref');}
    const host=first.parentElement;
    if(!host || host===document.body || host===document.documentElement || host.getRootNode()!==document ||
        host.childElementCount>16 || sensitive(first) || !visible(first)) return refuse('unsupported_parent');
    const children=[...host.children];
    if(!second) {
      if(!first.matches('h1,h2,h3,h4,h5,h6,[role="heading"]')) return refuse('subtitle_not_identified');
      const eligible=children.filter(el=>el!==first && !sensitive(el) && visible(el) && !el.matches('[role=alert],[role=status],[aria-live]'));
      const marked=eligible.filter(el=>el.matches('.intro,.subtitle,.subheading,.subheadline,[data-role="subtitle"]'));
      const candidates=marked.length ? marked : eligible.filter(el=>el.matches('p,small'));
      if(candidates.length!==1 || candidates[0]!==first.nextElementSibling) return refuse('subtitle_not_identified');
      second=candidates[0];
    }
    if(second.parentElement!==host || sensitive(second) || !visible(second)) return refuse('different_parent_or_hidden');
    if(second.nextElementSibling===first) [first,second]=[second,first];
    if(first.nextElementSibling!==second) return refuse('not_adjacent');
    const direction=request.direction, style=getComputedStyle(host);
    const boxes=()=>[first.getBoundingClientRect(),second.getBoundingClientRect()];
    const arranged=([a,b])=>{
      if(Math.min(a.width,b.width,a.height,b.height)<=0) return false;
      const overlapX=Math.min(a.right,b.right)-Math.max(a.left,b.left),overlapY=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
      return direction==='row' ? a.right<=b.left+1 && overlapY>=Math.min(a.height,b.height)/2
        : a.bottom<=b.top+1 && overlapX>=Math.min(a.width,b.width)/2;
    };
    const from=boxes();
    if(arranged(from))return {applied:false,already:true,direction};
    const previousPair=[...patches.values()].some(patch=>patch.pairHost===host);
    if(!['block','flex','grid'].includes(style.display) || style.writingMode!=='horizontal-tb' || style.direction!=='ltr' ||
      (style.display==='grid' && !previousPair && children.length>2) ||
      (style.display==='flex' && style.flexDirection!=='column' && children.length>2) ||
      [...host.childNodes].some(n=>n.nodeType===Node.TEXT_NODE && n.nodeValue.trim()) ||
      ['::before','::after'].some(pseudo=>!['none','normal'].includes(getComputedStyle(host,pseudo).content))) return refuse('complex_layout');
    const flow=children.filter(el=>visible(el));
    if(flow.some(el=>{
      const css=getComputedStyle(el); return sensitive(el) || css.position==='absolute' || css.position==='fixed' ||
        css.float!=='none' || css.order!=='0' || css.display==='contents';
    }))return refuse('complex_children');
    const peers=flow.filter(el=>el!==first && el!==second).map(el=>({el,width:el.getBoundingClientRect().width}));
    const previousOverflow=host.scrollWidth-host.clientWidth;
    const clippedY=[host,first,second].filter(el=>['clip','hidden'].includes(getComputedStyle(el).overflowY))
      .map(el=>({el,overflow:el.scrollHeight-el.clientHeight}));
    const parents=[],path=[];
    for(let node=host;node!==document.documentElement;node=node.parentElement) {
      if(!node.parentElement || path.length>=32)return refuse('unsupported_parent');
      parents.push(node.parentElement);
      path.unshift(':nth-child('+([...node.parentElement.children].indexOf(node)+1)+')');
    }
    const scope=':root > '+path.join(' > '),pairIndex=children.indexOf(first)+1;
    const align=style.display==='flex' && style.flexDirection==='column' && ['flex-end','end','center'].includes(style.justifyContent) ? style.justifyContent : 'start';
    const row=direction==='row';
    const css=scope+'{display:grid!important;grid-template-columns:'+(row ? 'repeat(2,minmax(0,1fr))':'minmax(0,1fr)')+
      '!important;grid-auto-flow:row!important;align-content:'+align+'!important;'+(row && !parseFloat(style.columnGap) ? 'column-gap:1em!important;':'')+'}'+
      scope+' > *{grid-column:1/-1!important;grid-row:auto!important}'+
      scope+' > :nth-child('+pairIndex+'){grid-column:1!important;min-width:0!important}'+
      scope+' > :nth-child('+(pairIndex+1)+'){grid-column:'+(row?'2':'1')+'!important;min-width:0!important;'+(row?'margin-block-start:0!important;align-self:start!important;':'')+'}';
    const sheet=new CSSStyleSheet();
    const remove=()=>{document.adoptedStyleSheets=document.adoptedStyleSheets.filter(other=>other!==sheet);};
    try {
      sheet.replaceSync(css);
      document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];
      const [a,b]=boxes(), limit=host.getBoundingClientRect();
      const top=Math.min(a.top,b.top),bottom=Math.max(a.bottom,b.bottom);
      if(!arranged([a,b]) || Math.min(a.left,b.left)<limit.left-1 || Math.max(a.right,b.right)>limit.right+1 ||
        host.scrollWidth-host.clientWidth>Math.max(1,previousOverflow+1) ||
        clippedY.some(({el,overflow})=>el.scrollHeight-el.clientHeight>overflow+1) ||
        [first,second].some(el=>el.scrollWidth>el.clientWidth+1) ||
        peers.some(({el,width})=>{
          const r=el.getBoundingClientRect();
          return Math.abs(r.width-width)>1 || (children.indexOf(el)<pairIndex-1 ? r.bottom>top+1 : r.top<bottom-1);
        })) {remove();return refuse('geometry_not_verified');}
    }catch{remove();return refuse('layout_not_applied');}
    const root=describe(document.documentElement),id=docId+':edit:'+(++nextEditId);
    const active=()=>host.isConnected && host.matches(scope) && children.length===host.childElementCount &&
      children.every((el,i)=>host.children[i]===el) && document.adoptedStyleSheets.includes(sheet);
    const guard=new MutationObserver(records=>{
      const detached=records.some(record=>[...record.removedNodes].some(node=>
        node===first || node===second || node===host || (node.nodeType===Node.ELEMENT_NODE && node.contains(host))));
      if(!detached && active()) return;
      guard.disconnect();remove();patches.delete(id);
      const at=editOrder.indexOf(id);if(at>=0)editOrder.splice(at,1);
      send({kind:'layout-invalidated',editId:id});
    });
    const watch=()=>{for(const node of [document,host,...parents])guard.observe(node,{childList:true});};
    watch();
    const pair=[first,second];
    dropFuture();patches.set(id,{ref:root.ref,el:document.documentElement,sheet,texts:[],pairHost:host,pair,guard,active,watch});
    editOrder.push(id);
    send({kind:'edit',target:root,editId:id,value:JSON.stringify({sheet:css})});
    feedback(request.ref,'applied');
    swarm.present({actor:source,targets:pair,from});
    return {applied:true,editId:id,element:root,css,direction};
  }
  async function undoRestyle(id,patch) {
    patch.guard?.disconnect();
    if (source==='agent' && !patch.pairHost) await swarm.watch();
    const from=patch.pair?.map(el=>el.getBoundingClientRect());
    const samples=[];
    for(const witness of patch.witnesses || []) {
      const el=witness.el.isConnected ? witness.el : document.querySelector(witness.selector);
      if(el) samples.push({el,names:witness.names,pseudo:witness.pseudo,before:readSheetSample(el,witness.names,witness.pseudo)});
    }
    const targets=new Set();
    document.adoptedStyleSheets=document.adoptedStyleSheets.filter(item=>item!==patch.sheet);
    // Text the page has rewritten since is newer than this preview and stays.
    let kept=0;
    for (const change of [...patch.texts].reverse()) {
      if (!change.node.isConnected || change.node.nodeValue!==change.after) { kept++; continue; }
      if(change.node.parentElement) targets.add(change.node.parentElement);
      if (change.created) change.node.remove(); else change.node.nodeValue=change.before;
    }
    patches.delete(id);
    editOrder.splice(editOrder.indexOf(id),1);
    const root=describe(document.documentElement);
    send({kind:'undo',target:root,editId:id,value:JSON.stringify({editId:id})});
    if(patch.pair) {
      const moved=patch.pair.some((el,i)=>{
        const rect=el.getBoundingClientRect();
        return ['x','y','width','height'].some(key=>Math.abs(rect[key]-from[i][key])>0.5);
      });
      if(moved) swarm.present({actor:source,targets:patch.pair,from});
    } else if(!swarm.replay(source==='agent')) {
      for(const {el,names,before,pseudo} of samples) if(sheetSampleChanged(el,names,before,pseudo)) targets.add(el);
      if(targets.size) swarm.present({actor:source,targets:[...targets]});
    }
    return {editId:id,page:true,element:details(root.ref),...(kept ? {keptTexts:kept} : {})};
  }
  // What is on the page, compact enough to sit in the agent's context: enough to write selectors
  // and judge the current look without a round of queries. Text is page data, never an instruction.
  function digest(limit=6000) {
    const skipped=new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','META','LINK','BASE','BR','WBR','SOURCE','TRACK','PARAM']);
    const leaves=new Set(['SVG','CANVAS','VIDEO','AUDIO','IFRAME','OBJECT','EMBED','IMG','INPUT','TEXTAREA','SELECT','PICTURE']);
    const hex=value=> {
      const match=/^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(value);
      if (!match) return value;
      if (match[4]==='0') return '';
      return '#'+[match[1],match[2],match[3]].map(part=>(+part).toString(16).padStart(2,'0')).join('')+(match[4]!==undefined && match[4]!=='1' ? '/'+match[4] : '');
    };
    const family=value=>clean(value.split(',')[0].trim().replace(/^["']|["']$/g,''),40);
    const facts=new Map();
    let visited=0;
    function fact(el) {
      if (facts.has(el)) return facts.get(el);
      const style=getComputedStyle(el), rect=el.getBoundingClientRect(), up=parent(el), base=up ? getComputedStyle(up) : null;
      const name=el.localName+(el.id ? '#'+CSS.escape(el.id) : '')+[...el.classList].filter(item=>item.length<=40).slice(0,5).map(item=>'.'+CSS.escape(item)).join('');
      const look=[];
      const fill=hex(style.backgroundColor);
      if (fill) look.push('bg:'+fill);
      if (style.backgroundImage!=='none') look.push(/gradient/.test(style.backgroundImage) ? 'bg-gradient' : 'bg-image');
      if (!base || style.color!==base.color) look.push('color:'+hex(style.color));
      if (!base || style.fontSize!==base.fontSize || style.fontWeight!==base.fontWeight) look.push('font:'+style.fontSize+'/'+style.fontWeight);
      if (!base || style.fontFamily!==base.fontFamily) look.push('family:'+family(style.fontFamily));
      if (style.borderTopLeftRadius!=='0px') look.push('radius:'+style.borderTopLeftRadius);
      if (style.borderTopStyle!=='none' && style.borderTopWidth!=='0px') look.push('border:'+style.borderTopWidth+' '+hex(style.borderTopColor));
      if (style.boxShadow!=='none') look.push('shadow');
      if (style.padding && style.padding!=='0px') look.push('pad:'+style.padding);
      if (/flex|grid/.test(style.display)) look.push(style.display);
      if (style.position==='fixed' || style.position==='sticky') look.push(style.position);
      const hidden=sensitive(el), own=hidden ? '' : clean(leafText(el).replace(/\s+/g,' ').trim(),48);
      const value={name,look:look.join('; '),text:own,size:Math.round(rect.width)+'x'+Math.round(rect.height),leaf:leaves.has(el.localName.toUpperCase()) || !!el.shadowRoot,key:el.localName+'.'+[...el.classList].join('.')};
      facts.set(el,value);
      return value;
    }
    // Children that take part in layout; a display:contents wrapper stands for its own children.
    function kids(el,depth=0) {
      const out=[];
      for (const child of el.children) {
        if (overlays.has(child) || skipped.has(child.localName.toUpperCase())) continue;
        if (depth<4 && getComputedStyle(child).display==='contents') out.push(...kids(child,depth+1));
        else if (visible(child)) out.push(child);
      }
      return out;
    }
    function render(maxDepth,maxKids) {
      const lines=[];
      visited=0;
      function walk(el,depth) {
        if (++visited>4000) return;
        const item=fact(el), children=item.leaf ? [] : kids(el);
        lines.push('  '.repeat(depth)+item.name+(children.length ? ' ['+item.size+']' : '')+(item.text ? ' "'+item.text+'"' : '')+(item.look ? ' {'+item.look+'}' : '')+(children.length && depth>=maxDepth ? ' … '+children.length+' children' : ''));
        if (depth>=maxDepth) return;
        let shown=0;
        for (let index=0; index<children.length; index++) {
          if (shown>=maxKids) { lines.push('  '.repeat(depth+1)+'… +'+(children.length-index)+' more'); break; }
          const key=fact(children[index]).key;
          let run=1;
          while (index+run<children.length && fact(children[index+run]).key===key) run++;
          walk(children[index],depth+1); shown++;
          if (run>2) { lines.push('  '.repeat(depth+1)+'× '+(run-1)+' more like '+fact(children[index]).name); index+=run-1; }
        }
      }
      if (document.body) walk(document.body,0);
      return lines.join('\n');
    }
    const head=['viewport '+innerWidth+'x'+innerHeight+', document height '+Math.round(document.documentElement.scrollHeight)+', scrolled to '+Math.round(scrollY)];
    const page=getComputedStyle(document.documentElement);
    head.push('html {'+['bg:'+(hex(page.backgroundColor) || 'none'),'color:'+hex(page.color),'font:'+page.fontSize+'/'+page.fontWeight,'family:'+family(page.fontFamily)].join('; ')+'}');
    const tokens=[];
    let scanned=0;
    try {
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules=sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
          if (++scanned>3000 || tokens.length>=40) break;
          if (!rule.style || !/^(?::root|html)$/i.test((rule.selectorText || '').trim())) continue;
          for (const name of rule.style) if (name.startsWith('--') && tokens.length<40) tokens.push(name+': '+clean(rule.style.getPropertyValue(name).trim(),40));
        }
      }
    } catch {}
    if (tokens.length) head.push(':root variables: '+tokens.join('; '));
    const room=Math.max(500,limit-head.join('\n').length-1);
    let body='';
    for (const [depth,count] of [[14,40],[10,24],[8,16],[6,12],[5,8],[4,6],[3,5],[2,4]]) {
      body=render(depth,count);
      if (body.length<=room) break;
    }
    return head.join('\n')+'\n'+(body.length>room ? body.slice(0,room)+'\n…' : body);
  }
  globalThis.__workbenchPage = {
    setRecording,flushFeedback,
    docId,
    setActor(value) { if(actorId!==value) flushScroll(); actorId=value; },
    flushScroll,
    setSource(value) {
      if (source==='agent' && value!=='agent') {scriptWatchVersion++;endFields();}
      source=value==='agent' ? 'agent' : 'human';
    },
    setInspect(value) { inspecting=!!value;hoverPoint=null;hoverElement=null;refreshOverlays(); },
    leave() { hoverPoint=null;hoverElement=null;refreshOverlays(); },
    feedback,
    // A guide outlives clearOverlays: it ends when the host says so or the document goes away.
    guideShow(step) { return guide.show(step); },
    guideState() { return guide.state(); },
    guideClear(farewell) { guide.clear(farewell); return true; },
    async watchScript(targetsOnly=false) {
      const version=++scriptWatchVersion;
      if (source!=='agent') return false;
      if(targetsOnly==='fields' || targetsOnly==='select') return beginFields(null,targetsOnly==='select');
      let covered=false;
      if (!targetsOnly) {
        try { covered=await swarm.watch(); } catch { swarm.replay(false); }
      }
      if (version!==scriptWatchVersion || source!=='agent') return false;
      // Also keep targets for a slow script that outlives the visual cover.
      const tracking=swarm.watchTargets();
      return covered || tracking;
    },
    replayScript(show=true,reportMode=false) {
      if(fieldWatch) {
        const played=endFields(show);
        return reportMode && played ? 'targets' : played;
      }
      if (source!=='agent' || !show) { swarm.finishScript(); return false; }
      const covered=swarm.hasScriptCover;
      let mode=false;
      if (swarm.replay(covered)>0) {
        swarm.replayTargets(false);
        mode='cover';
      } else if (swarm.replayTargets(true,covered)>0) mode='targets';
      return reportMode ? mode : !!mode;
    },
    finishScript() { scriptWatchVersion++; endFields(); swarm.finishScript(); },
    stopPresentation() { scriptWatchVersion++; endFields(); swarm.interrupt(); },
    clearOverlays() {
      scriptWatchVersion++;
      endFields();
      swarm.settle();
      inspecting=false;hoverPoint=null;hoverElement=null;selectedElement=null;feedbackElement=null;feedbackPhase=null;clearTimeout(feedbackTimer);
      cancelAnimationFrame(overlayFrame);overlayFrame=0;overlayHost?.remove();
      cursorMotion?.cancel();cursorTarget=null;feedbackAgent=false;
    },
    snapshot() {
      const {found,truncated}=scan();
      const candidates=found.filter(el=>visible(el) && !['HTML','HEAD','BODY','SCRIPT','STYLE','META','LINK','NOSCRIPT','TEMPLATE'].includes(el.localName.toUpperCase()));
      return {documentId:docId,url:location.href,title:document.title,text:safeText(document.body,4000),elements:candidates.slice(0,160).map(describe),truncated:truncated || candidates.length>160};
    },
    query(query={}) {
      if (!query || typeof query!=='object' || Array.isArray(query)) throw new Error('Invalid element query');
      for (const name of ['selector','text','role']) if (query[name]!==undefined && (typeof query[name]!=='string' || query[name].length>1000)) throw new Error('Invalid query '+name);
      if (query.selector) { try { document.querySelector(query.selector); } catch { throw new Error('Invalid CSS selector'); } }
      if (query.limit!==undefined && (!Number.isInteger(query.limit) || query.limit<1 || query.limit>200)) throw new Error('Query limit must be between 1 and 200');
      const limit=query.limit || 80;
      const {found,truncated}=scan();
      const result=[];
      const normalized=value=>String(value).replace(/\s+/g,' ').trim();
      for (const el of found) {
        if (['HTML','HEAD','BODY','SCRIPT','STYLE','META','LINK','NOSCRIPT','TEMPLATE'].includes(el.localName.toUpperCase()) && !query.selector) continue;
        if (query.selector && !el.matches(query.selector)) continue;
        if (!query.selector && !visible(el)) continue;
        if (query.role && role(el)!==query.role) continue;
        if (query.text!==undefined) {
          if (sensitive(el)) continue;
          if (!query.selector && !query.role && el.children.length && ![...el.childNodes].some(node=>node.nodeType===Node.TEXT_NODE && node.nodeValue.trim())) continue;
          const text=normalized(safeText(el,4000));
          const wanted=normalized(query.text);
          if (query.exact ? text!==wanted : !text.includes(wanted)) continue;
        }
        result.push(el);
        if (result.length>limit) break;
      }
      return {documentId:docId,elements:result.slice(0,limit).map(el=>({...describe(el),...textEditState(el)})),truncated:truncated || result.length>limit};
    },
    inspect,
    mention(ref) { return swarm.truth(()=>describe(resolve(ref))); },
    reveal(ref) {
      const el=resolve(ref);
      el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      return describe(el);
    },
    atPoint(x,y) { const el=atPoint(x,y); return el ? describe(el) : null; },
    // Counts only: what kinds of things the page holds, never what they say.
    facts() {
      const shown=el=>{const box=el.getBoundingClientRect();return box.width>1 && box.height>1;};
      const fields=[...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]),textarea,select')].filter(shown);
      const body=document.body?.innerText || '';
      return {
        fields:fields.length,
        password:fields.some(el=>el.type==='password'),
        tables:[...document.querySelectorAll('table')].filter(el=>el.rows.length>=3 && shown(el)).length,
        paragraphs:[...document.querySelectorAll('p')].filter(el=>(el.textContent || '').trim().length>80).length,
        characters:body.length,
        headings:[...document.querySelectorAll('h1,h2')].filter(shown).length,
        prices:(body.match(/[¥￥$€£]\s?\d[\d,.]*/g) || []).length,
      };
    },
    node(ref) { return resolve(ref); },
    previewStyles(request) {
      const el=resolve(request.ref);
      swarm.settle(el);
      // Direct manipulation must show the real color, without a previous success wash.
      if(feedbackElement===el) { clearTimeout(feedbackTimer);feedbackElement=null;feedbackPhase=null;refreshOverlays(); }
      if (sensitive(el) || blockedEditTags.has(el.localName.toUpperCase())) throw new Error('Sensitive or executable elements cannot be edited');
      const styles=validateStyles(request.styles);
      if(source==='human' && el===selectedElement && !selectionResting) {selectionResting=true;refreshOverlays();}
      let patch=request.editId ? patches.get(request.editId) : undefined;
      if (request.editId && (!patch || !patch.transient || patch.el!==el || patch.ref!==request.ref || editOrder.at(-1)!==request.editId)) throw new Error('The preview gesture is stale');
      if (patch && el.style.cssText!==patch.afterCssText) throw new Error('Page styles changed during this gesture; refusing to overwrite newer changes');
      const editId=request.editId || docId+':edit:'+(++nextEditId);
      if (!patch) {
        patch={ref:request.ref,el,hasStyles:true,beforeCssText:el.style.cssText,transient:true,styles:{},firstStyles:new Map()};
        dropFuture();patches.set(editId,patch);editOrder.push(editId);
      }
      const fresh=Object.keys(styles).filter(name=>!patch.firstStyles.has(name));
      if(fresh.length) readSheetSample(el,fresh).forEach((value,i)=>patch.firstStyles.set(fresh[i],value));
      for (const [name,value] of Object.entries(styles)) value==='' ? el.style.removeProperty(name) : el.style.setProperty(name,value);
      Object.assign(patch.styles,styles);patch.afterCssText=el.style.cssText;
      return {editId};
    },
    commitStyles(editId) {
      const patch=patches.get(editId);
      if (!patch || !patch.transient) throw new Error('No active preview gesture');
      const el=resolve(patch.ref);
      if (el!==patch.el || el.style.cssText!==patch.afterCssText) throw new Error('Page styles changed during this gesture; refusing to overwrite newer changes');
      patch.transient=false;
      if(source==='human' && el===selectedElement) selectionResting=true;
      send({kind:'edit',target:describe(el),editId,value:JSON.stringify({styles:patch.styles})});
      const result={editId,element:inspect(patch.ref)};
      if(patch.beforeCssText!==patch.afterCssText && sheetSampleChanged(el,[...patch.firstStyles.keys()],[...patch.firstStyles.values()])) swarm.present({actor:source,targets:[el]});
      delete patch.firstStyles;
      return result;
    },
    edit(request) {
      if (!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).some(key=>!['ref','text','styles','animation','insert'].includes(key))) throw new Error('Only supported preview changes can be edited');
      if(request.insert!==undefined) {
        if(Object.keys(request).some(key=>!['ref','insert'].includes(key))) throw new Error('Insert an element first, then edit its returned reference');
        return insertElement(request.ref,request.insert);
      }
      const el=resolve(request.ref);
      if (sensitive(el) || blockedEditTags.has(el.localName.toUpperCase())) throw new Error('Sensitive or executable elements cannot be edited');
      const hasText=Object.hasOwn(request,'text');
      if (hasText && (typeof request.text!=='string' || request.text.length>textLimit || clean(request.text,textLimit+1)!==request.text)) throw new Error('Invalid or sensitive replacement text');
      if (hasText) { const state=textEditState(el); if (!state.editableText) throw new Error(state.editReason); }
      const styles=request.styles===undefined ? {} : validateStyles(request.styles);
      const entries=Object.entries(styles);
      const hasAnimation=Object.hasOwn(request,'animation');
      if (!hasText && !entries.length && !hasAnimation) throw new Error('No preview changes were provided');
      const animation=hasAnimation ? normalizeAnimation(request.animation) : undefined;
      if (hasAnimation) checkAnimation(ownedAnimations.get(el));
      const beforeAnimation=hasAnimation ? animationSnapshot(ownedAnimations.get(el)) : undefined;
      const prepared=hasAnimation ? prepareAnimation(el,animation) : undefined;
      const textNodes=hasText ? [...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE) : [];
      const beforeText=textNodes.map(node=>node.nodeValue);
      const created=hasText && textNodes.length===0;
      const beforeCssText=el.style.cssText;
      const textChanged=hasText && ((beforeText[0] ?? '')!==request.text || beforeText.slice(1).some(Boolean));
      const animationChanged=hasAnimation && (!!animation || !!beforeAnimation?.config);
      const styleKeys=entries.filter(([key,value])=>el.style.getPropertyValue(key)!==value || !!el.style.getPropertyPriority(key)).map(([key])=>key);
      const mayChange=textChanged || animationChanged || styleKeys.length>0;
      // What is on screen now, possibly mid-way through an earlier edit, is where this one starts.
      const before=source==='agent' && mayChange ? swarm.capture(swarm.reveal(el),Object.keys(styles)) : null;
      if(mayChange) swarm.settle(el);
      const previousStyles=styleKeys.length ? readSheetSample(el,styleKeys) : [];
      if (created) { const node=document.createTextNode(''); el.appendChild(node); textNodes.push(node); }
      if (hasText) textNodes.forEach((node,index)=> { node.nodeValue=index===0 ? request.text : ''; });
      for (const [name,value] of entries) value==='' ? el.style.removeProperty(name) : el.style.setProperty(name,value);
      if (hasAnimation) applyAnimation(el,prepared);
      const editId=docId+':edit:'+(++nextEditId);
      const afterText=textNodes.map(node=>node.nodeValue),afterCssText=el.style.cssText;
      const changed=textChanged || animationChanged || (beforeCssText!==afterCssText && sheetSampleChanged(el,styleKeys,previousStyles));
      dropFuture();patches.set(editId,{ref:request.ref,el,textNodes,textStructure:[...el.childNodes],beforeText,created,hasText,afterText,hasStyles:entries.length>0,beforeCssText,afterCssText,hasAnimation,beforeAnimation,afterAnimationToken:prepared?.token,contentChanged:textChanged || animationChanged});
      editOrder.push(editId);
      send({kind:'edit',target:describe(el),editId,value:JSON.stringify({...(hasText ? {text:request.text} : {}),...(entries.length ? {styles} : {}),...(hasAnimation ? {animation} : {})})});
      if(changed) feedback(request.ref,'applied');
      if(source==='human' && el===selectedElement) selectionResting=true;
      const result={editId,element:inspect(request.ref)};
      if(changed) presentElement({el,before,text:hasText && request.text ? textNodes[0] : null,was:beforeText[0],animation:!!animation});
      return result;
    },
    restyle,
    layoutPair,
    timeline: timelineState,
    scrub(position) {
      const ids=timelineIds(), target=Math.trunc(Number(position));
      if(!Number.isFinite(target) || target<0 || target>ids.length) throw new Error('Invalid timeline position');
      if(ids.length!==editOrder.length) throw new Error('A preview gesture is in progress');
      let current=ids.length-rewound, blocked;
      try {
        while(current>target) { rewindPatch(patches.get(ids[current-1])); current--; }
        while(current<target) { replayPatch(patches.get(ids[current])); current++; }
      } catch (error) { blocked=clean(error?.message || error,200); }
      rewound=ids.length-current;
      refreshOverlays();
      reportTimeline();
      return {...timelineState(),...(blocked ? {blocked} : {})};
    },
    layoutPairActive(id) { return patches.get(id)?.active?.()===true; },
    digest: limit=>swarm.truth(()=>digest(limit)),
    undo(editId) {
      dropFuture();
      const id=editId===undefined ? editOrder[editOrder.length-1] : editId;
      const patch=patches.get(id);
      if (!patch) throw new Error('No active edit with this ID exists in the current document');
      if (patch.sheet) return undoRestyle(id,patch);
      const el=resolve(patch.ref);
      if (el!==patch.el || sensitive(el)) throw new Error('The edited element is no longer safe to restore');
      if(patch.inserted) {
        const anchor=resolve(patch.anchorRef), nodes=treeNodes(el);
        if(anchor!==patch.anchor || el.parentNode!==patch.container || !el.isEqualNode(patch.after) || nodes.length!==patch.nodes.length || nodes.some((node,index)=>node!==patch.nodes[index]) || patch.fields.some(field=>field.node.value!==field.value || field.node.checked!==field.checked || field.node.selectedIndex!==field.selectedIndex)) throw new Error('Created content changed after this preview; refusing to remove newer changes');
        if(editOrder.slice(editOrder.indexOf(id)+1).some(key=>{const newer=patches.get(key);return newer && el.contains(newer.el);})) throw new Error('Undo newer changes to the created elements first');
        if(source==='agent') swarm.reveal(el);
        // The parent stays where it is when a child goes, so it tells how far the page moved.
        const near=parent(el) || anchor, before=source==='agent' ? swarm.capture(near,[]) : null, gone=el.getBoundingClientRect();
        swarm.settle(el);
        el.remove();patches.delete(id);editOrder.splice(editOrder.indexOf(id),1);
        send({kind:'undo',target:describe(anchor),editId:id,value:JSON.stringify({editId:id})});
        feedback(patch.anchorRef,'applied');
        const result={editId:id,element:inspect(patch.anchorRef)};
        presentElement({gone,before,near});
        return result;
      }
      if (patch.hasText) {
        const current=[...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE);
        const structure=[...el.childNodes];
        if (structure.length!==patch.textStructure.length || structure.some((node,index)=>node!==patch.textStructure[index]) || current.length!==patch.textNodes.length || current.some((node,index)=>node!==patch.textNodes[index] || node.nodeValue!==patch.afterText[index])) throw new Error('Page text changed after this edit; refusing to overwrite newer changes');
      }
      if (patch.hasStyles && el.style.cssText!==patch.afterCssText) throw new Error('Page styles changed after this edit; refusing to overwrite newer changes');
      let restoredAnimation;
      if (patch.hasAnimation) {
        const current=ownedAnimations.get(el);
        if (current?.token!==patch.afterAnimationToken) throw new Error('Preview animation changed after this edit; undo the newer animation first');
        checkAnimation(current);
        restoredAnimation=patch.beforeAnimation ? prepareAnimation(el,patch.beforeAnimation.config,patch.beforeAnimation,patch.beforeAnimation.token) : null;
      }
      const styleKeys=patch.hasStyles && patch.beforeCssText!==patch.afterCssText ? swarm.inline(el,patch.beforeCssText) : [];
      const mayChange=!patch.transient && (patch.contentChanged || styleKeys.length>0);
      const before=source==='agent' && mayChange ? swarm.capture(swarm.reveal(el),styleKeys) : null;
      if(mayChange) swarm.settle(el);
      const previousStyles=mayChange && styleKeys.length ? readSheetSample(el,styleKeys) : [];
      if (patch.hasText) {
        if (patch.created) patch.textNodes[0].remove();
        else patch.textNodes.forEach((node,index)=> { node.nodeValue=patch.beforeText[index]; });
      }
      if (patch.hasStyles) el.style.cssText=patch.beforeCssText;
      if (patch.hasAnimation) applyAnimation(el,restoredAnimation);
      patches.delete(id);
      editOrder.splice(editOrder.indexOf(id),1);
      send({kind:'undo',target:describe(el),editId:id,value:JSON.stringify({editId:id})});
      const changed=mayChange && (patch.contentChanged || sheetSampleChanged(el,styleKeys,previousStyles));
      if(changed) feedback(patch.ref,'applied');
      const result={editId:id,element:inspect(patch.ref)};
      if(changed) presentElement({el,before,text:patch.hasText && !patch.created ? patch.textNodes.find(node=>node.nodeValue) : null,was:patch.afterText?.[0],animation:!!restoredAnimation});
      return result;
    },
    bounds(ref) {
      const el=resolve(ref); el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      const rect=el.getBoundingClientRect();
      if (rect.width<=0 || rect.height<=0) throw new Error('Element is not visible');
      const hit=atPoint(rect.x+rect.width/2,rect.y+rect.height/2);
      let inside=false;
      for (let node=hit; node; node=parent(node)) if (node===el) { inside=true; break; }
      if (!inside) throw new Error('Element is covered by another page element');
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,tag:el.localName,disabled:!!el.disabled};
    },
    focus(ref) {
      const el=resolve(ref);
      if (!['INPUT','TEXTAREA'].includes(el.tagName) || ['file','checkbox','radio','button','submit','hidden'].includes(el.type)) throw new Error('This element is not a supported text input');
      if (el.disabled || el.readOnly) throw new Error('Input is not editable');
      el.scrollIntoView({block:'center',behavior:'instant'}); el.focus(); el.select();
      beginFields(el);
    },
    select(ref,value) {
      const el=resolve(ref);
      if (!(el instanceof HTMLSelectElement) || el.disabled) throw new Error('This element is not an enabled select');
      if (![...el.options].some(option=>option.value===value)) throw new Error('The requested option does not exist');
      beginFields(el);
      el.value=value; el.dispatchEvent(new Event('input',{bubbles:true,composed:true})); el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      endFields(true);
    },
    outline(ref) {
      const next=ref ? resolve(ref) : null;
      if(next!==selectedElement) selectionResting=false;
      selectedElement=next;refreshOverlays();
    },
    // Page content for native web tools: readable text, not the accessibility tree.
    read(options={}) {
      const format=options.format || 'markdown';
      const plain=format==='text';
      const limit=100000;
      const marked=el=>el.hasAttribute('data-private') || el.hasAttribute('data-sensitive') || el.classList.contains('rr-block') || el.getAttribute('type')==='password';
      let roots=[document.body || document.documentElement];
      if (options.selector) {
        try { document.querySelector(options.selector); } catch { throw new Error('Invalid CSS selector'); }
        const matches=scan().found.filter(el=>el.matches(options.selector));
        roots=matches.filter(el=>!matches.some(other=>other!==el && other.contains(el)));
        if (!roots.length) return {matched:false,text:'',truncated:false};
      }
      const inView=el=>{
        if (!options.viewportOnly) return true;
        const rect=el.getBoundingClientRect();
        return (rect.width===0 && rect.height===0) || (rect.bottom>0 && rect.right>0 && rect.top<innerHeight && rect.left<innerWidth);
      };
      const out=[];
      let length=0, truncated=false;
      const emit=text=>{ if (!text) return; if (length>limit) { truncated=true; return; } out.push(text); length+=text.length; };
      if (format==='links') {
        const seen=new Set();
        for (const root of roots) for (const el of [root,...scan().found.filter(item=>item!==root && root.contains(item))]) {
          if (el.localName!=='a' || !el.href || !visible(el) || !inView(el)) continue;
          const label=safeText(el,300).replace(/\s+/g,' ').trim() || el.getAttribute('aria-label') || el.title || '';
          const key=label+'\n'+el.href;
          if (seen.has(key)) continue;
          seen.add(key);
          emit('- ['+label+']('+el.href+')\n');
        }
        return {matched:true,text:clean(out.join('').trim(),limit),truncated};
      }
      const blocks=new Set(['block','flex','grid','list-item','table','table-row','flow-root']);
      const skipped=new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','IFRAME','OBJECT','EMBED','SVG','CANVAS','VIDEO','AUDIO','TEXTAREA','INPUT','SELECT','BUTTON']);
      function visit(node,state,depth) {
        if (!node || truncated || depth>256) return;
        if (node.nodeType===Node.TEXT_NODE) {
          const value=node.nodeValue || '';
          emit(state.pre ? value : value.replace(/\s+/g,' '));
          return;
        }
        if (!(node instanceof Element) || overlays.has(node) || marked(node)) return;
        const tag=node.localName.toUpperCase();
        if (tag==='BUTTON') { if (inView(node)) { const label=safeText(node,200).replace(/\s+/g,' ').trim(); if (label) emit(plain ? label+' ' : '['+label+'] '); } return; }
        if (skipped.has(tag)) return;
        const style=getComputedStyle(node);
        if (style.display==='none' || style.visibility==='hidden' || !inView(node)) return;
        const children=()=>{
          if (node instanceof HTMLSlotElement) { const assigned=node.assignedNodes({flatten:true}); for (const child of assigned.length ? assigned : node.childNodes) visit(child,state,depth+1); }
          else if (node.shadowRoot) { observe(node.shadowRoot); for (const child of node.shadowRoot.childNodes) visit(child,state,depth+1); }
          else for (const child of node.childNodes) visit(child,state,depth+1);
        };
        if (tag==='BR') { emit('\n'); return; }
        if (tag==='HR') { emit(plain ? '\n' : '\n\n---\n\n'); return; }
        if (tag==='IMG') { if (options.includeImages && !plain) emit('!['+(node.alt || '')+']('+(node.currentSrc || node.src || '')+')'); else if (node.alt) emit(node.alt); return; }
        if (plain) { children(); if (blocks.has(style.display) || tag==='TD' || tag==='TH') emit(tag==='TD' || tag==='TH' ? '\t' : '\n'); return; }
        if (/^H[1-6]$/.test(tag)) { emit('\n\n'+'#'.repeat(Number(tag[1]))+' '); children(); emit('\n\n'); return; }
        if (tag==='A' && node.href && options.includeLinks!==false) { emit('['); children(); emit(']('+node.href+')'); return; }
        if (tag==='STRONG' || tag==='B') { emit('**'); children(); emit('**'); return; }
        if (tag==='EM' || tag==='I') { emit('*'); children(); emit('*'); return; }
        if (tag==='CODE' && !state.pre) { emit('\x60'); children(); emit('\x60'); return; }
        if (tag==='PRE') { emit('\n\n\x60\x60\x60\n'); const saved=state.pre; state.pre=true; children(); state.pre=saved; emit('\n\x60\x60\x60\n\n'); return; }
        if (tag==='LI') {
          const list=node.parentElement;
          emit('\n'+'  '.repeat(Math.max(0,state.list-1))+(list && list.localName==='ol' ? ([...list.children].indexOf(node)+1)+'. ' : '- '));
          children(); return;
        }
        if (tag==='UL' || tag==='OL') { state.list++; children(); state.list--; emit('\n'); return; }
        if (tag==='BLOCKQUOTE') { emit('\n\n> '); children(); emit('\n\n'); return; }
        if (tag==='TR') {
          emit('\n|');
          const cells=[...node.children].filter(cell=>cell.localName==='td' || cell.localName==='th');
          for (const cell of cells) { emit(' '); const saved=state.cell; state.cell=true; visit(cell,state,depth+1); state.cell=saved; emit(' |'); }
          if (cells.length && cells.every(cell=>cell.localName==='th')) emit('\n|'+' --- |'.repeat(cells.length));
          return;
        }
        if (tag==='TABLE') { emit('\n'); children(); emit('\n\n'); return; }
        children();
        if (blocks.has(style.display) && !state.cell) emit(tag==='P' ? '\n\n' : '\n');
      }
      for (const root of roots) { visit(root,{pre:false,list:0,cell:false},0); emit('\n\n'); }
      const text=out.join('').replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+(?=\S)/g,match=>match.includes('  ') && /^\n +$/.test(match) ? match : '\n').replace(/\n{3,}/g,'\n\n').trim();
      return {matched:true,text:clean(text,limit),truncated};
    },
    // Resolves true once the document stops changing for "idle" ms, false when it never does.
    quiet(idle=80,timeout=600) {
      return new Promise(resolve=>{
        const started=performance.now();
        let last=started;
        const observer=new MutationObserver(records=>{ if (records.some(record=>!overlays.has(record.target) && ![...record.addedNodes,...record.removedNodes].some(node=>overlays.has(node)))) last=performance.now(); });
        observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
        const tick=()=>{
          const now=performance.now();
          if (now-last>=idle) { observer.disconnect(); resolve(true); }
          else if (now-started>=timeout) { observer.disconnect(); resolve(false); }
          else setTimeout(tick,20);
        };
        setTimeout(tick,idle);
      });
    },
    mask(enabled) {
      maskNodes.forEach(node=>node.remove()); maskNodes=[];
      if (!enabled) return;
      scriptWatchVersion++;
      endFields();
      // A capture shows the page as edited, not a moment of the choreography.
      swarm.settle();
      for (const el of scan().found) {
        if (!sensitive(el) || !visible(el)) continue;
        const rect=el.getBoundingClientRect();
        const mask=document.createElement('div'); overlays.add(mask);
        mask.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;background:#e6e8ed;color:#4b4e57;font:12px system-ui;display:flex;align-items:center;justify-content:center;left:'+rect.x+'px;top:'+rect.y+'px;width:'+rect.width+'px;height:'+rect.height+'px';
        mask.textContent='[hidden]'; document.documentElement.appendChild(mask); maskNodes.push(mask);
      }
    }
  };
  for (const name of ['snapshot','query','reveal','atPoint','bounds','read']) {
    const read=globalThis.__workbenchPage[name];
    globalThis.__workbenchPage[name]=(...args)=>swarm.truth(()=>read(...args));
  }
})();`;
