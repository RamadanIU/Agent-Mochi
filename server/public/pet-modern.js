/* Personal Computer · тема «Современная»: компьютер — тонкий алюминиевый ноутбук в векторе вместо пиксельного моноблока.
   Отдельный файл (страница остаётся в лимите 700 КБ): подключается из index.html (<script src="pet-modern.js">),
   отдаёт сервер (STATIC в server/lib/server.js), офлайн-кэш его хранит. В остальных темах — прежний пиксельный компьютер.
   Мозг общий: состояния, реплики, частицы, игры и секреты считает скрипт компьютера в index.html и каждый кадр отдаёт сюда
   позу и что на экране (window.PCModern.draw). Здесь — картинка и «физика» поверх позы:
   • поза — на пружинах: прыжки с оттяжкой и приземлением, мягкие наклоны, сжатие-растяжение;
   • крышка — тоже пружина: качается от толчков, во сне прикрывается, от испуга вздрагивает, от удивления распахивается,
     при первом показе ноутбук открывается;
   • лицо — светящиеся глаза-«таблетки» и рот из параметров (а не картинок), поэтому выражения плавно перетекают одно в другое;
   • экран — окна в духе современной системы: настоящая команда в терминале, настоящий запрос в поиске, текст ответа модели;
   • клавиши под «пальцами» подсвечиваются, экран подсвечивает клавиатуру своим цветом (и заполненность контекста — тоже).
   Наружу: window.PCModern = { box, draw(ctx, o), hit(x, y, d), mirror(ctx) } */
(()=>{
'use strict';
const RM=matchMedia('(prefers-reduced-motion: reduce)'),DKQ=matchMedia('(prefers-color-scheme: dark)');
const clamp=(v,a,b)=>v<a?a:v>b?b:v,lerp=(a,b,k)=>a+(b-a)*k,ease=k=>1-Math.pow(1-k,3),smooth=k=>k*k*(3-2*k);
const easeBack=k=>{const c=1.7;return 1+(c+1)*Math.pow(k-1,3)+c*Math.pow(k-1,2)};
const hash=n=>{const x=Math.sin(n*127.1+311.7)*43758.5453;return x-Math.floor(x)};
const TAU=Math.PI*2,RAD=Math.PI/180;
const SANS='-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
const MONO='ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace';
/* цвета: '#rrggbb' → rgba(…) с кэшем */
const HX=new Map();
const hex=h=>{let c=HX.get(h);if(!c){let s=String(h).replace('#','');if(s.length===3)s=s.replace(/./g,'$&$&');const n=parseInt(s,16)||0;c=[n>>16&255,n>>8&255,n&255];if(HX.size>300)HX.clear();HX.set(h,c)}return c};
const rgba=(h,a)=>{const c=hex(h);return'rgba('+c[0]+','+c[1]+','+c[2]+','+clamp(a,0,1).toFixed(3)+')'};
const mix=(a,b,k)=>{const x=hex(a),y=hex(b);return'#'+x.map((v,i)=>Math.round(lerp(v,y[i],k)).toString(16).padStart(2,'0')).join('')};

/* ================= ГЕОМЕТРИЯ =================
   Сцена — в тех же единицах, что у пиксельного компьютера: стоит в (CX, DESK). Кадр холста (BOX) — вокруг ноутбука,
   с местом сверху для прыжков. Ноутбук виден спереди и чуть сверху (угол EL): точка (x — вбок, z — вглубь от переднего края,
   h — вверх от стола) → (x·перспектива, −(h·cos + z·sin)); начало — середина переднего нижнего края корпуса */
const CX=128,DESK=156,BOX=[CX-53,68,106,92];
const EL=15*RAD,SE=Math.sin(EL),CE=Math.cos(EL);
const BD=60,BT=2.6,BW=98,KP=.1,LL=57,LW=86,ZH=BD-2.4,HH=BT*.5;
const DU0=-LW/2+3.2,DU1=LW/2-3.2,DV0=4.2,DV1=LL-3.4; /* дисплей внутри крышки: u — поперёк, v — вверх от шарнира */
const pj=(x,z,h)=>[x*(1-KP*z/BD),-(h*CE+z*SE)];
let LCA=0,LSA=1;
const LP=(u,v)=>pj(u,ZH-v*LCA,HH+v*LSA);
/* клавиатура: ряды (доля глубины спереди-назад) и ширины клавиш; нажатия приходят индексами 0…63 (60 — пробел) */
const KR=[[.88,.912,[1,1,1,1,1,1,1,1,1,1,1,1,1,1]],[.79,.862,[1,1,1,1,1,1,1,1,1,1,1,1,1,1.6]],[.7,.772,[1.5,1,1,1,1,1,1,1,1,1,1,1,1,1.1]],
 [.61,.682,[1.9,1,1,1,1,1,1,1,1,1,1,1.9]],[.52,.592,[1,1,1,1.3,5.6,1.3,1,1.15,1.15]]];

const PAL={
 light:{a0:'#ffffff',a1:'#e7e8eb',a2:'#d2d4d9',lip0:'#e0e2e6',lip1:'#b4b8bf',scoop:'rgba(0,0,0,.16)',key:'#26272c',lit:'#ffffff',well:'rgba(70,74,84,.10)',
  tp:'#e2e4e8',tpE:'rgba(0,0,0,.13)',rim:'#c3c6cc',rimHi:'#f4f5f7',back0:'#e6e8eb',back1:'#c8cbd0',logo:'rgba(255,255,255,.75)',sh:'#141822',
  ink:'#3a3b42',bub:'#ffffff',bubE:'rgba(0,0,0,.12)',smoke:'#9a9ca3',led:'#ffffff'},
 dark:{a0:'#7a7e87',a1:'#3f4249',a2:'#2f3237',lip0:'#3c3f45',lip1:'#1b1c20',scoop:'rgba(0,0,0,.4)',key:'#0b0c0e',lit:'#ffffff',well:'rgba(0,0,0,.25)',
  tp:'#3a3d43',tpE:'rgba(255,255,255,.08)',rim:'#55585f',rimHi:'#8a8e96',back0:'#45484f',back1:'#2b2d32',logo:'rgba(255,255,255,.22)',sh:'#000000',
  ink:'#d8d9df',bub:'#2c2d32',bubE:'rgba(255,255,255,.12)',smoke:'#6f7179',led:'#ffffff'}};
const isDark=()=>{const s=document.documentElement.dataset.scheme;return s==='dark'||s!=='light'&&DKQ.matches};

/* ================= ХОЛСТЫ =================
   DC — экран (рисуется в своих единицах 160×100), PC — прошлый кадр экрана (плавная смена программ), LC — слой лица (светится) */
const mkC=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return[c,c.getContext('2d')]};
const[DC,DG]=mkC(160,100),[PC,PG]=mkC(160,100),[LC,LG]=mkC(160,100),[QC,QG]=mkC(40,25);
let TQ=1;
function texScale(q){if(Math.abs(q-TQ)<.01)return;TQ=q;[DC,PC,LC].forEach(c=>{c.width=Math.round(160*q);c.height=Math.round(100*q)});[DG,PG,LG].forEach(x=>{x.__f=''})}

/* ================= СОСТОЯНИЕ: пружины, глаза, рот ================= */
const E0={w:17,h:25,r:1,lt:0,ls:0,bc:0,tc:0,ring:0,pup:0,oy:0,ba:1};
const EYE={n:{},up:{oy:-5},d:{w:9,h:9},w:{w:23,h:27,ring:1,pup:10},scared:{w:24,h:28,ring:1,pup:5},o:{w:15,h:15,ring:1},
 f:{w:20,h:21,lt:.42},t:{w:21,h:22,lt:.55,ls:-.55},ang:{w:20,h:24,lt:.18,ls:1.1},h:{w:24,h:19,bc:1},c:{w:24,h:19,tc:1},
 line:{w:22,h:3.6},blink:{w:20,h:3.4},heart:{g:1},star:{g:1},x:{g:1},sp:{g:1},$:{g:1},sq:{g:1}};
const GLY=['heart','star','x','sp','$','sq'];
const BLINKY=new Set(['n','w','up','f','ang','o','scared']);
const M0={w:15,cu:0,cl:0,wa:0,cat:0,ti:0,ox:0,te:0,to:0};
const MO={smile:{w:15,cu:4.5,cl:4.5},grin:{w:21,cu:1.5,cl:11,te:.85},flat:{w:12},o:{w:6.5,cu:-3.6,cl:3.6},O:{w:9.5,cu:-7,cl:7},
 wavy:{w:19,wa:2.1},frown:{w:14,cu:-4.2,cl:-4.2},cat:{w:16,wa:2.8,cat:1},tongue:{w:16,cu:4.5,cl:6,to:1},small:{w:6,cu:1,cl:1},
 smirk:{w:13,cu:3.2,cl:3.2,ti:-.32,ox:3},whistle:{w:4.6,cu:-3,cl:3,ox:5},teeth:{w:21,cu:-3.6,cl:5.6,te:1}};
const mkEye=()=>Object.assign({},E0,{ty:'n',ga:Object.fromEntries(GLY.map(k=>[k,0]))});
const ST={T:0,seen:-9,pose:{bx:[0,0],by:[0,0],rot:[0,0],sx:[1,0],sy:[1,0]},lid:[0,0],eyes:[mkEye(),mkEye()],mouth:Object.assign({},M0),
 fx:{blush:0,sweat:0,tear:0,anger:0,hand:0,zz:0},mirK:0,mirT:-9,key:'',trT:-9,last:null,trail:[],cards:new Float32Array(8),title:'',mp:null,cost:0};
let pal=PAL.light,K=1;
const CO={face:'#fff',eye2:'#cfe0ff',glow:'#8fb8ff',acc:'#5b9bff',accD:'#2f6bff',accInk:'#2f6bff',w1:'#2f4bd6',w2:'#8b3fd6',ok:'#34c759',err:'#ff453a',dim:false};
function colors(o){const th=o.TH||['#000','#333','#666','#ccc','#fff'],wh=o.THEMES&&th===o.THEMES.white;
 CO.face=wh?'#f4f7ff':mix(th[4],'#ffffff',.2);CO.glow=wh?'#8fb8ff':th[3];CO.acc=wh?'#5b9bff':th[3];CO.eye2=mix(CO.face,CO.glow,.38);
 CO.accD=mix(CO.acc,'#14151a',.3);CO.accInk=isDark()?CO.acc:mix(CO.acc,'#1d1e22',.45);
 CO.w1=wh?'#2f4bd6':th[2];CO.w2=wh?'#8b3fd6':th[1];CO.dim=!!(o.THEMES&&th===o.THEMES.black)}

/* пружина [значение, скорость]; при «меньше движения» — сразу в цель */
function spr(s,tg,k,z,dt){if(RM.matches||!Number.isFinite(tg)){s[0]=Number.isFinite(tg)?tg:s[0];s[1]=0;return}
 const c=2*z*Math.sqrt(k),n=Math.max(1,Math.ceil(dt/.005)),h=dt/n;for(let i=0;i<n;i++){s[1]+=(k*(tg-s[0])-c*s[1])*h;s[0]+=s[1]*h}}
const approach=(a,b,r,dt)=>a+(b-a)*(1-Math.exp(-r*dt));

/* крышка: угол открытия (°) по состоянию — дальше её ведёт пружина, поэтому всё качается и пружинит */
function lidTarget(o){const t=o.t;
 switch(o.cur){
  case'sleeping':return 36;
  case'scared':return 86;
  case'surprised':return t<1.4?117:108;
  case'sad':return 95;
  case'stopped':return t<.5?99:104;
  case'hello':return 106+(t<1.6?Math.sin(t*9)*5:0);
  case'laugh':return 106+Math.abs(Math.sin(t*11))*4;
  case'dance':case'party':return 106+Math.sin(t*TAU*1.1)*7;
  case'love':return 107+Math.sin(t*4)*2.5;
  case'reboot':return t>.45&&t<1.5?84:106;
  case'bsod':return t<.3?96:104;
  case'overheat':return 110+Math.sin(t*12)*1.2;
  case'angry':return 103+Math.sin(t*30)*1.6;
  case'cool':return t>1.1?112:106;
  case'thinking':return 104+Math.sin(t*1.4)*2;
  case'poke':return t<.3?100:106;
 }
 return 106}

function eyeTarget(ty,f,side){const e=Object.assign({},E0,EYE[ty]||EYE.n);
 if(e.g){e.ba=0;e.w=10;e.h=10;return e}
 const b=f.brow;
 if(b==='up'){e.h+=3;e.oy-=2}
 else if(b==='ang'){e.lt=Math.max(e.lt,.2);e.ls=1.1}
 else if(b==='sad'){e.lt=Math.max(e.lt,.22);e.ls=-1}
 else if(b==='flat')e.lt=Math.max(e.lt,.24);
 else if(b==='skep'){if(side>0){e.h+=3;e.oy-=3}else e.lt=Math.max(e.lt,.36)}
 return e}
function mouthTarget(f,T){const m=f.m||'smile';
 if(m==='talk'){const mo=clamp(f.mo||0,0,1);return Object.assign({},M0,{w:11+mo*4,cu:-mo*2.6,cl:.6+mo*7.5})}
 if(m==='pant')return Object.assign({},M0,Math.sin(T*14)>0?{w:12,cu:-2,cl:7.5,to:1}:{w:11,cu:1,cl:3.5,to:.7});
 return Object.assign({},M0,MO[m]||MO.smile)}

function update(o){const dt=clamp(o.dt||.016,0,.1),d=o.d,P=ST.pose;
 /* первый кадр после паузы (тема только что включена, вкладка вернулась): ноутбук открывается */
 if(o.T-ST.seen>1.5){for(const k in P){P[k][0]=d[k]??(k[0]==='s'?1:0);P[k][1]=0}ST.lid[0]=RM.matches?106:3;ST.lid[1]=0;ST.open=o.T}
 ST.seen=ST.T=o.T;
 const vy=P.by[1];
 spr(P.bx,d.bx||0,260,.55,dt);spr(P.by,d.by||0,300,.5,dt);spr(P.rot,d.rot||0,220,.45,dt);spr(P.sx,d.sx||1,340,.32,dt);spr(P.sy,d.sy||1,340,.32,dt);
 /* крышку раскачивает толчок корпуса: приземление — откидывается назад, взлёт — наоборот */
 if(!RM.matches)ST.lid[1]+=clamp(-(P.by[1]-vy)*.9,-120,120);
 spr(ST.lid,o.T-ST.open<.25?3:lidTarget(o),90,.42,dt);
 if(ST.lid[0]>124){ST.lid[0]=124;ST.lid[1]=-Math.abs(ST.lid[1])*.3}if(ST.lid[0]<0){ST.lid[0]=0;ST.lid[1]=Math.abs(ST.lid[1])*.2}
 /* лицо: параметры глаз и рта тянутся к цели — выражения перетекают */
 const f=d.face||{},L=f.l||'n',R=f.r||L,ke=1-Math.exp(-dt*20);
 [L,R].forEach((ty,i)=>{const e=ST.eyes[i],tg=eyeTarget(ty,f,i?1:-1);for(const p in E0)e[p]+=(tg[p]-e[p])*ke;
  for(const g of GLY)e.ga[g]=approach(e.ga[g],ty===g?1:0,14,dt);e.ty=ty});
 const mt=mouthTarget(f,o.T),km=1-Math.exp(-dt*(f.m==='talk'?34:16));for(const p in M0)ST.mouth[p]+=(mt[p]-ST.mouth[p])*km;
 const X=ST.fx;X.blush=approach(X.blush,f.blush?1:0,8,dt);X.sweat=approach(X.sweat,f.sweat?1:0,8,dt);X.tear=approach(X.tear,f.tear?1:0,8,dt);
 X.anger=approach(X.anger,f.anger?1:0,10,dt);X.hand=approach(X.hand,f.hand?1:0,10,dt);X.zz=approach(X.zz,f.zz?1:0,4,dt);
 /* грусть — дождик из тучки над крышкой */
 if(d.rainCloud&&o.PS&&o.PS.length<300&&Math.random()<dt*16)o.PS.push({type:'rain',x:CX+P.bx[0]+2+(Math.random()-.5)*16,y:DESK+P.by[0]-79,vx:0,vy:80,g:0,life:.32,max:.32,seed:Math.random()});
 /* понг: хвост у мячика */
 if(o.pong&&o.cur==='pong'){ST.trail.push([o.pong.x,o.pong.y]);if(ST.trail.length>7)ST.trail.shift()}else ST.trail.length=0}

/* ================= ЭКРАН: помощники рисования (в единицах экрана 160×100) ================= */
let g=DG;
const F=(c,sz,wt,mono)=>{const f=(wt||500)+' '+sz+'px '+(mono?MONO:SANS);if(c.__f!==f){c.font=f;c.__f=f}};
function tx(s,x,y,sz,col,wt,al,mono){F(g,sz,wt,mono);g.textAlign=al||'left';g.textBaseline='middle';g.fillStyle=col;g.fillText(s,x,y)}
const tw=(s,sz,wt,mono)=>{F(g,sz,wt,mono);return g.measureText(s).width};
function rr(c,x,y,w,h,r){r=Math.max(0,Math.min(r,w/2,h/2));c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath()}
const box=(x,y,w,h,r,col)=>{if(w<=0||h<=0)return;rr(g,x,y,w,h,r);g.fillStyle=col;g.fill()};
const dot=(x,y,r,col,c=g)=>{c.beginPath();c.arc(x,y,Math.max(0,r),0,TAU);c.fillStyle=col;c.fill()};
function ln(x0,y0,x1,y1,col,w,c=g){c.beginPath();c.moveTo(x0,y0);c.lineTo(x1,y1);c.strokeStyle=col;c.lineWidth=w||1;c.lineCap='round';c.stroke()}
function heartPath(c,x,y,s){c.beginPath();c.moveTo(x,y+s*.36);c.bezierCurveTo(x-s*.66,y-s*.02,x-s*.36,y-s*.66,x,y-s*.24);c.bezierCurveTo(x+s*.36,y-s*.66,x+s*.66,y-s*.02,x,y+s*.36);c.closePath()}
function sparkle(c,x,y,r,w){c.beginPath();for(let i=0;i<4;i++){const a=i*Math.PI/2-Math.PI/2,b=a+Math.PI/4,n=a+Math.PI/2;const p=[x+Math.cos(a)*r,y+Math.sin(a)*r];i?c.lineTo(p[0],p[1]):c.moveTo(p[0],p[1]);c.quadraticCurveTo(x+Math.cos(b)*w,y+Math.sin(b)*w,x+Math.cos(n)*r,y+Math.sin(n)*r)}c.closePath()}
function dropPath(c,x,y,s){c.beginPath();c.moveTo(x,y-s);c.bezierCurveTo(x+s*.2,y-s*.4,x+s*.6,y,x+s*.6,y+s*.35);c.arc(x,y+s*.35,s*.6,0,Math.PI);c.bezierCurveTo(x-s*.6,y,x-s*.2,y-s*.4,x,y-s);c.closePath()}
function ckm(x,y,s,col,w,k=1){g.beginPath();g.moveTo(x-s,y);g.lineTo(x-s*.3,y+s*.7);g.lineTo(x+s,y-s*.75);g.setLineDash([s*3.2*k,s*4]);g.strokeStyle=col;g.lineWidth=w||1.4;g.lineCap=g.lineJoin='round';g.stroke();g.setLineDash([])}
function spin(x,y,r,T,col){g.lineCap='round';g.lineWidth=1.3;g.strokeStyle=rgba(col,.22);g.beginPath();g.arc(x,y,r,0,TAU);g.stroke();g.strokeStyle=col;g.beginPath();g.arc(x,y,r,T*7,T*7+2.1);g.stroke()}
function ring(x,y,r,w,fr,col,rest){g.lineCap='round';g.lineWidth=w;g.strokeStyle=rest?rgba(rest,.85):'rgba(255,255,255,.1)';g.beginPath();g.arc(x,y,r,0,TAU);g.stroke();
 if(fr>.001){g.strokeStyle=col;g.beginPath();g.arc(x,y,r,-Math.PI/2,-Math.PI/2+TAU*clamp(fr,0,1));g.stroke()}}
function pill(cx,cy,s,col,sz=6.4){const w=tw(s,sz,700)+9;box(cx-w/2,cy-4.6,w,9.2,4.6,rgba(col,.2));tx(s,cx,cy+.3,sz,col,700,'center')}
function lens(x,y,r,col,w){g.strokeStyle=col;g.lineWidth=w;g.lineCap='round';g.beginPath();g.arc(x,y,r,0,TAU);g.stroke();ln(x+r*.72,y+r*.72,x+r*1.6,y+r*1.6,col,w)}
function arrowCursor(x,y){g.beginPath();g.moveTo(x,y);g.lineTo(x,y+10);g.lineTo(x+2.6,y+7.6);g.lineTo(x+4.6,y+11.8);g.lineTo(x+6.2,y+11);g.lineTo(x+4.3,y+7);g.lineTo(x+7.6,y+7);g.closePath();g.fillStyle='#111214';g.fill();g.strokeStyle='#ffffff';g.lineWidth=.9;g.lineJoin='round';g.stroke()}
function cloud(x,y,s,col){g.fillStyle=col;g.beginPath();[[-9,2,6],[0,-2,8],[9,2,6],[-4,5,6],[5,5,6]].forEach(([a,b,r])=>{g.moveTo(x+a*s+r*s,y+b*s);g.arc(x+a*s,y+b*s,r*s,0,TAU)});g.fill()}
function fit(s,sz,wt,max){if(tw(s,sz,wt)<=max)return s;let n=s.length;while(n>1&&tw(s.slice(0,n)+'…',sz,wt)>max)n--;return s.slice(0,n)+'…'}
/* перенос по ширине (кэш: тот же текст — те же строки) */
const WC=new Map();
function wrapW(s,maxW,sz,wt){const k=s+'\u0001'+maxW+sz+wt;let r=WC.get(k);if(r)return r;F(g,sz,wt);r=[];let line='';
 for(const w of s.split(' ')){if(!w)continue;const t2=line?line+' '+w:w;if(g.measureText(t2).width<=maxW){line=t2;continue}if(line)r.push(line);
  let x=w;while(x.length>1&&g.measureText(x).width>maxW){let n=x.length-1;while(n>1&&g.measureText(x.slice(0,n)).width>maxW)n--;r.push(x.slice(0,n));x=x.slice(n)}line=x}
 if(line)r.push(line);if(WC.size>40)WC.clear();WC.set(k,r);return r}

/* обои за лицом: почти чёрное стекло и медленное «северное сияние» цветом экрана */
function blob(x,y,r,col,a){const gr=g.createRadialGradient(x,y,0,x,y,r);gr.addColorStop(0,rgba(col,a));gr.addColorStop(1,rgba(col,0));g.fillStyle=gr;g.fillRect(0,0,160,100)}
function wall(o,a=1){g.fillStyle='#040507';g.fillRect(0,0,160,100);if(CO.dim)return;const t=RM.matches?0:o.T;
 blob(30+Math.sin(t*.23)*16,96+Math.cos(t*.19)*8,95,CO.w1,.5*a);blob(136+Math.cos(t*.17)*14,-4+Math.sin(t*.21)*8,85,CO.w2,.42*a);blob(150,98,48,CO.w1,.16*a)}

/* ================= ЛИЦО ================= */
const EX=[58,102],EY=44,MY=73;
function eye(c,e,cx,cy,side,bl,o,lx,ly){
 const w=e.w*(1+bl*.15),h=Math.max(2.4,e.h*(1-bl*.9)),x=cx,y=cy+e.oy;
 if(e.ba>.02){
  const gr=c.createLinearGradient(0,y-h/2,0,y+h/2);gr.addColorStop(0,CO.face);gr.addColorStop(1,CO.eye2);
  c.globalAlpha=clamp(e.ba*1.3,0,1);c.fillStyle=gr;rr(c,x-w/2,y-h/2,w,h,Math.min(w,h)/2*e.r);c.fill();c.globalAlpha=1;
  /* веки и вырезы: стираем лишнее — так «таблетка» становится хмурой, усталой, счастливой дугой или колечком */
  c.globalCompositeOperation='destination-out';c.fillStyle='#000';
  if(e.lt>.01||Math.abs(e.ls)>.02){const top=y-h/2,yl=X=>top+e.lt*h+e.ls*h*.42*((X-x)/(w/2))*(-side),x0=x-w/2-3,x1=x+w/2+3;
   c.beginPath();c.moveTo(x0,top-8);c.lineTo(x1,top-8);c.lineTo(x1,yl(x1));c.lineTo(x0,yl(x0));c.closePath();c.fill()}
  if(e.bc>.01){c.beginPath();c.ellipse(x,y+h*.7,w*.66,h*.82*e.bc,0,0,TAU);c.fill()}
  if(e.tc>.01){c.beginPath();c.ellipse(x,y-h*.7,w*.66,h*.82*e.tc,0,0,TAU);c.fill()}
  if(e.ring>.01){const ins=Math.min(w,h)*.2,iw=Math.max(0,w-ins*2)*e.ring,ih=Math.max(0,h-ins*2)*e.ring;if(iw>.5&&ih>.5){rr(c,x-iw/2,y-ih/2,iw,ih,Math.min(iw,ih)/2);c.fill()}}
  c.globalCompositeOperation='source-over';
  if(e.pup>.6&&e.ring>.25){const j=o.cur==='scared'&&!RM.matches?(Math.random()-.5)*1.6:0;c.globalAlpha=clamp(e.ring*1.5-.3,0,1);dot(x+lx*2.2+j,y+ly*2.4+j,e.pup/2,CO.face,c);c.globalAlpha=1}
 }
 for(const k of GLY){const a=e.ga[k];if(a>.02)glyph(c,k,a,cx,cy,side,o.T)}}
function glyph(c,type,a,x,y,side,T){const s=.55+.45*easeBack(clamp(a,0,1));c.save();c.globalAlpha=clamp(a*1.4,0,1);c.translate(x,y);c.scale(s,s);
 c.fillStyle=c.strokeStyle=CO.face;c.lineCap=c.lineJoin='round';
 switch(type){
 case'heart':{const p=1+.1*Math.sin(T*9);c.scale(p,p);heartPath(c,0,1,24);c.fill();break}
 case'star':{c.rotate(T*1.4*side);sparkle(c,0,0,13*(.86+.14*Math.sin(T*12)),2.6);c.fill();break}
 case'x':c.lineWidth=4.6;c.beginPath();c.moveTo(-7,-7);c.lineTo(7,7);c.moveTo(7,-7);c.lineTo(-7,7);c.stroke();break;
 case'sp':{c.lineWidth=2.6;c.rotate(T*8*side);c.beginPath();for(let i=0;i<=44;i++){const b=i*.33,r=i*.25;i?c.lineTo(Math.cos(b)*r,Math.sin(b)*r):c.moveTo(0,0)}c.stroke();break}
 case'$':F(c,26,800);c.textAlign='center';c.textBaseline='middle';c.fillText('$',0,1);break;
 case'sq':{const k=side<0?1:-1;c.lineWidth=4.6;c.beginPath();c.moveTo(-5*k,-8);c.lineTo(5*k,0);c.lineTo(-5*k,8);c.stroke();break}
 }c.restore()}
function mouthPts(m,cx,cy){const N=18,top=[],bot=[];for(let i=0;i<=N;i++){const u=i/N*2-1,x=cx+m.ox+u*m.w/2,q=1-u*u,b=m.ti*u*m.w/2+m.wa*lerp(Math.sin(u*TAU),Math.abs(Math.sin(u*Math.PI)),clamp(m.cat,0,1));top.push([x,cy+m.cu*q+b]);bot.push([x,cy+m.cl*q+b])}return[top,bot]}
function mouthPath(c,top,bot){c.beginPath();top.forEach((p,i)=>i?c.lineTo(p[0],p[1]):c.moveTo(p[0],p[1]));for(let i=bot.length-1;i>=0;i--)c.lineTo(bot[i][0],bot[i][1]);c.closePath()}
function mouth(c,m,cx,cy){const[top,bot]=mouthPts(m,cx,cy);let open=0;top.forEach((p,i)=>{open=Math.max(open,bot[i][1]-p[1])});mouthPath(c,top,bot);
 if(open>.8){c.globalAlpha=.28;c.fillStyle=CO.face;c.fill();c.globalAlpha=1;
  if(m.te>.05){c.save();c.clip();c.globalAlpha=clamp(m.te,0,1)*.95;c.fillStyle=CO.face;c.fillRect(cx+m.ox-m.w/2-2,cy+Math.min(m.cu,m.cl)-3,m.w+4,3+open*.36);c.restore()}}
 c.strokeStyle=CO.face;c.lineWidth=2.8;c.lineJoin=c.lineCap='round';c.stroke();ST.mp=[top,bot,open,cx,cy]}
function face(o){const d=o.d,f=d.face||{},bl=f.noBlink?0:o.bl||0,lk=o.look||{x:0,y:0},lx=(f.lx??lk.x)*.7,ly=(f.ly??lk.y)*.7,q=TQ;
 wall(o);
 LG.setTransform(1,0,0,1,0,0);LG.clearRect(0,0,LC.width,LC.height);LG.setTransform(q,0,0,q,0,0);
 const fx=lx*3.2,fy=ly*3.2;
 ST.eyes.forEach((e,i)=>{const b=BLINKY.has(e.ty)?(i===1&&f.wink?0:bl):0;eye(LG,e,EX[i]+fx,EY+fy,i?1:-1,b,o,lx,ly)});
 mouth(LG,ST.mouth,80+lx*1.8,MY+ly*1.4);
 if(ST.fx.zz>.02){const T=o.T;for(let i=0;i<3;i++){const p=(T*.45+i/3)%1;LG.globalAlpha=Math.sin(p*Math.PI)*ST.fx.zz;F(LG,7+p*8,800);LG.textAlign='center';LG.textBaseline='middle';LG.fillStyle=CO.face;LG.fillText('z',122+p*20,34-p*24)}LG.globalAlpha=1}
 /* свечение: слой лица с мягкой тенью цвета экрана */
 g.setTransform(1,0,0,1,0,0);g.shadowColor=rgba(CO.glow,.85);g.shadowBlur=7*q;g.drawImage(LC,0,0);g.shadowBlur=0;g.setTransform(q,0,0,q,0,0);
 extras(o,f,lx,ly)}
function extras(o,f,lx,ly){const T=o.T,X=ST.fx,m=ST.mouth;
 if(m.to>.05&&ST.mp&&ST.mp[2]>1){const[top,bot,open,cx,cy]=ST.mp;g.save();mouthPath(g,top,bot);g.clip();g.globalAlpha=clamp(m.to,0,1);g.fillStyle='#ff5c86';g.beginPath();g.ellipse(cx+m.ox,cy+m.cl*.95,m.w*.27,Math.max(1.6,open*.45),0,0,TAU);g.fill();g.restore()}
 if(X.blush>.02)[EX[0]-3,EX[1]+3].forEach(x=>{const gr=g.createRadialGradient(x,62,0,x,62,10);gr.addColorStop(0,rgba('#ff6f9f',.6*X.blush));gr.addColorStop(1,rgba('#ff6f9f',0));g.fillStyle=gr;g.fillRect(x-11,51,22,22)});
 if(X.sweat>.02){const k=(T*.9)%1;g.globalAlpha=X.sweat*(1-k*.6);dropFill(126,18+k*22,4.6)}
 if(X.tear>.02){const k=(T*1.1)%1;g.globalAlpha=X.tear*(1-k);dropFill(EX[0]-5+lx*3,58+k*34,3.6)}
 g.globalAlpha=1;
 if(X.anger>.02){g.save();g.translate(136,17);const s=1+.14*Math.sin(T*10);g.scale(s,s);g.globalAlpha=X.anger;g.strokeStyle='#ff4d4f';g.lineWidth=2.3;g.lineCap='round';for(let i=0;i<4;i++){g.rotate(Math.PI/2);g.beginPath();g.moveTo(1.6,-6);g.quadraticCurveTo(1.6,-1.6,6,-1.6);g.stroke()}g.restore()}
 if(f.glasses!==undefined)shades(clamp(f.glasses,0,1),lx,ly);
 if(X.hand>.02)hand(T,X.hand);
 if(f.mug)mug(T,clamp(f.mug,0,1));
 if(f.text){g.globalAlpha=clamp((o.t-1.2)/.3,0,1);tx(f.text,80,92,9,'#ffffff',800,'center');g.globalAlpha=1}}
function dropFill(x,y,s){dropPath(g,x,y,s);const gr=g.createLinearGradient(0,y-s,0,y+s);gr.addColorStop(0,'#d9f3ff');gr.addColorStop(1,'#59b8ff');g.fillStyle=gr;g.fill()}
function shades(k,lx,ly){const y=lerp(-26,EY-6+ly*3.2,easeBack(k)),x=lx*3.2;g.save();g.translate(x,y);
 g.fillStyle='#0a0a0c';rr(g,36,0,88,3.4,1.7);g.fill();
 [[41,0],[87,0]].forEach(([a])=>{g.beginPath();g.moveTo(a,1);g.lineTo(a+32,1);g.lineTo(a+29,14);g.quadraticCurveTo(a+28,17,a+24,17);g.lineTo(a+8,17);g.quadraticCurveTo(a+3.5,17,a+2.5,13);g.closePath();g.fill()});
 g.fillStyle='rgba(255,255,255,.28)';[[45],[91]].forEach(([a])=>{g.beginPath();g.moveTo(a+2,3.5);g.lineTo(a+9,3.5);g.lineTo(a+4,12);g.lineTo(a,12);g.closePath();g.fill()});g.restore()}
function hand(T,a){g.save();g.globalAlpha=a;g.translate(128,92);g.rotate(Math.sin(T*12)*.35);g.fillStyle=CO.face;g.shadowColor=rgba(CO.glow,.7);g.shadowBlur=4*TQ;
 rr(g,-6,-14,12,12,4.5);g.fill();for(let i=0;i<4;i++){rr(g,-5.6+i*3.1,-21+Math.abs(i-1.5)*1.2,2.6,9,1.3);g.fill()}g.save();g.translate(-5,-7);g.rotate(-.7);rr(g,-1.3,-6,2.6,7,1.3);g.fill();g.restore();g.restore()}
function mug(T,k){const y=lerp(112,64,ease(k));g.save();g.fillStyle='#f3f3f6';rr(g,67,y,24,24,4);g.fill();g.strokeStyle='#f3f3f6';g.lineWidth=2.6;g.beginPath();g.arc(92,y+11,5,-1.2,1.2);g.stroke();
 g.fillStyle='#6b4226';g.beginPath();g.ellipse(79,y+2.2,10.4,1.8,0,0,TAU);g.fill();g.fillStyle=rgba(CO.acc,.9);rr(g,73,y+10,12,5,2.5);g.fill();
 if(k>.9&&!RM.matches){g.strokeStyle='rgba(255,255,255,.55)';g.lineWidth=1.3;g.lineCap='round';for(let i=0;i<2;i++){g.beginPath();for(let j=0;j<=8;j++){const yy=y-2-j*1.6,xx=75+i*7+Math.sin(T*5+j*.7+i*2)*1.4;j?g.lineTo(xx,yy):g.moveTo(xx,yy)}g.globalAlpha=.6;g.stroke()}}g.restore()}
const MINI={h:'h',heart:'h',star:'h',sq:'h',c:'c',line:'c',x:'x',sp:'x'};
function mini(o,x,y,col){const f=o.d.face||{},bl=f.noBlink?0:o.bl||0,lx=clamp(f.lx??(o.look?o.look.x:0),-2,2)*.6;
 [[-4,f.l||'n'],[4,f.r||f.l||'n']].forEach(([dx,t])=>{const X=x+dx+lx,m=MINI[t]||'n';g.strokeStyle=g.fillStyle=col;g.lineWidth=1.5;g.lineCap='round';
  if(m==='h'){g.beginPath();g.arc(X,y+1.6,2.4,Math.PI*1.15,Math.PI*1.85);g.stroke()}
  else if(m==='c'){g.beginPath();g.arc(X,y-1.6,2.4,Math.PI*.15,Math.PI*.85);g.stroke()}
  else if(m==='x'){ln(X-2,y-2,X+2,y+2,col,1.4);ln(X+2,y-2,X-2,y+2,col,1.4)}
  else{const h=Math.max(1.2,5.4*(1-bl*.85));rr(g,X-1.5,y-h/2,3,h,1.5);g.fill()}})}

/* ================= ПРОГРАММЫ НА ЭКРАНЕ =================
   Окно: заголовок с тремя «светофорами» и именем (слева — посередине «чёлка» камеры), справа — маленькие глаза компьютера */
function win(o,bg,dark,title){g.fillStyle=bg;g.fillRect(0,0,160,100);
 g.fillStyle=dark?'#1b1d22':'#ececee';g.fillRect(0,0,160,15);g.fillStyle=dark?'rgba(255,255,255,.07)':'rgba(0,0,0,.09)';g.fillRect(0,14.5,160,.5);
 dot(9,7.5,2.5,'#ff5f57');dot(16.5,7.5,2.5,'#febc2e');dot(24,7.5,2.5,'#28c840');
 const t=title??ST.title;if(t)tx(fit(t,6.5,600,37),30.5,7.8,6.5,dark?'#9da0a8':'#6b6e76',600);
 mini(o,146,7.5,dark?CO.acc:CO.accInk)}
const PLAN=['Понять задачу','Найти данные','Посчитать','Проверить','Ответить'];
const WRITE=['Дорогой друг!','Вот итоги недели:','продажи — плюс 12%,','клиентов — плюс 48.','Всё идёт по плану.','С теплом, твой PC ♥'];
const TR=[['hello','привет'],['world','мир'],['friend','друг'],['cat','кот'],['magic','магия']];
const CODE=Array.from({length:80},(_,i)=>{const ind=[0,1,2,2,1,2,3,3,2,1,0,0][i%12],n=1+Math.floor(hash(i)*4),toks=[];for(let k=0;k<n;k++)toks.push([2+Math.floor(hash(i*7+k)*7),(i+k)%5]);return{ind,toks,len:toks.reduce((a,t)=>a+t[0]+1,0)}});
const SYN=['#ff7b72','#79c0ff','#d2a8ff','#7ee787','#ffa657'],TET=['#5b9bff','#ffb340','#5fe08a','#c58bff'];
const MONTH=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const SHAPES=(()=>{const heart=[],star=[];for(let i=0;i<=60;i++){const s=i/60*TAU;heart.push([16*Math.pow(Math.sin(s),3)*1.45,-(13*Math.cos(s)-5*Math.cos(2*s)-2*Math.cos(3*s)-Math.cos(4*s))*1.45])}
 for(let i=0;i<=10;i++){const a=-Math.PI/2+i*Math.PI/5,r=i%2?11:27;star.push([Math.cos(a)*r,Math.sin(a)*r+3])}
 return[heart,star,[[-22,26],[-22,-2],[0,-24],[22,-2],[22,26],[-22,26],[-6,26],[-6,10],[6,10],[6,26]]]})();
const MX='アイウエオカキクケコサシスセソタチツテト0123456789ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ';
const CRED=['Personal','Computer','','Идея:','ты ♥','','Корпус:','алюминий','','Экран:','светится','','Клавиатура:','с подсветкой','','Спасибо!','','Конец'];

const APPS={
 shell(t,o){win(o,'#0c0d11',1);const L=o.live||{},cmd='$ '+(String(L.cmd||'').replace(/\s+/g,' ').trim()||'…'),n=Math.min(cmd.length,Math.floor(t*24)),COLS=33,lines=[];
  for(let i=0;i<Math.max(n,1);i+=COLS)lines.push(cmd.slice(i,Math.min(n,i+COLS)));const vis=lines.slice(-6),off=lines.length-vis.length;
  vis.forEach((l,i)=>{const y=24+i*10;if(i+off===0){tx('$',6,y,7.2,CO.acc,700,'left',1);tx(l.slice(1),6+tw('$',7.2,700,1),y,7.2,'#e8eaf0',500,'left',1)}else tx(l,6,y,7.2,'#e8eaf0',500,'left',1)});
  const last=vis[vis.length-1]||'',cy=24+(vis.length-1)*10;
  if(n<cmd.length){if(Math.sin(o.T*14)>-.2)box(6+tw(last,7.2,500,1)+.6,cy-4,4,8,.8,CO.acc);return}
  const y=cy+12;
  if(L.res==='ok'){dot(9,y,3.6,CO.ok);ckm(9,y,1.9,'#0c0d11',1.2);tx('готово',16,y,7.2,'#9fe7b4',600,'left',1)}
  else if(L.res==='bad'){if(Math.sin(o.T*8)>-.3){dot(9,y,3.6,CO.err);ln(7.4,y-1.6,10.6,y+1.6,'#0c0d11',1.2);ln(10.6,y-1.6,7.4,y+1.6,'#0c0d11',1.2);tx('ошибка',16,y,7.2,'#ff9a93',600,'left',1)}}
  else{spin(9,y,3.2,o.T,CO.acc);tx('выполняю'+'.'.repeat(1+Math.floor(o.T*3)%3),16,y,7.2,'#8d9099',500,'left',1)}},
 answer(t,o){win(o,'#fbfbfd',0);const s=String((o.live||{}).ans||'').replace(/[#*_`>|~]/g,'').replace(/\s+/g,' ').trim().slice(-420);
  if(!s){for(let i=0;i<4;i++){g.globalAlpha=.5+.5*Math.sin(o.T*3-i*.6);box(7,22+i*10.4,[120,138,96,60][i],3.4,1.7,'#dfe1e6')}g.globalAlpha=1;return}const L=wrapW(s,146,7.6,500),vis=L.slice(-7);
  vis.forEach((l,i)=>tx(l,7,24+i*10.4,7.6,i===vis.length-1?'#16171b':'#55585f',500));const ll=vis[vis.length-1]||'',y=24+(vis.length-1)*10.4;if(Math.sin(o.T*10)>0)box(7+tw(ll.trim()?ll:'',7.6,500)+1,y-4.5,1.4,9,.7,CO.accInk)},
 listen(t,o){win(o,'#0c0d11',1);const a=CO.acc;g.strokeStyle=a;g.lineWidth=2;rr(g,17,30,12,22,6);g.fillStyle=rgba(a,.18);g.fill();g.stroke();
  g.beginPath();g.arc(23,44,10,.12*Math.PI,.88*Math.PI);g.stroke();ln(23,54,23,61,a,2);ln(17,62,29,62,a,2);if(Math.sin(o.T*5)>0)dot(10,24,2,'#ff453a');
  for(let i=0;i<26;i++){const v=Math.abs(Math.sin(o.T*6+i*.7)*Math.sin(o.T*2.3+i*.31))*26+Math.abs(Math.sin(o.T*11+i))*4+1.8;box(42+i*4.3,57-v/2,2.6,v,1.3,rgba(a,.45+v/50))}},
 wait(t,o){win(o,'#0c0d11',1);for(let i=0;i<12;i++){const a=i/12*TAU-Math.PI/2,k=((i/12-o.T*1.1)%1+1)%1;g.globalAlpha=.15+.85*(1-k);ln(80+Math.cos(a)*7,50+Math.sin(a)*7,80+Math.cos(a)*13,50+Math.sin(a)*13,'#e9eaee',2.6)}
  g.globalAlpha=1;tx('Жду ответ модели'+'.'.repeat(1+Math.floor(o.T*2)%3),80,80,7.2,'#8d9099',500,'center')},
 plan(t,o){win(o,'#101216',1);PLAN.forEach((s,i)=>{const y=26+i*14.6,done=t>.8*(i+1),cur=Math.floor(t/.8)===i,k=clamp((t-.8*(i+1))/.3,0,1);
  if(cur)box(4,y-6.2,152,12.4,6.2,rgba(CO.acc,.14));
  if(done){dot(13,y,4.3,CO.acc);ckm(13,y,2.2,'#0b0c10',1.3,ease(k))}else{g.beginPath();g.arc(13,y,3.8,0,TAU);g.strokeStyle=cur?CO.acc:'#4a4d55';g.lineWidth=1.3;g.stroke();if(cur)dot(13,y,1.5+Math.sin(o.T*6)*.5,CO.acc)}
  tx(s,23,y,7.6,done?'#6c6f78':cur?'#ffffff':'#a3a6ae',cur?650:500);if(done)ln(23,y+.3,23+tw(s,7.6,500)*ease(k),y+.3,'#6c6f78',.8)})},
 search(t,o){win(o,'#ffffff',0);const q=String((o.live||{}).q||'поиск').toLowerCase(),n=Math.min(q.length,Math.floor(t*7));
  rr(g,8,20,144,15,7.5);g.fillStyle='#f2f3f6';g.fill();g.strokeStyle='#dfe1e6';g.lineWidth=.7;g.stroke();lens(16.5,27,3,'#80838c',1.2);
  const qs=q.slice(0,n);tx(qs,24,27.8,7.6,'#1d1e22',500);if(Math.sin(o.T*10)>0||n<q.length)box(24+tw(qs,7.6,500)+.8,23.5,1.2,8.4,.6,CO.accInk);
  const t2=t-q.length/7;if(t2<=0)return;
  for(let i=0;i<4;i++){const y=45+i*13.5;if(t2<i*.3)continue;const k=ease(clamp((t2-i*.3)/.45,0,1));g.globalAlpha=k;dot(13,y,2.5,['#5b8cff','#ff7a59','#ffc145','#3ecf8e'][i]);
   box(20,y-3.6,(36+hash(i+3)*50)*k,3.6,1.8,i?'#2a5ee8':CO.accInk);box(20,y+2.4,(80+hash(i+9)*50)*k,2.4,1.2,'#cdd0d6');g.globalAlpha=1}
  const a=t2*1.6,mx=82+Math.cos(a)*48,my=62+Math.sin(a*2)*12;g.fillStyle='rgba(255,255,255,.35)';g.beginPath();g.arc(mx,my,8,0,TAU);g.fill();lens(mx,my,8,'#2b2d33',1.8);
  g.strokeStyle='rgba(255,255,255,.9)';g.lineWidth=1;g.beginPath();g.arc(mx,my,5.6,-2.6,-1.7);g.stroke()},
 browse(t,o){win(o,'#ffffff',0,'');rr(g,34,3.6,92,7.8,3.9);g.fillStyle='#ffffff';g.fill();g.strokeStyle='#d6d8dd';g.lineWidth=.6;g.stroke();tx('example.org',80,7.6,5.8,'#6b6e76',500,'center');
  const pg=(t%2.6)/2.6,it=[[8,20,144,26,3,1],[8,51,90,5,2.5],[8,60,120,3,1.5],[8,66,110,3,1.5],[8,72,70,3,1.5],[8,81,68,14,2.5,2],[84,81,68,14,2.5,2]];
  it.forEach(([x,y,w,h,r,k],i)=>{if(pg<i*.09)return;g.globalAlpha=ease(clamp((pg-i*.09)/.12,0,1));
   if(k===1){const gr=g.createLinearGradient(x,y,x+w,y+h);gr.addColorStop(0,mix(CO.acc,'#ffffff',.2));gr.addColorStop(1,mix(CO.w2,'#ffffff',.15));rr(g,x,y,w,h,r);g.fillStyle=gr;g.fill();dot(x+w-18,y+9,5,'rgba(255,255,255,.55)')}
   else box(x,y,w,h,r,k?'#eef0f4':i===1?'#1d1e22':'#c5c8cf');g.globalAlpha=1});
  if(!RM.matches){const sx=((o.T*.7)%1.6-.3)*200,sg=g.createLinearGradient(sx-22,0,sx+22,0);sg.addColorStop(0,'rgba(255,255,255,0)');sg.addColorStop(.5,'rgba(255,255,255,.5)');sg.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=sg;g.fillRect(0,16,160,84)}
  const Pp=[[60,32],[132,88],[40,63],[110,42]],i0=Math.floor(t/1.2)%4,i1=(i0+1)%4,k=ease(clamp((t%1.2)/.7,0,1)),ax=lerp(Pp[i0][0],Pp[i1][0],k),ay=lerp(Pp[i0][1],Pp[i1][1],k),ck=(t%1.2)-.8;
  if(ck>0&&ck<.35){g.strokeStyle=rgba(CO.accInk,1-ck/.35);g.lineWidth=1.2;g.beginPath();g.arc(ax,ay,ck*22,0,TAU);g.stroke()}arrowCursor(ax,ay)},
 read(t,o){win(o,'#e9eaee',0);g.shadowColor='rgba(0,0,0,.12)';g.shadowBlur=3*TQ;box(28,19,104,90,2,'#ffffff');g.shadowBlur=0;box(30,49.5,100,7,2,rgba(CO.accInk,.12));
  const off=t*9;for(let i=0;i<16;i++){const n=Math.floor(off/6)+i,y=24+i*6-off%6;if(y<21||y>98||n%8===7)continue;const cur=y>=50&&y<56;box(34,y-1,40+hash(n)*52,2,1,cur?CO.accInk:'#c3c6cc')}
  box(152,19,2.4,78,1.2,'rgba(0,0,0,.06)');box(152,19+((t*4)%60),2.4,18,1.2,'rgba(0,0,0,.25)')},
 process(t,o){win(o,'#0b0c10',1);const a=CO.acc;for(let c=0;c<26;c++){const s=12+hash(c)*22,head=((o.T*s+hash(c+9)*90)%100)+16;for(let k=0;k<6;k++){const y=head-k*4;if(y<17||y>99)continue;dot(4+c*6,y,.9,rgba(a,(1-k/6)*.35))}}
  const pc=(o.live||{}).pct!=null?o.live.pct:Math.floor((t*19)%100);dot(80,55,23,'#0b0c10');ring(80,55,17,4,pc/100,a);tx(pc+'%',80,55.5,10,'#ffffff',700,'center');tx('обработка данных',80,86,6.6,'#8d9099',500,'center')},
 analyze(t,o){win(o,'#0e1015',1);const a=CO.acc,tg=Math.floor(t/.9)%7;ln(10,90,94,90,'#2b2e36',.8);
  for(let i=0;i<7;i++){const hh=14+hash(i+3)*48,k=ease(clamp((t-i*.12)/.6,0,1)),h=Math.max(1,hh*k+Math.sin(o.T*3+i)*1.2);box(13+i*11.4,90-h,7,h,2.2,i===tg?a:rgba(a,.38))}
  if(t>1){g.beginPath();for(let i=0;i<7;i++){const x=16.5+i*11.4,y=78-hash(i+11)*52;i?g.lineTo(x,y):g.moveTo(x,y)}g.setLineDash([170*clamp((t-1)*1.2,0,1),400]);g.strokeStyle='#ffffff';g.lineWidth=1.3;g.lineJoin='round';g.stroke();g.setLineDash([])}
  ring(126,45,15,6,clamp(t/2,0,1)*.68+Math.sin(o.T)*.02,a,'#3a3d45');
  if(t>1.5){g.globalAlpha=ease(clamp((t-1.5)/.3,0,1));pill(126,77,'+12%',CO.ok,7.4);g.globalAlpha=1}},
 code(t,o){win(o,'#15171c',1);box(0,15,13,85,0,'#111317');let ch=Math.floor(t*34),li=0;while(li<CODE.length-1&&ch>CODE[li].len){ch-=CODE[li].len;li++}
  const first=Math.max(0,li-7);for(let r=0;r<8;r++){const i=first+r;if(i>li)break;const y=22+r*9.6,L=CODE[i];if(i===li)box(13,y-4.8,147,9.6,0,'rgba(255,255,255,.045)');
   tx(String(i+1),9.5,y+.3,5.4,i===li?'#c9ccd4':'#4c505a',500,'right',1);let x=18+L.ind*6,used=0;const lim=i<li?1e9:ch;
   for(const[len,c]of L.toks){const w=Math.min(len,lim-used);if(w<=0)break;box(x,y-1.7,w*2.4,3.4,1.7,SYN[c]);x+=len*2.4+2.4;used+=len+1}
   if(i===li&&Math.sin(o.T*12)>-.2)box(Math.min(156,18+L.ind*6+Math.min(ch,L.len)*2.4),y-4,1.2,8,.6,CO.acc)}},
 write(t,o){win(o,'#fbfbfd',0);let n=Math.floor(t*14);const rows=[];for(const s of WRITE){const v=clamp(n,0,s.length);n-=s.length+3;rows.push([s,v]);if(v<s.length)break}
  rows.slice(-7).forEach(([s,v],i)=>{const y=24+i*10.4,str=s.slice(0,v);tx(str,8,y,7.8,'#2a2c31',i===0&&rows.length<8?650:500);if(v<s.length&&Math.sin(o.T*10)>0)box(8+tw(str,7.8,500)+.8,y-4.6,1.3,9.2,.6,CO.accInk)})},
 build(t,o){win(o,'#0d0f13',1);const s=o.tetris,cs=6.6,ox=47,oy=20.5;box(ox-2,oy-2,cs*10+4,cs*11+4,3,'rgba(255,255,255,.05)');
  if(s&&s.g){const full=r=>r.every(v=>v);s.g.forEach((r,j)=>r.forEach((v,i)=>{if(!v)return;const fl=s.flash>=0&&full(r);box(ox+i*cs+.4,oy+j*cs+.4,cs-.8,cs-.8,1.6,fl&&Math.sin(o.T*40)>0?'#ffffff':TET[v%4])}));
   if(s.p){g.shadowColor=rgba(CO.acc,.8);g.shadowBlur=4*TQ;s.p.sh.forEach((r,j)=>r.forEach((v,i)=>{if(v&&s.p.y+j>=0)box(ox+(s.p.x+i)*cs+.4,oy+(s.p.y+j)*cs+.4,cs-.8,cs-.8,1.6,CO.acc)}));g.shadowBlur=0}
   tx('линии',23,34,6.2,'#80838c',500,'center');tx(String(s.lines||0),23,46,13,'#ffffff',700,'center')}
  tx(Math.min(99,Math.floor(t*9))+'%',137,34,8,'#e6e8ee',600,'center');box(122,42,30,3.4,1.7,'rgba(255,255,255,.1)');box(122,42,30*Math.min(1,t/11),3.4,1.7,CO.acc)},
 test(t,o){win(o,'#0d0f13',1);for(let i=0;i<6;i++){const y=24+i*12.4,st=.55*i;if(t<st)break;tx('test_'+(i+1),8,y,6.8,'#a7aab2',500,'left',1);const dots=Math.min(8,Math.floor((t-st)*20));for(let k=0;k<dots;k++)dot(52+k*5,y,1,'#4c505a');
  if(t>st+.45){if(i===3&&t<st+1.6){if(Math.sin(o.T*10)>-.2)pill(138,y,'FAIL',CO.err)}else pill(138,y,'OK',CO.ok)}}},
 debug(t,o){win(o,'#0d0f13',1);for(let r=0;r<8;r++)box(8+(r*5)%9*1.5,22+r*9.4,26+(r*13)%40,3.2,1.6,'rgba(255,255,255,.1)');
  const ph=t%4,bx=16+((t*13)%50)*2.4,by=34+Math.sin(t*3)*6+((Math.floor(t/4)*7)%20)*1.6;
  if(ph<3){bug(bx,by,o.T);const k=ease(clamp(ph/2.6,0,1)),cx=lerp(144,bx,k),cy=lerp(92,by,k),a=CO.acc;g.strokeStyle=a;g.lineWidth=1.3;g.beginPath();g.arc(cx,cy,7,0,TAU);g.stroke();ln(cx-11,cy,cx-4,cy,a,1.3);ln(cx+4,cy,cx+11,cy,a,1.3);ln(cx,cy-11,cx,cy-4,a,1.3);ln(cx,cy+4,cx,cy+11,a,1.3)}
  else{const k=ph-3;for(let i=0;i<10;i++){const a=i/10*TAU;dot(bx+Math.cos(a)*k*18,by+Math.sin(a)*k*13,1.7*(1-k),'#ff6b61')}g.globalAlpha=ease(clamp(k*3,0,1));pill(80,88,'баг исправлен',CO.ok,6.8);g.globalAlpha=1}},
 download(t,o){win(o,'#0d0f13',1);const p=(t%3.6)/3.6,L=o.live||{},pc=L.pct!=null?L.pct:Math.min(100,Math.floor(ease(clamp(p/.85,0,1))*100));
  g.lineCap='round';g.lineWidth=2.4;g.strokeStyle='rgba(255,255,255,.1)';g.beginPath();g.arc(80,44,15,0,TAU);g.stroke();g.strokeStyle=CO.acc;g.beginPath();g.arc(80,44,15,o.T*4,o.T*4+1.8);g.stroke();
  const ay=Math.sin(o.T*6)*2;g.strokeStyle='#ffffff';g.lineWidth=2.4;g.lineJoin='round';g.beginPath();g.moveTo(80,36+ay);g.lineTo(80,50+ay);g.moveTo(74.5,45+ay);g.lineTo(80,50.5+ay);g.lineTo(85.5,45+ay);g.stroke();
  box(20,73,120,5,2.5,'rgba(255,255,255,.1)');box(20,73,120*pc/100,5,2.5,CO.acc);tx(pc+'%',80,87,7,'#c4c7cf',600,'center')},
 upload(t,o){win(o,'#0d0f13',1);const L=o.live||{},pc=L.pct!=null?L.pct:Math.floor((t*30)%101);cloud(80,44,1.25,'rgba(255,255,255,.14)');
  const k=(o.T*.9)%1,ay=50-k*14;g.globalAlpha=Math.sin(k*Math.PI);g.strokeStyle=CO.acc;g.lineWidth=2.4;g.lineCap=g.lineJoin='round';g.beginPath();g.moveTo(80,ay+9);g.lineTo(80,ay-4);g.moveTo(74.5,ay+1);g.lineTo(80,ay-4.5);g.lineTo(85.5,ay+1);g.stroke();g.globalAlpha=1;
  box(20,73,120,5,2.5,'rgba(255,255,255,.1)');box(20,73,120*pc/100,5,2.5,CO.acc);tx(pc+'%',80,87,7,'#c4c7cf',600,'center')},
 send(t,o){win(o,'#f6f7f9',0);const p=(t%3)/3;
  if(p<.5){const k=ease(clamp((p-.12)/.3,0,1));g.shadowColor='rgba(0,0,0,.12)';g.shadowBlur=4*TQ;box(52,36,56,38,4,'#ffffff');g.shadowBlur=0;
   g.save();g.translate(80,57);const s=1-k*.3;g.scale(s,s);heartPath(g,0,0,26);g.fillStyle='#ff4d7a';g.fill();g.restore();
   g.beginPath();g.moveTo(52,36);g.lineTo(108,36);g.lineTo(80,lerp(14,58,k));g.closePath();g.fillStyle='#eef0f4';g.fill();g.strokeStyle='#d5d8de';g.lineWidth=.8;g.stroke()}
  else{const k=(p-.5)/.5,x=10+k*170,y=72-k*46+Math.sin(k*12)*3;g.setLineDash([2.4,2.6]);g.strokeStyle='#b5b9c1';g.lineWidth=.9;g.beginPath();for(let i=0;i<=20;i++){const kk=Math.max(0,k-i*.02),xx=10+kk*170,yy=72-kk*46+Math.sin(kk*12)*3;i?g.lineTo(xx,yy):g.moveTo(xx-6,yy+2)}g.stroke();g.setLineDash([]);
   g.save();g.translate(x,y);g.rotate(-.35);g.beginPath();g.moveTo(-8,-5);g.lineTo(9,0);g.lineTo(-8,5);g.lineTo(-4,0);g.closePath();g.fillStyle='#ffffff';g.fill();g.strokeStyle='#3a3d45';g.lineWidth=.8;g.lineJoin='round';g.stroke();ln(-4,0,9,0,'#3a3d45',.6);g.restore();
   if(k>.4){g.globalAlpha=ease(clamp((k-.4)/.2,0,1));pill(80,90,'отправлено',CO.ok,6.8);g.globalAlpha=1}}},
 memory(t,o){win(o,'#0d0f13',1);const cols=['#ff5c86','#ffc145','#5b9bff','#5fe08a'],cyc=Math.floor(t/9);
  const ord=[0,1,2,3,0,1,2,3].map((v,i)=>[v,hash(i*3+cyc*17)]).sort((a,b)=>a[1]-b[1]).map(a=>a[0]),ph=t%9,matched=Math.min(4,Math.floor(ph/1.6)),peek=Math.floor(ph*2.5)%8;
  for(let i=0;i<8;i++){const open=ord[i]<matched||(i===peek&&matched<4);ST.cards[i]=approach(ST.cards[i],open?1:0,12,clamp(o.dt||.016,0,.1));const f=ST.cards[i],sx=Math.max(.05,Math.abs(Math.cos(f*Math.PI))),front=f>.5;
   const x=22+(i%4)*38.7,y=36+Math.floor(i/4)*34;g.save();g.translate(x,y);g.scale(sx,1);
   if(front){box(-15,-14,30,28,4,'#f4f5f8');sym(ord[i],cols[ord[i]]);if(ord[i]<matched){rr(g,-15,-14,30,28,4);g.strokeStyle=CO.ok;g.lineWidth=1.4;g.stroke()}}
   else{const gr=g.createLinearGradient(0,-14,0,14);gr.addColorStop(0,mix(CO.acc,'#ffffff',.15));gr.addColorStop(1,mix(CO.acc,'#0d0f13',.45));rr(g,-15,-14,30,28,4);g.fillStyle=gr;g.fill();g.strokeStyle='rgba(255,255,255,.35)';g.lineWidth=1;g.beginPath();g.arc(0,0,6,0,TAU);g.stroke()}
   g.restore()}
  if(matched>=4)pill(80,92,'все пары!',CO.ok,6.8)},
 translate(t,o){win(o,'#0d0f13',1);const i=Math.floor(t/2.4)%TR.length,k=(t%2.4)/2.4,[a,b]=TR[i];
  pill(20,32,'EN','#a7aab2',6.2);tx(a,34,32,10,'#e8eaf0',600);for(let j=0;j<3;j++)dot(20,45+j*5,1.3,Math.floor(o.T*6)%3===j?CO.acc:'#3a3d45');
  pill(20,68,'RU',CO.acc,6.2);if(k>.2)tx(b.split('').map((c,j)=>k>.3+j*.08?c:'#*%@&'[Math.floor(Math.random()*5)]).join(''),34,68,10,CO.acc,700)},
 draw(t,o){win(o,'#fbfbfd',0);const cols=[CO.accInk,'#ff5c86','#ffb340','#5b9bff'],ci=Math.floor(t/6)%4;
  for(let i=0;i<4;i++){dot(11,30+i*13,4.4,cols[i]);if(ci===i){g.beginPath();g.arc(11,30+i*13,6.4,0,TAU);g.strokeStyle='#1d1e22';g.lineWidth=1;g.stroke()}}
  const pts=SHAPES[Math.floor(t/6)%SHAPES.length],k=clamp((t%6)/4.5,0,1);let len=0;const seg=[];for(let i=1;i<pts.length;i++){const l=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]);seg.push(l);len+=l}
  g.save();g.translate(94,58);g.beginPath();pts.forEach((p,i)=>i?g.lineTo(p[0],p[1]):g.moveTo(p[0],p[1]));if(k>=1){g.globalAlpha=.18;g.fillStyle=cols[ci];g.fill();g.globalAlpha=1}
  g.setLineDash([len*k,len+1]);g.strokeStyle=cols[ci];g.lineWidth=2.6;g.lineCap=g.lineJoin='round';g.stroke();g.setLineDash([]);
  if(k<1){let r=len*k,i=0;while(i<seg.length-1&&r>seg[i]){r-=seg[i];i++}const a=pts[i],b=pts[i+1]||a,q=seg[i]?r/seg[i]:0,px=lerp(a[0],b[0],q),py=lerp(a[1],b[1],q);
   g.save();g.translate(px,py);g.rotate(-.6);rr(g,-1.4,-14,2.8,12,1.2);g.fillStyle='#3a3d45';g.fill();g.beginPath();g.moveTo(-1.4,-2);g.lineTo(1.4,-2);g.lineTo(0,1);g.closePath();g.fillStyle=cols[ci];g.fill();g.restore()}
  g.restore()},
 calc(t,o){win(o,'#0d0f13',1);for(let i=0;i<12;i++){const x=12+(i%3)*11,y=30+Math.floor(i/3)*16;dot(x,y,4,Math.floor(o.T*5)%12===i?CO.acc:'#2a2d34')}
  tx(String(Math.floor(t*137)%10000),152,32,20,'#ffffff',300,'right');const F2=['2 + 2 = 4','7 × 6 = 42','π ≈ 3,1415','√81 = 9','12 ÷ 4 = 3','2¹⁰ = 1024','99 + 1 = 100'],off=Math.floor(t*1.5);
  for(let i=0;i<3;i++)tx(F2[(off+i)%F2.length],152,56+i*12,7.6,i===2?CO.acc:'#6f727b',500,'right')},
 calendar(t,o){win(o,'#ffffff',0);const d=new Date(),y0=d.getFullYear(),m=d.getMonth(),first=(new Date(y0,m,1).getDay()+6)%7,days=new Date(y0,m+1,0).getDate();
  tx(MONTH[m]+' '+y0,8,24,8,'#1d1e22',700);'ПВСЧПСВ'.split('').forEach((c,i)=>tx(c,14+i*21.5,35,5.6,i>4?'#e5484d':'#8d9099',600,'center'));
  for(let i=0;i<days;i++){const r=Math.floor((i+first)/7),cc=(i+first)%7,x=14+cc*21.5,y=44+r*9.4;if(r>5)continue;
   if(i+1===d.getDate()){dot(x,y,4.6+Math.sin(o.T*4)*.4,CO.accInk);tx(String(i+1),x,y+.3,6,'#ffffff',700,'center')}else tx(String(i+1),x,y+.3,6,cc>4?'#e5484d':'#2a2c31',500,'center')}},
 music(t,o){win(o,'#0d0f13',1);const gr=g.createLinearGradient(10,21,48,59);gr.addColorStop(0,CO.acc);gr.addColorStop(1,'#ff5c86');rr(g,10,21,38,38,6);g.fillStyle=gr;g.fill();
  g.save();g.translate(29,40);g.rotate(Math.sin(o.T*2)*.12);tx('♪',0,0,20,'rgba(255,255,255,.92)',700,'center');g.restore();
  tx('Lo-fi радио',56,28,8.4,'#ffffff',700);tx('PC FM',56,39,7,'#8d9099',500);const k=(o.T*.02)%1;box(56,50,94,2.6,1.3,'rgba(255,255,255,.14)');box(56,50,94*k,2.6,1.3,'#ffffff');dot(56+94*k,51.3,2.5,'#ffffff');
  for(let i=0;i<22;i++){const h=Math.abs(Math.sin(o.T*7+i*.9)*Math.sin(o.T*3.1+i*.4))*20+2;box(10+i*6.6,95-h,4,h,2,rgba(CO.acc,.35+h/40))}},
 update(t,o){win(o,'#0d0f13',1);const L=o.live||{},pc=L.pct!=null?L.pct:Math.min(100,Math.floor(t*6));const gr=g.createLinearGradient(70,26,90,48);gr.addColorStop(0,CO.acc);gr.addColorStop(1,CO.w2);rr(g,69,26,22,22,6);g.fillStyle=gr;g.fill();
  g.save();g.translate(80,37);g.rotate(o.T*3);g.strokeStyle='#ffffff';g.lineWidth=1.8;g.lineCap='round';g.beginPath();g.arc(0,0,5.5,.3,2.6);g.stroke();g.beginPath();g.arc(0,0,5.5,3.4,5.7);g.stroke();g.restore();
  tx('Обновление… '+pc+'%',80,61,7.4,'#e8eaf0',600,'center');box(30,69,100,4,2,'rgba(255,255,255,.12)');box(30,69,pc,4,2,CO.acc);tx('не выключайте компьютер',80,84,6,'#7c7f88',500,'center')},
 game(t,o){const s=o.snake;win(o,'#0b0d10',1,'Змейка'+(s?' · '+s.score:''));const cs=4.6,ox=6.4,oy=19.5;box(ox-1.4,oy-1.4,32*cs+2.8,16*cs+2.8,3,'rgba(255,255,255,.035)');if(!s||!s.b)return;
  const ax=ox+(s.a[0]+.5)*cs,ay=oy+(s.a[1]+.5)*cs;g.shadowColor='rgba(255,69,58,.8)';g.shadowBlur=4*TQ;dot(ax,ay+.3,2.2+Math.sin(o.T*6)*.25,'#ff453a');g.shadowBlur=0;g.fillStyle='#5fe08a';g.beginPath();g.ellipse(ax+1,ay-2.2,1.3,.7,-.6,0,TAU);g.fill();
  const dead=s.dead>0,col=dead?(Math.sin(o.T*30)>0?'#ff453a':'#ffffff'):CO.acc;g.strokeStyle=col;g.lineWidth=cs*.8;g.lineCap=g.lineJoin='round';g.beginPath();
  s.b.forEach((b,i)=>{const x=ox+(b[0]+.5)*cs,y=oy+(b[1]+.5)*cs;if(!i){g.moveTo(x,y);return}const p=s.b[i-1];if(Math.abs(p[0]-b[0])>1||Math.abs(p[1]-b[1])>1)g.moveTo(x,y);else g.lineTo(x,y)});g.stroke();
  const h=s.b[0],hx=ox+(h[0]+.5)*cs,hy=oy+(h[1]+.5)*cs,dx=s.d[0],dy=s.d[1];dot(hx,hy,cs*.55,col);dot(hx+dx*.9-dy*1.1,hy+dy*.9+dx*1.1,.65,'#0b0d10');dot(hx+dx*.9+dy*1.1,hy+dy*.9-dx*1.1,.65,'#0b0d10');
  if(dead){box(46,46,68,20,6,'rgba(0,0,0,.7)');tx('Game over',80,56.3,8.6,'#ffffff',700,'center')}},
 pong(t,o){win(o,'#0b0d10',1);for(let y=19;y<98;y+=6)box(79.3,y,1.4,3,.7,'rgba(255,255,255,.18)');const s=o.pong;if(!s)return;const X=x=>x/68*160,Y=y=>17+(y-11)/33*81;
  tx(String(s.sa),64,27,12,'rgba(255,255,255,.3)',700,'center');tx(String(s.sb),96,27,12,'rgba(255,255,255,.3)',700,'center');
  box(X(3)-1,Y(s.a)-9,3.4,18,1.7,'#ffffff');box(X(63)-1,Y(s.b)-9,3.4,18,1.7,'#ffffff');
  ST.trail.forEach(([x,y],i)=>dot(X(x),Y(y),2.4*(i+1)/ST.trail.length,rgba(CO.acc,(i+1)/ST.trail.length*.35)));g.shadowColor=rgba(CO.acc,.9);g.shadowBlur=5*TQ;dot(X(s.x),Y(s.y),2.6,CO.acc);g.shadowBlur=0},
 terminal(t,o){win(o,'#0c0d11',1);const T2=o.term||{lines:[],buf:''},lines=T2.lines.slice(-6);lines.forEach((l,i)=>{const inp=l.startsWith('>');tx(inp?'> '+l.slice(1):l.toLowerCase(),6,24+i*10,7.2,inp?'#e8eaf0':CO.acc,500,'left',1)});
  const y=24+lines.length*10;if(y<96){const c='> '+T2.buf.slice(-28);tx(c,6,y,7.2,'#ffffff',500,'left',1);if(Math.sin(o.T*10)>0)box(6+tw(c,7.2,500,1)+.6,y-4,4,8,.8,CO.acc)}},
};
/* значки карточек «Памяти»: сердце, звезда, нота, круг */
function sym(i,col){g.fillStyle=g.strokeStyle=col;if(i===0){heartPath(g,0,1,15);g.fill()}else if(i===1){sparkle(g,0,0,8,2.2);g.fill()}
 else if(i===2){g.beginPath();g.ellipse(-2,4,3.2,2.3,-.45,0,TAU);g.fill();g.lineWidth=1.6;g.lineCap='round';g.beginPath();g.moveTo(.9,3.6);g.lineTo(.9,-6);g.quadraticCurveTo(5,-4.6,4.6,-.8);g.stroke()}else dot(0,0,5.5,col)}
function bug(x,y,T){g.save();g.translate(x,y);g.rotate(Math.sin(T*3)*.4);g.strokeStyle='#1d1e22';g.lineWidth=.7;for(let i=-1;i<=1;i++){const w=Math.sin(T*20+i)*.8;ln(-3.6,i*2.4,-6.4,i*2.8+w,'#c9ccd4',.7);ln(3.6,i*2.4,6.4,i*2.8-w,'#c9ccd4',.7)}
 g.fillStyle='#ff453a';g.beginPath();g.ellipse(0,1,4.4,5,0,0,TAU);g.fill();ln(0,-3.6,0,6,'#14090a',.7);dot(0,-4.4,2.4,'#14090a');[[-2,0],[2,2.4],[-1.8,3.6],[2,-.8]].forEach(([a,b])=>dot(a,b,.8,'#14090a'));g.restore()}
/* заставка (экран целиком, без окна): шарики, звёзды, «флурри», аквариум */
function saver(t,o){const m=Math.floor(t/9)%4,T=RM.matches?t*.3:o.T;g.fillStyle='#030406';g.fillRect(0,0,160,100);
 if(m===0)for(let i=0;i<7;i++){const r=10+hash(i)*16,x=80+Math.sin(T*(.2+hash(i+1)*.3)+i*2)*70,y=50+Math.cos(T*(.17+hash(i+2)*.25)+i)*40,c=['#5b9bff','#ff5c86','#ffc145','#5fe08a','#c58bff'][i%5],gr=g.createRadialGradient(x-r*.35,y-r*.35,r*.1,x,y,r);gr.addColorStop(0,rgba(c,.95));gr.addColorStop(.7,rgba(c,.42));gr.addColorStop(1,rgba(c,0));g.fillStyle=gr;g.beginPath();g.arc(x,y,r,0,TAU);g.fill()}
 else if(m===1)for(let i=0;i<70;i++){const z=1-((T*.35+hash(i))%1),z2=z+.06,hx=hash(i+1)-.5,hy=hash(i+2)-.5,x=80+hx*120/z,y=50+hy*80/z;if(x<-5||x>165||y<-5||y>105)continue;ln(80+hx*120/z2,50+hy*80/z2,x,y,rgba('#ffffff',clamp(1.2-z,0,1)),Math.max(.4,(1-z)*1.8))}
 else if(m===2){g.globalCompositeOperation='lighter';for(let k=0;k<4;k++){const c=['#5b9bff','#ff5c86','#5fe08a','#ffc145'][k];g.beginPath();for(let i=0;i<=40;i++){const s=i/40,a=T*.7+k*1.6+s*4,r=10+s*52,x=80+Math.cos(a+Math.sin(T*.5+k)*1.4)*r*(1+.2*Math.sin(T+k)),y=50+Math.sin(a*1.3)*r*.55;i?g.lineTo(x,y):g.moveTo(x,y)}
  g.strokeStyle=rgba(c,.55);g.lineWidth=2.4;g.lineCap='round';g.stroke();g.strokeStyle='rgba(255,255,255,.25)';g.lineWidth=.8;g.stroke()}g.globalCompositeOperation='source-over'}
 else{const gr=g.createLinearGradient(0,0,0,100);gr.addColorStop(0,'#06263a');gr.addColorStop(1,'#020a12');g.fillStyle=gr;g.fillRect(0,0,160,100);
  for(let i=0;i<4;i++){g.strokeStyle='#1f8a5a';g.lineWidth=2.2;g.lineCap='round';g.beginPath();const bx=18+i*40;g.moveTo(bx,100);for(let j=1;j<=6;j++)g.lineTo(bx+Math.sin(T*1.5+j*.8+i)*3*j/6,100-j*5);g.stroke()}
  for(let i=0;i<5;i++){const dir=i%2?-1:1,sp=10+i*3,x=dir>0?((t*sp+i*40)%200)-20:180-((t*sp+i*40)%200),y=20+i*14+Math.sin(t+i)*3,c=['#ff9f45','#5b9bff','#ffc145','#ff5c86','#5fe08a'][i];
   g.save();g.translate(x,y);g.scale(dir,1);g.fillStyle=c;g.beginPath();g.ellipse(0,0,7,4.2,0,0,TAU);g.fill();g.beginPath();g.moveTo(-5,0);g.lineTo(-11,-4+Math.sin(T*8+i)*1.2);g.lineTo(-11,4+Math.sin(T*8+i)*1.2);g.closePath();g.fill();dot(3.6,-1,1,'#0a0a0c');g.restore()}
  for(let i=0;i<9;i++){const y=100-((t*10+i*11)%100);g.strokeStyle='rgba(255,255,255,.4)';g.lineWidth=.6;g.beginPath();g.arc(12+i*17+Math.sin(T*2+i)*2,y,1.1+(i%3)*.5,0,TAU);g.stroke()}}}
/* картинки на весь экран: готово, ошибка, выключение, загрузка, синий экран и секреты */
function logo(x,y,s,a){g.save();g.globalAlpha=a;g.translate(x,y);const gr=g.createLinearGradient(-s/2,-s/2,s/2,s/2);gr.addColorStop(0,CO.acc);gr.addColorStop(1,CO.w2);rr(g,-s/2,-s/2,s,s,s*.27);g.fillStyle=gr;g.fill();
 g.fillStyle='#ffffff';rr(g,-s*.22,-s*.2,s*.13,s*.24,s*.065);g.fill();rr(g,s*.09,-s*.2,s*.13,s*.24,s*.065);g.fill();g.strokeStyle='#ffffff';g.lineWidth=s*.07;g.lineCap='round';g.beginPath();g.arc(0,s*.1,s*.14,.25,Math.PI-.25);g.stroke();g.restore()}
const FULL={
 check(t,o){wall(o,.6);const k=easeBack(clamp(t/.4,0,1));g.shadowColor=rgba(CO.ok,.8);g.shadowBlur=10*TQ;dot(80,44,19*k,CO.ok);g.shadowBlur=0;ckm(80,45,8,'#ffffff',4,ease(clamp((t-.15)/.35,0,1)));
  g.globalAlpha=clamp((t-.3)/.3,0,1);tx('Готово',80,82,10,'#ffffff',700,'center');g.globalAlpha=1},
 err(t,o){g.fillStyle='#140809';g.fillRect(0,0,160,100);blob(80,40,90,'#ff3b30',.35);const j=RM.matches?0:(Math.random()<.25?(Math.random()-.5)*6:0);
  g.save();g.translate(80+j,38);g.beginPath();g.moveTo(0,-14);g.lineTo(14,10);g.lineTo(-14,10);g.closePath();g.fillStyle=g.strokeStyle='#ff453a';g.lineWidth=5;g.lineJoin='round';g.stroke();g.fill();tx('!',0,2.5,15,'#ffffff',800,'center');g.restore();
  tx('Ошибка',80+j,66,10,'#ffffff',700,'center');tx((o.live||{}).code||'0X0BAD',80,79,6.8,'rgba(255,255,255,.6)',500,'center',1);
  if(!RM.matches&&Math.random()<.35){const y=Math.random()*100,h=2+Math.random()*6;g.fillStyle='rgba(255,69,58,.25)';g.fillRect(0,y,160,h);g.fillStyle='rgba(0,229,255,.18)';g.fillRect((Math.random()-.5)*10,y+h*.5,160,1)}},
 off(t){g.fillStyle='#000';g.fillRect(0,0,160,100);const k=clamp(t/.7,0,1);
  if(k<.45){const h=Math.max(1.4,100*(1-ease(k/.45)));g.globalAlpha=.35+.65*k/.45;box(0,50-h/2,160,h,h*.1,'#ffffff');g.globalAlpha=1}
  else if(k<.9){const w=Math.max(2,160*(1-ease((k-.45)/.45)));box(80-w/2,49.2,w,1.6,.8,'#ffffff')}else dot(80,50,.3+1.6*(1-(k-.9)/.1),'#ffffff')},
 boot(t){g.fillStyle='#000';g.fillRect(0,0,160,100);const u=t-1.5;if(u<0)return;const a=ease(clamp(u/.6,0,1));logo(80,42,20*(.86+.14*a),a);
  if(u>.9){const p=clamp((u-.9)/1.7,0,1);box(56,72,48,2.4,1.2,'rgba(255,255,255,.18)');box(56,72,48*ease(p),2.4,1.2,'#ffffff')}},
 bsod(t){g.fillStyle='#1660d8';g.fillRect(0,0,160,100);tx(':(',12,24,24,'#ffffff',300);tx('Возникла проблема, и компьютер',12,50,6.6,'#ffffff',500);tx('нужно перезагрузить.',12,59,6.6,'#ffffff',500);
  tx(Math.min(100,Math.floor(t*14))+'% готово',12,72,6.6,'#ffffff',500);g.fillStyle='#ffffff';for(let i=0;i<49;i++)if(hash(i*5+3)>.45||[0,6,42].some(c=>i===c))g.fillRect(12+(i%7)*1.9,80+Math.floor(i/7)*1.9,1.9,1.9);tx('слишком милый, чтобы падать',30,86.5,5.2,'rgba(255,255,255,.8)',500)},
 matrix(t){g.fillStyle='#000';g.fillRect(0,0,160,100);F(g,6,500,1);g.textAlign='center';g.textBaseline='middle';
  for(let c=0;c<27;c++){const s=10+hash(c)*16,head=(t*s*2.4+hash(c+9)*140)%150;for(let k=0;k<12;k++){const y=head-k*6.2;if(y<-4||y>104)continue;g.fillStyle=k?rgba('#30ff7a',(1-k/12)*.85):'#e9ffef';g.fillText(MX[(c*7+k+Math.floor(t*8+hash(c+k)*9))%MX.length],3+c*5.9,y)}}
  const msgs=['Wake up, Neo…','The Matrix has you…','Follow the white rabbit.','Knock, knock.'],i=Math.floor(t/2.2)%4,n=Math.floor((t%2.2)*14);box(14,40,132,20,4,'rgba(0,0,0,.85)');tx(msgs[i].slice(0,n),20,50.4,7.4,'#4dff8f',500,'left',1)},
 demo(t,o){const W=40,H=25,im=QG.createImageData(W,H),dd=im.data;for(let y=0;y<H;y++)for(let x=0;x<W;x++){const X=x*4,Y=y*4,v=(Math.sin(X*.15+t*2)+Math.sin(Y*.2-t*1.5)+Math.sin((X+Y)*.1+t)+Math.sin(Math.hypot(X-80,Y-50)*.12-t*3))/4,p=(y*W+x)*4;
   dd[p]=128+127*Math.cos(TAU*(v+t*.1));dd[p+1]=128+127*Math.cos(TAU*(v+t*.1+.33));dd[p+2]=128+127*Math.cos(TAU*(v+t*.1+.67));dd[p+3]=255}
  QG.putImageData(im,0,0);g.imageSmoothingEnabled=true;g.drawImage(QC,0,0,160,100);
  const m='  PC DEMO 2026 ✦ привет всем, кто любит красивое ✦ ',o2=(t*34)%(m.length*9);F(g,13,800);g.textAlign='center';g.textBaseline='middle';
  for(let k=0;k<m.length;k++){const x=k*9-o2+160;if(x<-10||x>170)continue;const y=50+Math.sin(k*.6+t*4)*12;g.fillStyle='rgba(0,0,0,.45)';g.fillText(m[k],x+1,y+1.2);g.fillStyle='#ffffff';g.fillText(m[k],x,y)}},
 credits(t,o){wall(o,.5);CRED.forEach((s,i)=>{const y=104+i*10.5-t*13.8;if(y<-6||y>106)return;const lab=s.endsWith(':');tx(s,80,y,lab?6.4:8.6,lab?'rgba(255,255,255,.55)':'#ffffff',lab?500:700,'center')})},
 answer(t,o){wall(o,.6);const k=easeBack(clamp(t/.6,0,1));g.save();g.translate(80,40);g.scale(k,k);tx('42',0,0,34,'#ffffff',800,'center');g.restore();
  if(t>1)tx('ответ на главный вопрос',80,70,7,'rgba(255,255,255,.8)',500,'center');if(t>1.6)tx('жизни, вселенной и всего такого',80,80,7,'rgba(255,255,255,.55)',500,'center')},
 rmrf(t,o){g.fillStyle='#0c0d11';g.fillRect(0,0,160,100);
  if(t<2.5){tx('$ rm -rf /',6,10,7.4,'#ff6b61',600,'left',1);['sys','usr','bin','home','кот?!'].slice(0,Math.min(5,Math.floor(t*10))).forEach((s,i)=>tx('удаляю /'+s,6,22+i*10,7,i===4?'#ff6b61':'#a7aab2',500,'left',1));box(6,86,148,3,1.5,'rgba(255,255,255,.1)');box(6,86,Math.min(148,t*60),3,1.5,'#ff453a')}
  else{const k=easeBack(clamp((t-2.5)/.4,0,1));g.save();g.translate(80,40);g.scale(k,k);tx('Шучу!',0,0,20,'#ffffff',800,'center');g.restore();tx('всё на месте ;)',80,68,8,CO.acc,600,'center')}},
 sudo(t){g.fillStyle='#0c0d11';g.fillRect(0,0,160,100);tx('$ sudo',6,12,7.4,'#e8eaf0',600,'left',1);tx('пароль: '+'•'.repeat(Math.min(6,Math.floor(t*8))),6,24,7.4,'#8d9099',500,'left',1);
  if(t>1){const k=easeBack(clamp((t-1)/.4,0,1));g.save();g.translate(80,60);g.scale(k,k);g.shadowColor='rgba(52,199,89,.8)';g.shadowBlur=8*TQ;tx('ACCESS GRANTED',0,0,13,'#5fe08a',800,'center');g.restore()}},
 cheat(t,o){g.fillStyle='hsl('+((o.T*200)%360)+',90%,60%)';g.fillRect(0,0,160,100);for(let i=0;i<8;i++){const x=((i*30+o.T*60)%240)-40;g.fillStyle='hsl('+((i*45+o.T*200)%360)+',90%,60%)';g.beginPath();g.moveTo(x,0);g.lineTo(x+30,0);g.lineTo(x-10,100);g.lineTo(x-40,100);g.closePath();g.fill()}
  box(26,36,108,28,14,'rgba(0,0,0,.78)');tx('CHEAT MODE ON!',80,50.5,11,'#ffffff',800,'center')},
};

/* кадр экрана: фон, лицо или программа, плавная смена программ, яркость */
function display(o){g=DG;const q=TQ,d=o.d,st=o.st||{},mode=d.mode||st.mode||'face',app=st.app,full=d.full||st.full,L=o.live||{};
 const key=mode==='face'?'face':mode+':'+(mode==='full'?full:app);
 if(key!==ST.key){if(ST.key&&!RM.matches){PG.setTransform(1,0,0,1,0,0);PG.clearRect(0,0,PC.width,PC.height);PG.drawImage(DC,0,0);ST.trT=o.T}ST.key=key}
 ST.title=['read','code','write'].includes(app)&&L.bar?String(L.bar).toLowerCase():st.label||'';
 g.setTransform(q,0,0,q,0,0);g.globalAlpha=1;g.globalCompositeOperation='source-over';g.shadowBlur=0;g.setLineDash([]);
 const at=st.loop?o.t%st.loop:o.t;
 try{if(mode==='face')face(o);else if(mode==='app')(APPS[app]||APPS.wait)(at,o);else if(mode==='raw')saver(at,o);else(FULL[full]||FULL.check)(o.t,o)}
 catch(e){if(!display.err){display.err=1;console.error('Personal Computer (современная тема):',e)}}
 g.setTransform(1,0,0,1,0,0);g.globalAlpha=1;g.shadowBlur=0;g.globalCompositeOperation='source-over';
 const tk=(o.T-ST.trT)/.3;if(tk<1&&tk>=0){g.globalAlpha=1-smooth(tk);g.drawImage(PC,0,0);g.globalAlpha=1}
 const pw=clamp(o.power??1,0,1);if(pw<.995){g.fillStyle='rgba(0,0,0,'+(1-pw).toFixed(3)+')';g.fillRect(0,0,DC.width,DC.height)}}

/* ================= НОУТБУК ================= */
function poly(c,p,r=0){const n=p.length;c.beginPath();const mid=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];const m=mid(p[n-1],p[0]);c.moveTo(m[0],m[1]);
 for(let i=0;i<n;i++){const q=p[i],a=p[(i+n-1)%n],b=p[(i+1)%n],nx=mid(q,b);if(r){const rr2=Math.min(r,Math.hypot(q[0]-a[0],q[1]-a[1])/2,Math.hypot(b[0]-q[0],b[1]-q[1])/2);c.arcTo(q[0],q[1],nx[0],nx[1],rr2)}else c.lineTo(q[0],q[1])}c.closePath()}
const deckQ=(x0,x1,z0,z1)=>[pj(x0,z1*BD,BT),pj(x1,z1*BD,BT),pj(x1,z0*BD,BT),pj(x0,z0*BD,BT)];
function keyboard(c,o,P){poly(c,deckQ(-42.5,42.5,.5,.925),1.6);c.fillStyle=P.well;c.fill();let n=0;const keys=o.keys||[];
 for(const[z0,z1,ws]of KR){const tot=ws.reduce((a,b)=>a+b,0),gap=.85,unit=(83-gap*(ws.length-1))/tot;let x=-41.5;
  for(const kw of ws){const w=kw*unit,idx=kw>4?60:(n++)%60,pr=clamp((keys[idx]||0)/.14,0,1),p=deckQ(x,x+w,z0,z1);if(pr>0)p.forEach(q=>{q[1]+=pr*.3});
   poly(c,p,.5);c.fillStyle=P.key;c.fill();if(pr>.02){c.fillStyle=rgba(P.lit,pr*.85);c.fill()}x+=w+gap}}}
function laptop(c,o,P,A){const a=A*RAD;LCA=Math.cos(a);LSA=Math.sin(a);const yT=-BT*CE,pw=clamp(o.power??1,0,1),vis=Math.sin(a-EL);
 /* передний торец с выемкой для пальца */
 let gr=c.createLinearGradient(0,yT,0,0);gr.addColorStop(0,P.lip0);gr.addColorStop(1,P.lip1);c.fillStyle=gr;poly(c,[[-BW/2,yT],[BW/2,yT],[BW/2-.6,0],[-BW/2+.6,0]],1.2);c.fill();
 c.fillStyle=P.scoop;c.beginPath();c.ellipse(0,yT+.05,8,1.1,0,0,Math.PI);c.fill();
 /* индикатор сна — «дышит» */
 if(o.d.led===3){const b=.25+.75*Math.abs(Math.sin(o.T*1.6));c.shadowColor='rgba(255,255,255,'+b+')';c.shadowBlur=3*K;c.fillStyle='rgba(255,255,255,'+b+')';c.beginPath();c.ellipse(40,yT*.5,.9,.42,0,0,TAU);c.fill();c.shadowBlur=0}
 /* верхняя панель: алюминий, клавиатура, трекпад, наклейка-радуга */
 const deck=deckQ(-BW/2,BW/2,0,1);gr=c.createLinearGradient(0,deck[0][1],0,deck[3][1]);gr.addColorStop(0,P.a2);gr.addColorStop(1,P.a1);c.fillStyle=gr;poly(c,deck,2.4);c.fill();
 c.save();poly(c,deck,2.4);c.clip();
 c.fillStyle=P.a0;c.globalAlpha=.85;c.fillRect(-BW/2,yT-.5,BW,.5);c.globalAlpha=1;
 keyboard(c,o,P);
 poly(c,deckQ(-17,17,.07,.42),1.3);c.fillStyle=P.tp;c.fill();c.strokeStyle=P.tpE;c.lineWidth=.35;c.stroke();
 poly(c,deckQ(31,41,.13,.33),.9);c.fillStyle='#fbfbfc';c.fill();['#ff5f57','#febc2e','#ffd60a','#28c840','#3b82f6'].forEach((col,i)=>{poly(c,deckQ(32.2+i*1.6,33.6+i*1.6,.17,.29),.3);c.fillStyle=col;c.fill()});
 /* свет экрана ложится на клавиатуру */
 if(vis>0&&pw>.05&&ST.key){const h=pj(0,BD,BT),gl=c.createRadialGradient(0,h[1],0,0,h[1],54),sc=ST.key==='face'?CO.glow:CO.acc;gl.addColorStop(0,rgba(sc,.13*pw*vis));gl.addColorStop(1,rgba(sc,0));c.fillStyle=gl;c.fillRect(-BW/2,h[1],BW,-h[1])}
 c.restore();
 if(vis>0)lidFront(c,o,P);else lidBack(c,P)}
function lidFront(c,o,P){const q=[LP(-LW/2,LL),LP(LW/2,LL),LP(LW/2,0),LP(-LW/2,0)];
 /* шарнир */
 const h0=pj(-LW/2+7,ZH,HH),h1=pj(LW/2-7,ZH,HH);c.fillStyle=P.lip1;rr(c,h0[0],h0[1]-1.2,h1[0]-h0[0],2.2,1.1);c.fill();
 poly(c,q,3.2);c.fillStyle=P.rim;c.fill();
 const gq=[LP(-LW/2+.7,LL-.7),LP(LW/2-.7,LL-.7),LP(LW/2-.7,.7),LP(-LW/2+.7,.7)];poly(c,gq,2.6);c.fillStyle='#050506';c.fill();
 /* дисплей: картинка экрана, натянутая на плоскость крышки */
 const tl=LP(DU0,DV1),tr=LP(DU1,DV1),bl=LP(DU0,DV0),br=LP(DU1,DV0),ml=LP(DU0,(DV0+DV1)/2),mr=LP(DU1,(DV0+DV1)/2);
 c.save();poly(c,[tl,tr,br,bl],1.2);c.clip();
 /* крышка в перспективе чуть сужается кверху — картинку кладём по средней ширине (аффинно), края прячет рамка */
 const W=DC.width,H=DC.height,hx=mr[0]-ml[0],hy=mr[1]-ml[1],tc=[(tl[0]+tr[0])/2,(tl[1]+tr[1])/2],bc=[(bl[0]+br[0])/2,(bl[1]+br[1])/2];
 c.transform(hx/W,hy/W,(bc[0]-tc[0])/H,(bc[1]-tc[1])/H,tc[0]-hx/2,tc[1]-hy/2);c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';c.drawImage(DC,0,0);c.restore();
 /* «чёлка» с камерой; зелёный огонёк — когда слушает */
 poly(c,[LP(-6,LL-.7),LP(6,LL-.7),LP(5.2,DV1-2.4),LP(-5.2,DV1-2.4)],1.1);c.fillStyle='#050506';c.fill();
 const cam=LP(0,LL-2.05);dot(cam[0],cam[1],.6,'#1a2232',c);dot(cam[0]-.17,cam[1]-.17,.2,'rgba(150,180,255,.65)',c);
 if(o.cur==='listening'){const p=LP(2.3,LL-2.05);c.shadowColor='#30d158';c.shadowBlur=3*K;dot(p[0],p[1],.42,'#30d158',c);c.shadowBlur=0}
 /* блик на стекле — смещается, когда компьютер наклоняется */
 c.save();poly(c,gq,2.6);c.clip();const sh=RM.matches?0:ST.pose.rot[0]*70+(o.look?o.look.x:0)*1.2,r0=LP(-LW/2+sh-6,LL),r1=LP(-LW/2+sh+44,0);
 const gr=c.createLinearGradient(r0[0],r0[1],r1[0],r1[1]);gr.addColorStop(0,'rgba(255,255,255,.11)');gr.addColorStop(.4,'rgba(255,255,255,.04)');gr.addColorStop(.41,'rgba(255,255,255,0)');gr.addColorStop(1,'rgba(255,255,255,0)');c.fillStyle=gr;c.fillRect(-60,-130,120,130);c.restore();
 /* кромка крышки */
 poly(c,q,3.2);c.strokeStyle=P.rimHi;c.lineWidth=.35;c.globalAlpha=.7;c.stroke();c.globalAlpha=1;
 note(c,o);garland(c,o)}
function lidBack(c,P){const q=[LP(-LW/2,LL),LP(LW/2,LL),LP(LW/2,0),LP(-LW/2,0)];poly(c,q,3.2);const gr=c.createLinearGradient(0,q[2][1],0,q[0][1]);gr.addColorStop(0,P.back1);gr.addColorStop(1,P.back0);c.fillStyle=gr;c.fill();
 c.strokeStyle=P.rim;c.lineWidth=.4;c.stroke();const m=LP(0,LL/2),u=LP(1,LL/2),v=LP(0,LL/2+1);c.save();c.transform(u[0]-m[0],u[1]-m[1],v[0]-m[0],v[1]-m[1],m[0],m[1]);heartPath(c,0,0,11);c.fillStyle=P.logo;c.fill();c.restore()}
/* стикер-заметка на углу крышки: качается от движений (физика — в основном скрипте) */
function note(c,o){const m=LP(LW/2-2.6,LL-.6),u=LP(LW/2-1.6,LL-.6),v=LP(LW/2-2.6,LL-1.6);c.save();c.transform(u[0]-m[0],u[1]-m[1],m[0]-v[0],m[1]-v[1],m[0],m[1]);c.rotate(-((o.note||0)+.14));
 c.shadowColor='rgba(0,0,0,.25)';c.shadowBlur=1.2*K;c.shadowOffsetY=.4*K;c.fillStyle='#ffd95e';c.fillRect(-2.4,0,7.2,7.2);c.shadowColor='transparent';c.shadowOffsetY=0;c.fillStyle='#f2c33d';c.fillRect(-2.4,0,7.2,1.3);
 c.fillStyle='rgba(120,90,20,.35)';c.fillRect(-1.4,2.8,5,.5);c.fillRect(-1.4,4.2,3.8,.5);c.restore()}
/* в праздники — гирлянда по верху крышки */
function garland(c,o){const d=new Date(),m=d.getMonth(),day=d.getDate();if(!((m===11&&day>=15)||(m===0&&day<=15)))return;
 for(let i=0;i<9;i++){const p=LP(-LW/2+6+i*(LW-12)/8,LL+.2),on=RM.matches||Math.sin(o.T*3+i*1.7)>-.3,col=['#ff453a','#30d158','#ffd60a'][i%3];c.shadowColor=col;c.shadowBlur=on?3*K:0;dot(p[0],p[1]+Math.sin(i*1.3)*.4,.75,on?col:rgba(col,.35),c)}c.shadowBlur=0}
/* тень на столе: в прыжке меньше и бледнее */
function shadow(c,P){const bx=ST.pose.bx[0],by=ST.pose.by[0],k=clamp(1+by/26,.45,1),x=CX+bx;
 c.save();c.translate(x,DESK-7.5);c.scale(1,.2);let gr=c.createRadialGradient(0,0,0,0,0,62*k);gr.addColorStop(0,rgba(P.sh,.26*k));gr.addColorStop(1,rgba(P.sh,0));c.fillStyle=gr;c.beginPath();c.arc(0,0,62*k,0,TAU);c.fill();c.restore();
 c.save();c.translate(x,DESK+.3);c.scale(1,.05);gr=c.createRadialGradient(0,0,0,0,0,52*k);gr.addColorStop(0,rgba(P.sh,.4*k));gr.addColorStop(1,rgba(P.sh,0));c.fillStyle=gr;c.beginPath();c.arc(0,0,52*k,0,TAU);c.fill();c.restore()}

/* ================= ЧАСТИЦЫ И ОБЛАЧКА (координаты сцены — те же, что у пиксельного компьютера) ================= */
function stx(c,s,x,y,sz,col,wt,al){F(c,sz,wt||700);c.textAlign=al||'center';c.textBaseline='middle';c.fillStyle=col;c.fillText(s,x,y)}
function particle(c,p,o,P){const k=p.life/p.max;c.globalAlpha=Math.min(1,k*2.5);
 switch(p.type){
 case'heart':{heartPath(c,p.x+2.5,p.y+2.5,7);const gr=c.createLinearGradient(0,p.y-.5,0,p.y+5.5);gr.addColorStop(0,'#ff86ab');gr.addColorStop(1,'#ff2d6f');c.fillStyle=gr;c.fill();break}
 case'star':{const s=Math.sin((1-k)*Math.PI);sparkle(c,p.x,p.y,1+s*2.8,.45);c.fillStyle='#ffcf3a';c.fill();break}
 case'q':stx(c,'?',p.x+2,p.y+3,8.5,P.ink,800);break;
 case'bang':stx(c,'!',p.x+2,p.y+4-(1-k)*6,12,'#ffa31a',800);break;
 case'word':stx(c,p.w,p.x,p.y+2,5.4,P.ink,750,'left');break;
 case'glyph':stx(c,p.ch,p.x,p.y,5.2,k>.6?CO.accInk:rgba(CO.accInk,.7),600);break;
 case'ring':{c.strokeStyle=P.ink;c.lineWidth=.7;c.lineCap='round';const r=3+(1-k)*9;c.beginPath();c.arc(CX+40,p.y,r,-.8,.8);c.stroke();break}
 case'spark':dot(p.x,p.y,.7,p.dim?p.col:(k>.5?'#fff3b0':'#ffb238'),c);break;
 case'rocket':dot(p.x,p.y,.8,'#ffffff',c);break;
 case'smoke':c.globalAlpha=k*.55;dot(p.x,p.y,1.2+(1-k)*5.5,P.smoke,c);break;
 case'steam':{c.globalAlpha=k*.5;const w=Math.sin(o.T*5+p.seed*9)*1.5;c.strokeStyle='#cfd2d8';c.lineWidth=.8;c.lineCap='round';c.beginPath();c.moveTo(p.x-w,p.y+2);c.quadraticCurveTo(p.x+w*2,p.y,p.x+w,p.y-2);c.stroke();break}
 case'confetti':{c.save();c.translate(p.x,p.y);c.rotate(o.T*5+p.seed*10);c.scale(1,Math.abs(Math.sin(o.T*8+p.seed*20))+.15);c.fillStyle=p.col;c.fillRect(-1.3,-.7,2.6,1.4);c.restore();break}
 case'note':{c.fillStyle=c.strokeStyle=p.col;c.lineWidth=.7;c.lineCap='round';c.beginPath();c.ellipse(p.x+1.5,p.y+4.2,1.5,1.05,-.45,0,TAU);c.fill();c.beginPath();c.moveTo(p.x+2.8,p.y+4);c.lineTo(p.x+2.8,p.y);c.quadraticCurveTo(p.x+4.8,p.y+.6,p.x+4.6,p.y+2.4);c.stroke();break}
 case'drop':{dropPath(c,p.x+1.5,p.y+2,2.4);c.fillStyle='#7cc8ff';c.fill();break}
 case'rain':{c.strokeStyle='rgba(120,170,255,.8)';c.lineWidth=.5;c.beginPath();c.moveTo(p.x,p.y);c.lineTo(p.x-.3,p.y+2.2);c.stroke();break}
 case'z':stx(c,'z',p.x+1.5,p.y+2,p.small?4.5:5.5+(1-k)*4,'#8ea0ff',800);break;
 case'plane':{c.save();c.translate(p.x,p.y);c.rotate(Math.atan2(p.vy,p.vx)*.6);c.beginPath();c.moveTo(-3.5,-2.2);c.lineTo(4,0);c.lineTo(-3.5,2.2);c.lineTo(-1.8,0);c.closePath();c.fillStyle='#ffffff';c.fill();c.strokeStyle=P.ink;c.lineWidth=.3;c.lineJoin='round';c.stroke();c.restore();break}
 }c.globalAlpha=1}
function thought(c,t,P,bx,by){const s=ease(clamp(t/.4,0,1));if(s<=0)return;const b=RM.matches?0:Math.sin(ST.T*2)*.8;
 [[CX+bx-38,DESK+by-80+b,1.7*s],[CX+bx-45,DESK+by-87-b,2.9*s]].forEach(([x,y,r])=>{c.shadowColor='rgba(0,0,0,.18)';c.shadowBlur=1.5*K;dot(x,y,r,P.bub,c);c.shadowBlur=0;c.strokeStyle=P.bubE;c.lineWidth=.3;c.stroke()})}
function rainCloud(c,bx,by){const x=CX+bx+2,y=DESK+by-83+(RM.matches?0:Math.sin(ST.T*1.5));const gr=c.createLinearGradient(0,y-7,0,y+5);gr.addColorStop(0,'#9aa1b0');gr.addColorStop(1,'#646b7a');c.fillStyle=gr;c.beginPath();
 [[-6,1,4],[0,-1.5,5.2],[6,1,4],[-2.5,3,3.6],[3,3,3.6]].forEach(([a,b,r])=>{c.moveTo(x+a+r,y+b);c.arc(x+a,y+b,r,0,TAU)});c.fill()}

/* ================= КАДР ================= */
function render(c,o,k,ox,oy,P){K=k;c.setTransform(k,0,0,k,ox-BOX[0]*k,oy-BOX[1]*k);c.imageSmoothingEnabled=true;
 shadow(c,P);
 const pz=ST.pose,sm=RM.matches?0:o.shake||0,shx=sm*(Math.sin(o.T*91)+Math.sin(o.T*57))*.5,shy=sm*(Math.sin(o.T*77)+Math.sin(o.T*43))*.5;
 c.save();c.translate(CX+pz.bx[0]+shx,DESK+pz.by[0]+shy);c.rotate(pz.rot[0]);c.scale(pz.sx[0],pz.sy[0]);laptop(c,o,P,ST.lid[0]);c.restore();
 const d=o.d;if(d.thought!==undefined)thought(c,d.thought,P,pz.bx[0],pz.by[0]);if(d.rainCloud)rainCloud(c,pz.bx[0],pz.by[0]);
 (o.PS||[]).forEach(p=>particle(c,p,o,P));c.globalAlpha=1}
function draw(ctx,o){const t0=performance.now();try{update(o);ST.last=o;colors(o);const P=pal=PAL[isDark()?'dark':'light'],cv=ctx.canvas,k=cv.width/BOX[2];
 /* чёткость экрана — по самому крупному из показов (верхняя панель или экран загрузки) */
 texScale(clamp(Math.round(Math.max(k,o.T-ST.mirT<1?ST.mirK:0)*(LW-6.4)*1.4/160*8)/8,.75,2.5));display(o);
 ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,cv.width,cv.height);render(ctx,o,k,0,0,P)}
 catch(e){if(!draw.err){draw.err=1;console.error('Personal Computer (современная тема):',e)}}ST.cost=ST.cost*.9+(performance.now()-t0)*.1}
/* экран загрузки и окно обновления: тот же ноутбук, в размер их холста (по пикселям экрана) */
function mirror(g2){const o=ST.last;if(!o)return;const c=g2.canvas,r=c.getBoundingClientRect(),dpr=window.devicePixelRatio||1,W=Math.round(r.width*dpr),H=Math.round(r.height*dpr);
 if(W>0&&H>0&&(c.width!==W||c.height!==H)){c.width=W;c.height=H;g2.__f=''}
 const k=Math.min(c.width/BOX[2],c.height/BOX[3]);ST.mirK=k;ST.mirT=ST.T;g2.setTransform(1,0,0,1,0,0);g2.clearRect(0,0,c.width,c.height);
 try{render(g2,o,k,(c.width-BOX[2]*k)/2,c.height-BOX[3]*k,pal)}catch(e){}}
/* куда попали: наклейка-радуга (двойной клик — титры), клавиатура (печатать), остальное — погладить */
function hit(x,y,d){const lx=x-(CX+(d?d.bx:0)),ly=y-(DESK+(d?d.by:0));
 if(lx>=27&&lx<=44&&ly>=-9.5&&ly<=-2.5)return'badge';
 if(Math.abs(lx)<=43&&ly>=-18&&ly<=-9)return'keyboard';
 return'pc'}
window.PCModern={box:BOX,draw,hit,mirror,dbg:()=>({lid:Math.round(ST.lid[0]),tex:TQ,cost:Math.round(ST.cost*100)/100,key:ST.key})};
})();
