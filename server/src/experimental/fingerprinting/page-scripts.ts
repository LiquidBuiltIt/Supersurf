import { getSelectorExpression } from '../../tools/lib/element-resolver';

// Shared in-page helpers (as a source fragment, reused by both builders).
const HELPERS = `
  var SELECTOR='a,button,input,textarea,select,summary,[role=button],[role=link],[role=textbox],[role=checkbox],[role=tab],[role=menuitem],[role=option],[onclick]';
  function isOutermost(el){var p=el.parentElement;while(p&&p.tagName.toLowerCase()!=='body'){if(p.matches(SELECTOR))return false;p=p.parentElement;}return true;}
  var TAG_ROLE={a:'link',button:'button',textarea:'textbox',select:'combobox',summary:'button'};
  function roleOf(el){var r=el.getAttribute('role');if(r)return r;var t=el.tagName.toLowerCase();if(t==='input'){var ty=(el.getAttribute('type')||'text').toLowerCase();if(ty==='checkbox')return 'checkbox';if(ty==='radio')return 'radio';if(ty==='submit'||ty==='button')return 'button';return 'textbox';}return TAG_ROLE[t]||'generic';}
  function directText(el){var s='';el.childNodes.forEach(function(n){if(n.nodeType===3)s+=n.textContent||'';});return s.trim().replace(/\\s+/g,' ').slice(0,120);}
  function accName(el){var ity=el.tagName.toLowerCase()==='input'?(el.getAttribute('type')||'text').toLowerCase():'';var lblVal=(ity==='radio'||ity==='checkbox'||ity==='submit'||ity==='button')?(el.getAttribute('value')||''):'';var own=(el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('placeholder')||lblVal).trim();if(own)return own.slice(0,120);var dt=directText(el);if(dt)return dt.slice(0,120);var imgs=el.querySelectorAll('img[alt]');for(var i=0;i<imgs.length;i++){var a=(imgs[i].getAttribute('alt')||'').trim();if(a)return a.slice(0,120);}var lab=el.querySelectorAll('[aria-label]');for(var j=0;j<lab.length;j++){var la=(lab[j].getAttribute('aria-label')||'').trim();if(la)return la.slice(0,120);}return (el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,120);}
  var STABLE=/^(data-(testid|test-id|test|automation-id|id|key|item-id|qa|cy)|aria-label|name|placeholder|alt|title)$/;
  function stableAttrs(el){var o={};Array.from(el.attributes).forEach(function(a){if(a.name==='data-poc-truth')return;if(STABLE.test(a.name)&&a.value)o[a.name]=a.value;});return o;}
  function classList(el){var c=el.getAttribute('class');return c?c.trim().split(/\\s+/).filter(Boolean).slice(0,6):[];}
  function center(el){var r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}
  var LANDMARK=/^(nav|main|header|footer|aside|form|section)$/;
  function landmark(el){var c=el.parentElement;while(c&&c.tagName.toLowerCase()!=='body'){var t=c.tagName.toLowerCase();var r=c.getAttribute('role');if(LANDMARK.test(t)||r)return (r||t)+':'+((c.getAttribute('aria-label')||'').slice(0,40));c=c.parentElement;}return '';}
  var ALL=Array.from(document.querySelectorAll(SELECTOR)).filter(isOutermost).map(function(el){return {el:el,c:center(el)};});
  function neighborText(el,c){var out=[];ALL.forEach(function(o){if(o.el===el)return;var dx=o.c.x-c.x,dy=o.c.y-c.y;if(dx*dx+dy*dy<140*140){var t=directText(o.el);if(t)out.push(t);}});return out.join(' ').slice(0,160);}
  function fp(el,c){var role=roleOf(el);return {role:role,name:accName(el),text:directText(el),tag:el.tagName.toLowerCase(),type:el.getAttribute('type')||null,attrs:stableAttrs(el),classList:classList(el),htmlId:el.id||'',cx:c.x,cy:c.y,neighborText:neighborText(el,c),landmark:landmark(el)};}
`;

/** Build a read-only IIFE that fingerprints the element matching `selector`, or returns null.
 *  Uses getSelectorExpression (not raw querySelector) so SuperSurf's :has-text extension and
 *  digit-leading-id selectors resolve the same way the real resolver does. */
export function captureExpr(selector: string): string {
  const elExpr = getSelectorExpression(selector);
  return `(function(){${HELPERS}
    var el; try { el = (${elExpr}); } catch(e){ el = null; }
    if(!el) return null;
    var c=center(el);
    var role=roleOf(el);
    var rc=0; for(var k=0;k<ALL.length;k++){ if(roleOf(ALL[k].el)===role){ if(ALL[k].el===el) break; rc++; } }
    var f=fp(el,c); f.ordinal=rc;
    return JSON.stringify(f);
  })()`;
}

/** Build a read-only IIFE that scores all candidates against `targetJson`, returns the best
 *  match as a ScoreHit (coordinates + score/margin + the winner's identity) or null. The
 *  identity is what lets the caller synthesize a selector for the healed element — see
 *  selector-synthesis.ts. */
export function scoreExpr(targetJson: string): string {
  return `(function(){${HELPERS}
    var T=${targetJson};
    var W={name:28,text:18,role:14,neighborText:14,landmark:8,position:8,tag:6,type:3,classList:5,htmlId:3,attrs:6,ordinal:3};
    function tokens(s){return (s||'').toLowerCase().split(/\\s+/).filter(Boolean);}
    function jac(a,b){if(!a.length&&!b.length)return 1;var sb=new Set(b),i=0;new Set(a).forEach(function(x){if(sb.has(x))i++;});var u=new Set(a.concat(b)).size;return u?i/u:0;}
    function ov(a,b){var k=Object.keys(a);if(!k.length)return 0;var m=0;k.forEach(function(x){if(b[x]===a[x])m++;});return m/k.length;}
    var rc={};
    var cands=ALL.map(function(o){var el=o.el,c=o.c;var role=roleOf(el);var ord=(rc[role]=(rc[role]||0)+1)-1;var f=fp(el,c);f.ordinal=ord;f.cx=c.x;f.cy=c.y;return f;});
    function sc(t,c){var got=0,max=0;function add(w,h){max+=w;got+=w*h;}
      if(t.name)add(W.name,t.name===c.name?1:(c.name&&(c.name.indexOf(t.name)>=0||t.name.indexOf(c.name)>=0)?0.5:0));
      if(t.text)add(W.text,t.text===c.text?1:(c.text.indexOf(t.text)>=0?0.5:0));
      add(W.role,t.role===c.role?1:0);
      if(t.neighborText)add(W.neighborText,jac(tokens(t.neighborText),tokens(c.neighborText)));
      if(t.landmark)add(W.landmark,t.landmark===c.landmark?1:(c.landmark&&c.landmark.split(':')[0]===t.landmark.split(':')[0]?0.5:0));
      var d=Math.hypot((t.cx||0)-c.cx,(t.cy||0)-c.cy);add(W.position,Math.max(0,1-d/600));
      add(W.tag,t.tag===c.tag?1:0);if(t.type)add(W.type,t.type===c.type?1:0);
      if(t.classList&&t.classList.length)add(W.classList,jac(t.classList,c.classList));
      if(t.htmlId)add(W.htmlId,t.htmlId===c.htmlId?1:0);
      if(t.attrs&&Object.keys(t.attrs).length)add(W.attrs,ov(t.attrs,c.attrs));
      add(W.ordinal,t.ordinal===c.ordinal?1:0);return max?got/max:0;}
    var best=null,bs=0,ru=0;
    cands.forEach(function(c){var s=sc(T,c);if(s>bs){ru=bs;bs=s;best=c;}else if(s>ru)ru=s;});
    if(!best) return null;
    return JSON.stringify({cx:best.cx,cy:best.cy,score:+bs.toFixed(3),margin:+(bs-ru).toFixed(3),
      role:best.role,name:best.name,tag:best.tag,type:best.type,htmlId:best.htmlId,
      attrs:best.attrs,classList:best.classList,ordinal:best.ordinal});
  })()`;
}
