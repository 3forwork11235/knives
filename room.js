// Комната игры «Ножи»: места, боты, раунды и вся симуляция боя.
// Работает в браузере создателя игры (или на одном устройстве в игре с ботами).
// Остальные игроки подключаются к нему через WebRTC (P2P) или через пересылку server.py,
// а сам создатель — через «петлю» в памяти. Игроки присылают только направление движения
// и рывок; всё остальное (ножи, столкновения, зона, боты) считает комната и 15 раз в секунду
// рассылает снимок. Поэтому у всех одинаковая картина, а вернувшийся после обрыва получает её целиком.
(function(root){
'use strict';
const TICK=1/30;           // шаг симуляции, с
const SNAP_EVERY=2;        // снимок игрокам — каждые 2 шага (15 раз в секунду)
const RECONNECT_GRACE=180; // сколько секунд держим место ушедшего игрока
const BOT_DELAY=5;         // через сколько секунд за отошедшего начинает играть бот
const ID_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O и 1/I

// ---------- правила боя (их же использует страница для предсказания своего движения) ----------
const BODY_R=22;     // радиус бойца
const KNIFE_HIT=9;   // «радиус» ножа для попадания по телу
const CLASH_D=15;    // ножи ближе этого — сталкиваются
const MAX_K=80;      // больше ножей не унести
const START_K=3;     // ножей в начале раунда
const SPIN=3.4;      // скорость вращения ножей, рад/с
const DASH_T=0.28,DASH_CD=3,DASH_MUL=2.3; // рывок: длительность, перезарядка, ускорение
const SPEED_MUL=1.35;// бонус скорости
const COUNTDOWN=3;   // отсчёт перед раундом
const END_PAUSE=8;   // пауза между раундами
const PICK_R=16,MAGNET_R=170;
const POWERS=['S','H','M','R','B']; // скорость, щит, магнит, ярость (быстрое вращение), связка ножей
const POWER_T={S:8,H:20,M:10,R:8};
function orbitR(k){return Math.max(40,18+k*13/(2*Math.PI))}
// маленькие заметно быстрее больших — у них есть шанс убежать и обойти (0 ножей ≈ 290, 10 ≈ 230, 40 ≈ 180)
function speedOf(k){return 172+118*Math.exp(-k/14)}
function arenaR(n){return Math.round(950+125*n)}
const KNIFE_DENSITY=1.6e-5; // сколько ножей на земле на единицу площади

const COLORS=12;
const HATS=['none','cap','bandana','crown','viking','wizard','pirate'];
const KNIVES=['steel','gold','fire','ice','rainbow','dark'];
function cleanSkin(k){
  k=k||{};
  const c=Math.trunc(Number(k.color));
  return {color:c>=0&&c<COLORS?c:0,hat:HATS.includes(k.hat)?k.hat:'none',knife:KNIVES.includes(k.knife)?k.knife:'steel'};
}
function botSkin(){return {color:Math.floor(Math.random()*COLORS),hat:Math.random()<0.45?HATS[1+Math.floor(Math.random()*(HATS.length-1))]:'none',knife:Math.random()<0.7?'steel':KNIVES[Math.floor(Math.random()*KNIVES.length)]}}
const BOT_NAMES=['Шустрик','Кузя','Тесак','Вжух','Колючка','Ёжик','Бритва','Сталь','Вихрь','Гроза','Клинок','Лис','Барс','Сокол',
  'Пират','Шмель','Тихоня','Буян','Рыжик','Молния','Ниндзя','Дракон','Карась','Филин','Комар','Самурай','Пупсик','Ураган','Зубило','Ворчун'];

// сложность ботов
const DIFF={
  easy:  {react:0.34,vision:560,err:0.7, dash:0.12,aggro:0.55,greed:0.8},
  normal:{react:0.2, vision:760,err:0.32,dash:0.45,aggro:0.85,greed:1},
  hard:  {react:0.1, vision:980,err:0.1, dash:0.85,aggro:1.15,greed:1.25},
};
// сужение зоны: ожидание, сужение (с) и до какой доли арены
const ZONE_PLAN=[[32,22,0.7],[24,20,0.48],[20,18,0.3],[16,16,0.16],[12,14,0.07],[8,18,0]];
const ZONE_MUL={fast:0.6,normal:1,slow:1.5};

function randBytes(n){const b=new Uint8Array(n);crypto.getRandomValues(b);return b}
function newToken(){return Array.from(randBytes(16),x=>x.toString(16).padStart(2,'0')).join('')}
function randomGameId(){let s='';for(const x of randBytes(6))s+=ID_CHARS[x%ID_CHARS.length];return s}
function isNum(v){return typeof v==='number'&&Number.isFinite(v)}
function toInt(v){const n=Math.trunc(Number(v));return Number.isFinite(n)?n:0}
function rnd(a,b){return a+Math.random()*(b-a)}
function dist(ax,ay,bx,by){return Math.hypot(ax-bx,ay-by)}

function cleanOpts(o){
  o=o||{};
  const flag=v=>v===undefined?true:!!v;
  const size=toInt(o.size);
  return {
    size:[2,3,4,5,6,8,10,12,16].includes(size)?size:8, // сколько бойцов в раунде
    bots:flag(o.bots),          // свободные места занимают боты
    diff:['easy','normal','hard'].includes(o.diff)?o.diff:'normal',
    zone:['fast','normal','slow'].includes(o.zone)?o.zone:'normal',
    powers:flag(o.powers),      // бонусы на поле
    bushes:flag(o.bushes),      // кусты, в которых можно спрятаться
    wins:[0,3,5].includes(o.wins)?o.wins:0, // матч до стольких побед (0 — бесконечно)
    solo:!!o.solo,              // игра с ботами на одном устройстве
  };
}
function cleanName(n){return String(n==null?'':n).trim().slice(0,14)}
function newSlot(){return {kind:'empty',ws:null,token:null,name:'',online:false,tasks:[],skin:cleanSkin(),input:{a:0,m:0,dash:false}}}
function slotIds(n){const a=[];for(let i=0;i<n;i++)a.push('P'+i);return a}

function leader(g){
  for(const s of Object.keys(g.slots)){const sl=g.slots[s];if(sl.kind==='human'&&sl.online)return s}
  for(const s of Object.keys(g.slots))if(g.slots[s].kind==='human')return s;
  return null;
}
function slotsView(g){
  const v={};
  for(const s in g.slots){const sl=g.slots[s];v[s]={kind:sl.kind,name:sl.name,online:sl.online,skin:sl.skin,away:sl.kind==='bot'&&!!sl.token}}
  return v;
}
function freeSlotForJoin(g){
  const ids=Object.keys(g.slots);
  // свободное место, затем место чистого бота (не «замещающего» отошедшего игрока)
  return ids.find(s=>g.slots[s].kind==='empty')||ids.find(s=>g.slots[s].kind==='bot'&&!g.slots[s].token)||ids.find(s=>g.slots[s].kind==='gone')||null;
}
function allHumans(g){return Object.values(g.slots).every(sl=>sl.kind==='human')}
function gameDead(g){return Object.values(g.slots).every(sl=>sl.token===null)}
function cancelTasks(sl){for(const t of sl.tasks)clearTimeout(t);sl.tasks=[]}
function usedBotNames(g){return new Set(Object.values(g.slots).filter(s=>s.kind==='bot').map(s=>s.name))}
function makeBot(g,sl){
  const used=usedBotNames(g),free=BOT_NAMES.filter(n=>!used.has(n));
  sl.kind='bot';sl.name=free.length?free[Math.floor(Math.random()*free.length)]:'Бот';sl.skin=botSkin();
}

// ---------- раунд ----------
function inBush(r,x,y){for(const b of r.bushes)if(dist(x,y,b[0],b[1])<b[2]-6)return true;return false}
function randInCircle(cx,cy,rad){const a=Math.random()*Math.PI*2,d=Math.sqrt(Math.random())*rad;return [cx+Math.cos(a)*d,cy+Math.sin(a)*d]}

function newRound(g){
  const ids=Object.keys(g.slots).filter(s=>g.slots[s].kind!=='empty'&&g.slots[s].kind!=='gone');
  const n=ids.length,R=arenaR(Math.max(n,4));
  const r={phase:'count',t:0,phaseT:COUNTDOWN,R,bushes:[],pk:new Map(),pkId:1,f:{},order:ids,
    add:[],del:[],ev:[],winner:null,standings:null,spawnT:0,powerT:4,snapN:0,deaths:0,chestT:rnd(35,55),chest:false,firstBlood:false};
  g.round=(g.round||0)+1;
  // кусты — по кругу, не в центре
  if(g.opts.bushes){
    const cnt=Math.round(R*R/170000); // кустов — по площади арены
    for(let i=0;i<cnt*4&&r.bushes.length<cnt;i++){
      const [x,y]=randInCircle(0,0,R-120),rad=rnd(48,82);
      if(Math.hypot(x,y)<160)continue;
      if(r.bushes.some(b=>dist(x,y,b[0],b[1])<b[2]+rad+60))continue;
      r.bushes.push([Math.round(x),Math.round(y),Math.round(rad)]);
    }
  }
  // бойцы — по кругу, лицом к центру
  const off=Math.random()*Math.PI*2;
  ids.forEach((sid,i)=>{
    const a=off+i*Math.PI*2/n,d=R*0.62;
    const x=Math.cos(a)*d,y=Math.sin(a)*d;
    g.slots[sid].input={a:0,m:0,dash:false};
    r.f[sid]={sid,i,x,y,kx:0,ky:0,k:START_K,rot:Math.random()*6.28,face:a+Math.PI,alive:true,
      dashT:0,dashCd:0,shield:false,shieldT:0,speedT:0,magT:0,spinT:0,invT:0,drainT:0,bareT:0,
      kills:0,place:0,maxK:START_K,ai:{t:Math.random()*0.3,a:a+Math.PI,m:0,dash:false,wander:Math.random()*6.28}};
  });
  r.pairCd={};
  // зона: сначала вся арена, первая цель видна сразу
  const mul=ZONE_MUL[g.opts.zone]||1;
  r.zone={cx:0,cy:0,r:R,fx:0,fy:0,fr:R,tx:0,ty:0,tr:R,stage:-1,shrinking:false,st:0,mul};
  nextZone(r);
  // ножи на земле
  const start=Math.round(Math.PI*R*R*KNIFE_DENSITY);
  for(let i=0;i<start;i++){const [x,y]=randInCircle(0,0,R-40);addPickup(r,x,y,'k',false)}
  if(g.opts.powers)for(let i=0;i<Math.ceil(n/3);i++){const [x,y]=randInCircle(0,0,R*0.8);addPickup(r,x,y,POWERS[Math.floor(Math.random()*POWERS.length)],false)}
  r.add=[];
  g.r=r;
}
function nextZone(r){
  const z=r.zone;
  z.stage++;
  if(z.stage>=ZONE_PLAN.length){z.shrinking=false;z.st=1e9;return}
  const [wait,,frac]=ZONE_PLAN[z.stage];
  const tr=r.R*frac,room=Math.max(0,z.r-tr)*0.7;
  const [tx,ty]=randInCircle(z.cx,z.cy,room);
  Object.assign(z,{fx:z.cx,fy:z.cy,fr:z.r,tx,ty,tr,shrinking:false,st:wait*z.mul});
}
function stepZone(r){
  const z=r.zone;
  z.st-=TICK;
  if(z.st>0){
    if(z.shrinking){
      const total=ZONE_PLAN[z.stage][1]*z.mul,p=1-z.st/total;
      z.cx=z.fx+(z.tx-z.fx)*p;z.cy=z.fy+(z.ty-z.fy)*p;z.r=z.fr+(z.tr-z.fr)*p;
    }
    return;
  }
  if(z.stage>=ZONE_PLAN.length)return;
  if(!z.shrinking){z.shrinking=true;z.st=ZONE_PLAN[z.stage][1]*z.mul;r.ev.push(['z'])}
  else{z.cx=z.tx;z.cy=z.ty;z.r=z.tr;nextZone(r)}
}
function addPickup(r,x,y,t,live){
  const d=Math.hypot(x,y),lim=r.R-20;
  if(d>lim){x*=lim/d;y*=lim/d}
  const p=[r.pkId++,Math.round(x),Math.round(y),t];
  r.pk.set(p[0],p);
  if(live!==false)r.add.push(p);
  return p;
}
function scatter(r,x,y,n,spread){
  for(let i=0;i<n;i++){const a=Math.random()*Math.PI*2,d=rnd(spread*0.3,spread);addPickup(r,x+Math.cos(a)*d,y+Math.sin(a)*d,'k')}
}

// ---------- боты ----------
function botThink(g,f){
  const r=g.r,D=DIFF[g.opts.diff]||DIFF.normal,z=r.zone,ai=f.ai;
  let vx=0,vy=0,dash=false;
  const push=(tx,ty,w)=>{const dx=tx-f.x,dy=ty-f.y,l=Math.hypot(dx,dy)||1;vx+=dx/l*w;vy+=dy/l*w};
  // 1. зона: снаружи — скорее внутрь, скоро сужение — к будущему кругу
  const dz=dist(f.x,f.y,z.cx,z.cy);
  if(dz>z.r-50){push(z.cx,z.cy,3);if(dz>z.r+30&&Math.random()<D.dash)dash=true}
  else if(z.stage<ZONE_PLAN.length&&(z.shrinking||z.st<10)&&dist(f.x,f.y,z.tx,z.ty)>z.tr*0.8)push(z.tx,z.ty,1.3);
  // 2. соперники: сильных — избегаем, слабых — догоняем
  const myR=orbitR(f.k),myPow=f.k+(f.shield?4:0);
  let target=null,best=0,danger=0;
  for(const o of Object.values(r.f)){
    if(o===f||!o.alive)continue;
    const d=dist(f.x,f.y,o.x,o.y);
    if(d>D.vision)continue;
    if(d>150&&inBush(r,o.x,o.y))continue; // спрятался в кустах — не видно
    const oR=orbitR(o.k),oPow=o.k+(o.shield?4:0);
    if(oPow>=myPow+2&&d<oR+myR+220){
      const w=(oR+myR+240-d)/(oR+myR+240)*2.6;
      push(o.x,o.y,-w);danger=Math.max(danger,w);
    }else if(myPow>=oPow+2||(o.k===0&&f.k>=1)){
      const s=(myPow-oPow+3)/(d+60)*D.aggro;
      if(s>best){best=s;target=o}
    }
  }
  if(target){
    // целимся немного вперёд — туда, где соперник будет
    const ti=g.slots[target.sid].kind==='bot'?target.ai:g.slots[target.sid].input;
    const lead=0.35,sp=speedOf(target.k)*(ti.m||0);
    push(target.x+Math.cos(ti.a||0)*sp*lead,target.y+Math.sin(ti.a||0)*sp*lead,1.7);
    const d=dist(f.x,f.y,target.x,target.y);
    if(d<myR+110&&Math.random()<D.dash*0.6)dash=true;
  }
  if(danger>1.4&&Math.random()<D.dash*0.4)dash=true;
  // 3. ножи и бонусы на земле
  if(!target||f.k<10){
    let pb=null,ps=0;
    for(const p of r.pk.values()){
      const d=dist(f.x,f.y,p[1],p[2]);
      if(d>D.vision)continue;
      if(dist(p[1],p[2],z.cx,z.cy)>z.r)continue; // за зоной не лезем
      const s=(p[3]==='k'?1:p[3]==='G'?9:3.5)/(d+40);
      if(s>ps){ps=s;pb=p}
    }
    if(pb)push(pb[1],pb[2],(target?0.7:1.2)*D.greed);
  }
  // 4. стена арены
  if(Math.hypot(f.x,f.y)>r.R-160)push(0,0,1.5);
  // 5. ничего интересного — бродим
  if(Math.hypot(vx,vy)<0.05){
    ai.wander+=rnd(-0.8,0.8);
    vx=Math.cos(ai.wander);vy=Math.sin(ai.wander);
    push(z.cx,z.cy,0.3);
  }
  ai.a=Math.atan2(vy,vx)+rnd(-0.5,0.5)*D.err;
  ai.m=Math.hypot(vx,vy)>0.05?1:0;
  if(dash)ai.dash=true;
}

// ---------- шаг симуляции ----------
function knifePos(f){
  const a=[],R=orbitR(f.k),st=Math.PI*2/Math.max(1,f.k);
  for(let i=0;i<f.k;i++){const an=f.rot+i*st;a.push([f.x+Math.cos(an)*R,f.y+Math.sin(an)*R])}
  return a;
}
function aliveList(r){return Object.values(r.f).filter(f=>f.alive)}

class KnivesHub{
  constructor(o){
    o=o||{};
    this.games={};
    this.log=o.log||(()=>{});
    this.onChange=o.onChange||null;   // состояние игры изменилось (для сохранения)
    this.onClosed=o.onClosed||null;   // игра закрыта
    // таймер симуляции; страница может дать свой (из Web Worker — он не засыпает в фоне)
    this.every=o.every||((fn,ms)=>{const h=setInterval(fn,ms);return()=>clearInterval(h)});
  }

  connect(conn){
    const c={conn,g:null,me:null,emoteAt:0};
    return {
      message:data=>{try{this._message(c,data)}catch(e){this.log('[!] Ошибка: '+(e&&e.stack||e))}},
      closed:()=>{try{this._closed(c)}catch(e){this.log('[!] Ошибка: '+(e&&e.stack||e))}},
    };
  }

  // ---------- отправка ----------
  send(ws,msg){
    if(!ws)return;
    try{ws.send(msg)}catch(e){}
  }
  broadcast(g,msg,exclude){
    for(const sl of Object.values(g.slots))if(sl.ws&&sl.ws!==exclude)this.send(sl.ws,msg);
  }
  sendSlots(g){
    if(g.started)this.broadcast(g,{type:'slots',slots:slotsView(g),leader:leader(g),score:g.score});
    else this.broadcast(g,{type:'lobby',game_id:g.id,slots:slotsView(g),leader:leader(g),opts:g.opts});
  }
  changed(g){if(this.onChange&&this.games[g.id]===g)this.onChange(g)}

  // всё о текущем раунде — для начала раунда и для вернувшихся
  roundState(g){
    const r=g.r;
    return {round:g.round,phase:r.phase,phaseT:r.phaseT,R:r.R,bushes:r.bushes,order:r.order,
      pk:Array.from(r.pk.values()),p:this.players(r),z:this.zoneView(r),t:Math.round(r.t*1000),
      kills:Object.fromEntries(Object.values(r.f).map(f=>[f.i,f.kills])),
      standings:r.standings,winner:r.winner,score:g.score,match_over:g.match_over,opts:g.opts};
  }
  fullState(g,sid){
    return Object.assign({type:'resumed',game_id:g.id,slot:sid,started:g.started,slots:slotsView(g),leader:leader(g)},
      g.started&&g.r?this.roundState(g):{opts:g.opts});
  }
  players(r){
    const out=[];
    for(const f of Object.values(r.f)){
      const flags=(f.alive?1:0)|(f.shield?2:0)|(f.speedT>0?4:0)|(f.magT>0?8:0)|(f.spinT>0?16:0)|(f.dashT>0?32:0)|(f.invT>0?64:0);
      out.push([f.i,Math.round(f.x),Math.round(f.y),f.k,Math.round((f.rot%(Math.PI*2))*1000),flags,Math.round(f.face*100)]);
    }
    return out;
  }
  zoneView(r){
    const z=r.zone,R=v=>Math.round(v);
    return [R(z.cx),R(z.cy),R(z.r),R(z.tx),R(z.ty),R(z.tr),z.stage>=ZONE_PLAN.length?-1:z.stage,Math.max(0,Math.round(z.st*10)),z.shrinking?1:0];
  }

  // ---------- игровой цикл ----------
  startLoop(g){
    this.stopLoop(g);
    let last=Date.now(),acc=0;
    g.stopLoop=this.every(()=>{
      if(this.games[g.id]!==g||!g.r){this.stopLoop(g);return}
      const now=Date.now();
      if(g.paused){last=now;return} // пауза (только в игре с ботами на одном устройстве)
      acc+=Math.min(0.5,(now-last)/1000);last=now; // вкладка спала — не догоняем всё сразу
      let n=0;
      while(acc>=TICK&&n<8){acc-=TICK;n++;try{this.step(g)}catch(e){this.log('[!] Ошибка шага: '+(e&&e.stack||e))}}
    },1000/60);
  }
  stopLoop(g){if(g.stopLoop){const s=g.stopLoop;g.stopLoop=null;s()}}

  step(g){
    const r=g.r;
    r.t+=TICK;
    if(r.phase==='count'){
      r.phaseT-=TICK;
      if(r.phaseT<=0){r.phase='play';r.ev.push(['go'])}
    }else if(r.phase==='play'){
      this.simulate(g);
    }else if(r.phase==='end'){
      r.phaseT-=TICK;
      if(r.phaseT<=0&&!g.match_over){this.beginRound(g);return}
    }
    if(++r.snapN>=SNAP_EVERY){r.snapN=0;this.sendSnap(g)}
  }
  sendSnap(g){
    const r=g.r;
    const msg={type:'snap',t:Math.round(r.t*1000),ph:r.phase,pt:Math.round(r.phaseT*10),p:this.players(r),z:this.zoneView(r)};
    if(r.add.length)msg.add=r.add;
    if(r.del.length)msg.del=r.del;
    if(r.ev.length)msg.ev=r.ev;
    r.add=[];r.del=[];r.ev=[];
    this.broadcast(g,msg);
  }
  beginRound(g){
    newRound(g);
    this.broadcast(g,Object.assign({type:'round'},this.roundState(g)));
    this.changed(g);
  }

  simulate(g){
    const r=g.r,R=r.R,fs=Object.values(r.f),alive=fs.filter(f=>f.alive);
    stepZone(r);
    // управление: люди — то, что прислали; боты думают сами
    for(const f of alive){
      const sl=g.slots[f.sid];
      let inp;
      if(sl.kind==='bot'){
        f.ai.t-=TICK;
        if(f.ai.t<=0){botThink(g,f);const D=DIFF[g.opts.diff]||DIFF.normal;f.ai.t=D.react*rnd(0.7,1.3)}
        inp=f.ai;
      }else if(sl.kind==='human'&&sl.online)inp=sl.input;
      else inp={a:f.face,m:0,dash:false}; // отошёл, а бота нет — стоит
      // таймеры
      f.dashT=Math.max(0,f.dashT-TICK);f.dashCd=Math.max(0,f.dashCd-TICK);
      f.speedT=Math.max(0,f.speedT-TICK);f.magT=Math.max(0,f.magT-TICK);f.spinT=Math.max(0,f.spinT-TICK);
      f.invT=Math.max(0,f.invT-TICK);
      if(f.shield&&(f.shieldT-=TICK)<=0)f.shield=false;
      if(inp.dash){inp.dash=false;if(f.dashCd<=0){f.dashT=DASH_T;f.dashCd=DASH_CD;r.ev.push(['d',f.i])}}
      let m=Math.max(0,Math.min(1,isNum(inp.m)?inp.m:0)),a=isNum(inp.a)?inp.a:f.face;
      if(f.dashT>0&&m<0.3){m=1;a=f.face}
      const sp=speedOf(f.k)*(f.speedT>0?SPEED_MUL:1)*(f.dashT>0?DASH_MUL:1)*m;
      if(m>0.05)f.face=a;
      f.x+=(Math.cos(a)*sp+f.kx)*TICK;f.y+=(Math.sin(a)*sp+f.ky)*TICK;
      f.kx*=0.85;f.ky*=0.85;
      f.rot=(f.rot+SPIN*(f.spinT>0?2:1)*TICK)%(Math.PI*2);
      const d=Math.hypot(f.x,f.y),lim=R-BODY_R;
      if(d>lim){f.x*=lim/d;f.y*=lim/d}
    }
    // тела расталкиваются
    for(let i=0;i<alive.length;i++)for(let j=i+1;j<alive.length;j++){
      const a=alive[i],b=alive[j],dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy);
      if(d>0&&d<BODY_R*2){const p=(BODY_R*2-d)/2,ux=dx/d,uy=dy/d;a.x-=ux*p;a.y-=uy*p;b.x+=ux*p;b.y+=uy*p}
    }
    // ножи: столкновения и попадания
    const kp=new Map();
    for(const f of alive)kp.set(f,knifePos(f));
    for(const k in r.pairCd)if((r.pairCd[k]-=TICK)<=0)delete r.pairCd[k];
    for(let i=0;i<alive.length;i++)for(let j=i+1;j<alive.length;j++){
      const a=alive[i],b=alive[j];
      if(!a.alive||!b.alive)continue;
      const d=dist(a.x,a.y,b.x,b.y);
      if(d>orbitR(a.k)+orbitR(b.k)+KNIFE_HIT*2+BODY_R)continue;
      const key=a.i<b.i?a.i+'-'+b.i:b.i+'-'+a.i;
      // ножи о ножи — оба теряют по ножу, обломки падают на землю
      if(a.k>0&&b.k>0&&!r.pairCd[key]){
        const ka=kp.get(a),kb=kp.get(b);
        let hit=null;
        for(const p of ka){for(const q of kb)if(Math.abs(p[0]-q[0])<CLASH_D&&Math.abs(p[1]-q[1])<CLASH_D&&dist(p[0],p[1],q[0],q[1])<CLASH_D){hit=[p,q];break}if(hit)break}
        if(hit){
          a.k--;b.k--;r.pairCd[key]=0.12;
          const mx=(hit[0][0]+hit[1][0])/2,my=(hit[0][1]+hit[1][1])/2;
          r.ev.push(['c',Math.round(mx),Math.round(my),a.i,b.i]);
          const ux=(b.x-a.x)/(d||1),uy=(b.y-a.y)/(d||1);
          a.kx-=ux*140;a.ky-=uy*140;b.kx+=ux*140;b.ky+=uy*140;
          for(let n=0;n<2;n++)if(Math.random()<0.5)scatter(r,mx,my,1,60);
          kp.set(a,knifePos(a));kp.set(b,knifePos(b));
        }
      }
      // нож по телу
      for(const [att,vic] of [[a,b],[b,a]]){
        if(!att.alive||!vic.alive||vic.invT>0||att.k===0)continue;
        const lim=BODY_R+KNIFE_HIT;
        if(kp.get(att).some(p=>Math.abs(p[0]-vic.x)<lim&&Math.abs(p[1]-vic.y)<lim&&dist(p[0],p[1],vic.x,vic.y)<lim))this.hit(g,att,vic);
      }
    }
    // зона
    const z=r.zone;
    for(const f of alive){
      if(!f.alive)continue;
      if(dist(f.x,f.y,z.cx,z.cy)>z.r){
        f.drainT+=TICK;
        if(f.drainT>=0.5){f.drainT=0;if(f.k>0)f.k--}
        if(f.k===0){f.bareT+=TICK;if(f.bareT>=2.5)this.kill(g,f,null)}
      }else{f.drainT=0;f.bareT=0}
    }
    // подбор
    for(const f of alive){
      if(!f.alive)continue;
      const pr=f.magT>0?MAGNET_R:BODY_R+PICK_R;
      for(const p of r.pk.values()){
        if(Math.abs(p[1]-f.x)>pr||Math.abs(p[2]-f.y)>pr||dist(p[1],p[2],f.x,f.y)>pr)continue;
        if(p[3]==='k'&&f.k>=MAX_K)continue;
        r.pk.delete(p[0]);r.del.push([p[0],f.i]);
        const t=p[3];
        if(t==='k')f.k++;
        else{
          if(t==='B')f.k=Math.min(MAX_K,f.k+5);
          else if(t==='G'){f.k=Math.min(MAX_K,f.k+12);f.spinT=6;f.shield=true;f.shieldT=POWER_T.H} // золотой сундук
          else if(t==='S')f.speedT=POWER_T.S;
          else if(t==='M')f.magT=POWER_T.M;
          else if(t==='R')f.spinT=POWER_T.R;
          else if(t==='H'){f.shield=true;f.shieldT=POWER_T.H}
          r.ev.push(['p',f.i,t]);
        }
        f.maxK=Math.max(f.maxK,f.k);
      }
    }
    // новые ножи и бонусы — внутри зоны
    r.spawnT-=TICK;
    if(r.spawnT<=0){
      r.spawnT=0.5;
      let knives=0;for(const p of r.pk.values())if(p[3]==='k')knives++;
      // ножей на земле — по площади зоны: зона сжимается, ножей меньше
      const n=r.order.length,want=Math.max(n*4,Math.min(n*16,Math.round(Math.PI*z.r*z.r*KNIFE_DENSITY*0.8)));
      for(let i=0;i<3&&knives<want;i++,knives++){const [x,y]=randInCircle(z.cx,z.cy,Math.max(30,z.r*0.95));addPickup(r,x,y,'k')}
    }
    if(g.opts.powers&&(r.powerT-=TICK)<=0){
      r.powerT=rnd(5,9);
      let pw=0;for(const p of r.pk.values())if(p[3]!=='k')pw++;
      if(pw<Math.ceil(r.order.length/3)+1){const [x,y]=randInCircle(z.cx,z.cy,Math.max(30,z.r*0.85));addPickup(r,x,y,POWERS[Math.floor(Math.random()*POWERS.length)])}
    }
    // золотой сундук: один за раунд, появляется в будущем круге зоны — за него стоит побороться
    if(!r.chest&&(r.chestT-=TICK)<=0){
      r.chest=true;
      const [x,y]=randInCircle(z.tx,z.ty,Math.max(40,z.tr*0.5));
      const p=addPickup(r,x,y,'G');
      r.ev.push(['g',p[1],p[2]]);
    }
    this.checkEnd(g);
  }
  hit(g,att,vic){
    const r=g.r;
    const ux=(vic.x-att.x),uy=(vic.y-att.y),l=Math.hypot(ux,uy)||1;
    if(vic.shield){
      vic.shield=false;vic.invT=0.6;
      vic.kx+=ux/l*320;vic.ky+=uy/l*320;
      r.ev.push(['h',vic.i]);
      return;
    }
    this.kill(g,vic,att);
  }
  kill(g,vic,killer){
    const r=g.r;
    if(!vic.alive)return;
    vic.place=aliveList(r).length;
    vic.alive=false;vic.deathT=r.t;r.deaths++;
    const drop=Math.min(vic.k+2,45);
    scatter(r,vic.x,vic.y,drop,orbitR(vic.k)+30);
    vic.lastK=vic.k;vic.k=0;
    if(killer){killer.kills++;const s=g.score[killer.sid];if(s)s.kills++}
    // серия (выбитых за раунд) и «первая кровь» — для объявлений на экране
    const first=!!killer&&!r.firstBlood;if(killer)r.firstBlood=true;
    r.ev.push(['x',killer?killer.i:-1,vic.i,Math.round(vic.x),Math.round(vic.y),killer?killer.kills:0,first?1:0]);
  }
  checkEnd(g){
    const r=g.r;
    const alive=aliveList(r);
    if(alive.length>1)return;
    let win=alive[0]||null;
    if(!win){
      // погибли все сразу — побеждает тот, у кого было больше ножей
      const last=Object.values(r.f).filter(f=>f.deathT===r.t);
      last.sort((a,b)=>(b.lastK||0)-(a.lastK||0));
      win=last[0]||null;
    }
    if(win){win.place=1;r.winner=win.sid;const s=g.score[win.sid];if(s)s.wins++}
    r.phase='end';r.phaseT=END_PAUSE;
    r.standings=Object.values(r.f).sort((a,b)=>(a.place||99)-(b.place||99)).map(f=>({sid:f.sid,i:f.i,place:f.place,kills:f.kills,maxK:f.maxK}));
    if(g.opts.wins&&win&&g.score[win.sid].wins>=g.opts.wins)g.match_over=true;
    this.sendSnap(g);
    this.broadcast(g,{type:'round_end',winner:r.winner,standings:r.standings,score:g.score,match_over:g.match_over,next:END_PAUSE,round:g.round});
    this.changed(g);
  }

  startGame(g){
    const ids=Object.keys(g.slots);
    if(g.opts.bots)for(const s of ids)if(g.slots[s].kind==='empty')makeBot(g,g.slots[s]);
    if(ids.filter(s=>g.slots[s].kind!=='empty').length<2)return false;
    g.started=true;g.match_over=false;g.round=0;
    g.score={};for(const s of ids)g.score[s]={wins:0,kills:0};
    this.sendSlots(g); // имена бойцов — раньше, чем начнётся раунд
    this.beginRound(g);
    this.startLoop(g);
    return true;
  }

  releaseSlot(g,sid){
    // игрок ушёл насовсем: место освобождается (в игре — бот или «ушёл»)
    const sl=g.slots[sid];
    cancelTasks(sl);
    sl.token=null;sl.ws=null;sl.online=false;
    if(!g.started){sl.kind='empty';sl.name=''}
    else if(g.opts.bots)makeBot(g,sl);
    else sl.kind='gone';
  }
  afterLeave(g){
    if(gameDead(g)){this.closeGame(g);return}
    this.sendSlots(g);
  }
  closeGame(g){
    this.stopLoop(g);
    for(const sl of Object.values(g.slots))cancelTasks(sl);
    if(this.games[g.id]!==g)return;
    delete this.games[g.id];
    this.log(`[-] Игра ${g.id} закрыта`);
    if(this.onClosed)this.onClosed(g.id);
  }
  awayTimer(g,sid,token){
    const sl=g.slots[sid];
    const giveUp=()=>{
      if(sl.token===token&&!sl.online){
        this.log(`[-] Игрок ${sid} не вернулся в игру ${g.id}`);
        this.releaseSlot(g,sid);
        this.afterLeave(g);
        this.changed(g);
      }
    };
    if(g.started){
      sl.tasks.push(setTimeout(()=>{
        if(sl.token===token&&!sl.online&&sl.kind==='human'&&g.opts.bots){
          // за отошедшего пока играет бот; вернётся — получит управление обратно
          sl.kind='bot';
          this.sendSlots(g);
          this.changed(g);
        }
        sl.tasks.push(setTimeout(giveUp,(RECONNECT_GRACE-BOT_DELAY)*1000));
      },BOT_DELAY*1000));
    }else sl.tasks.push(setTimeout(giveUp,RECONNECT_GRACE*1000));
  }

  // ---------- сообщения ----------
  _message(c,data){
    if(!data||typeof data!=='object')return;
    const ws=c.conn,action=data.action;
    let g=c.g,me=c.me;

    if(action==='ping'){
      this.send(ws,{type:'pong',n:data.n});
    }else if(action==='create_game'){
      // в P2P код игры выбирает хост (от него зависит адрес для подключения)
      let gid=String(data.game_id||'').toUpperCase();
      if(!/^[A-Z0-9]{6}$/.test(gid)||this.games[gid])gid=randomGameId();
      while(this.games[gid])gid=randomGameId();
      const o=cleanOpts(data.opts);
      g={id:gid,opts:o,slots:{},started:false,score:{},round:0,match_over:false};
      for(const s of slotIds(o.size))g.slots[s]=newSlot();
      me='P0';
      const sl=g.slots[me];
      Object.assign(sl,{kind:'human',ws,token:newToken(),name:cleanName(data.name)||'Игрок 1',online:true,skin:cleanSkin(data.skin)});
      this.games[gid]=g;
      c.g=g;c.me=me;
      this.send(ws,{type:'joined',game_id:gid,slot:me,token:sl.token});
      this.log(`[+] Игра ${gid} создана (${o.size} бойцов)`);
      // игра с ботами на одном устройстве — сразу в бой
      if(o.solo){o.bots=true;this.startGame(g);this.sendSlots(g)}
      else this.sendSlots(g);
    }else if(action==='join_game'){
      const gid=String(data.game_id||'').toUpperCase();
      const gg=this.games[gid];
      const sid=gg&&!gg.opts.solo?freeSlotForJoin(gg):null;
      if(!sid){this.send(ws,{type:'error',message:gg?'В игре нет свободных мест':'Игра не найдена'});return}
      g=gg;me=sid;c.g=g;c.me=me;
      const sl=g.slots[me];
      cancelTasks(sl);
      const n=Object.values(g.slots).filter(s=>s.token).length+1;
      Object.assign(sl,{kind:'human',ws,token:newToken(),name:cleanName(data.name)||`Игрок ${n}`,online:true,skin:cleanSkin(data.skin),input:{a:0,m:0,dash:false}});
      if(g.score&&!g.score[me])g.score[me]={wins:0,kills:0};
      this.send(ws,{type:'joined',game_id:gid,slot:me,token:sl.token});
      this.log(`[+] Игрок вошёл в ${gid} на место ${me}`);
      if(g.started){
        this.send(ws,this.fullState(g,me));
        this.sendSlots(g);
      }else if(allHumans(g)){
        this.startGame(g);
        this.sendSlots(g);
      }else this.sendSlots(g);
    }else if(action==='resume'){
      const gid=String(data.game_id||'').toUpperCase();
      const sid=data.slot;
      const gg=this.games[gid];
      if(!gg||!(sid in gg.slots)||gg.slots[sid].token===null||gg.slots[sid].token!==data.token){
        this.send(ws,{type:'resume_failed'});
        return;
      }
      g=gg;me=sid;c.g=g;c.me=me;
      const sl=g.slots[me];
      const old=sl.ws;
      cancelTasks(sl);
      Object.assign(sl,{ws,online:true,kind:'human',input:{a:0,m:0,dash:false}});
      if(data.skin)sl.skin=cleanSkin(data.skin);
      if(old&&old!==ws){try{old.close()}catch(e){}}
      this.send(ws,this.fullState(g,me));
      this.sendSlots(g);
      this.log(`[~] Игрок ${me} вернулся в игру ${gid}`);
    }else if(!g){
      return;
    }else if(action==='input'){
      // направление (радианы), сила (0..1), рывок
      const sl=g.slots[me];
      if(sl.ws!==ws)return;
      if(isNum(data.a))sl.input.a=data.a;
      sl.input.m=isNum(data.m)?Math.max(0,Math.min(1,data.m)):0;
      if(data.d)sl.input.dash=true;
      return; // часто — без сохранения
    }else if(action==='start_game'){
      if(!g.started&&leader(g)===me){
        if(this.startGame(g))this.sendSlots(g);
        else this.send(ws,{type:'error',message:'Нужно хотя бы два бойца — позовите друга или включите ботов'});
      }
    }else if(action==='restart'){
      // новый матч — после финала или по желанию создателя
      if(g.started&&leader(g)===me&&(g.match_over||(g.r&&g.r.phase==='end'))){
        for(const s in g.score)g.score[s]={wins:0,kills:0};
        g.match_over=false;g.round=0;
        this.beginRound(g);
      }
    }else if(action==='emote'){
      // быстрая фраза над бойцом; не чаще раза в секунду, чтобы не заспамили
      const now=Date.now(),e=toInt(data.e);
      if(g.started&&g.r&&now-c.emoteAt>1000&&e>=0&&e<16){
        c.emoteAt=now;const f=g.r.f[me];
        if(f)this.broadcast(g,{type:'emote',i:f.i,e});
      }
    }else if(action==='leave'){
      if(g.slots[me].ws===ws){
        this.releaseSlot(g,me);
        this.afterLeave(g);
      }
      this.changed(g);
      c.g=null;c.me=null;
      return;
    }
    if(c.g)this.changed(c.g);
  }

  _closed(c){
    const g=c.g,me=c.me;
    if(!g||!me||g.slots[me].ws!==c.conn)return;
    const sl=g.slots[me];
    sl.ws=null;sl.online=false;sl.input={a:0,m:0,dash:false};
    this.awayTimer(g,me,sl.token);
    this.sendSlots(g);
    this.changed(g);
  }

  // ---------- для хоста ----------
  // Хост закрывает игру: всем сообщаем и рвём соединения
  shutdown(gid){
    const g=this.games[gid];
    if(!g)return;
    for(const sl of Object.values(g.slots)){
      if(sl.ws){const ws=sl.ws;sl.ws=null;this.send(ws,{type:'game_closed'});try{ws.close()}catch(e){}}
    }
    this.closeGame(g);
  }
  // Снимок игры без соединений, таймеров и текущего раунда — чтобы пережить перезагрузку вкладки хоста
  snapshot(gid){
    const g=this.games[gid];
    if(!g)return null;
    const slots={};
    for(const s in g.slots){const sl=g.slots[s];slots[s]={kind:sl.kind,token:sl.token,name:sl.name,skin:sl.skin}}
    return JSON.parse(JSON.stringify({id:g.id,opts:g.opts,slots,started:g.started,score:g.score,round:g.round,match_over:g.match_over}));
  }
  restore(snap){
    const g=JSON.parse(JSON.stringify(snap));
    for(const s in g.slots)Object.assign(g.slots[s],{ws:null,online:false,tasks:[],input:{a:0,m:0,dash:false}});
    this.games[g.id]=g;
    // раунд после перезагрузки начинается заново
    if(g.started){g.round=Math.max(0,(g.round||1)-1);newRound(g);this.startLoop(g)}
    // все пока «отошли»: кто не вернётся вовремя — уступит место боту, как при обрыве связи
    for(const s in g.slots){const sl=g.slots[s];if(sl.token)this.awayTimer(g,s,sl.token)}
    return g;
  }
}

KnivesHub.randomGameId=randomGameId;
KnivesHub.rules={TICK,BODY_R,KNIFE_HIT,MAX_K,SPIN,DASH_T,DASH_CD,DASH_MUL,SPEED_MUL,PICK_R,MAGNET_R,POWER_T,COUNTDOWN,END_PAUSE,
  orbitR,speedOf,HATS,KNIVES,COLORS,ZONE_PLAN};
root.KnivesHub=KnivesHub;
if(typeof module!=='undefined'&&module.exports)module.exports=KnivesHub;
})(typeof window!=='undefined'?window:globalThis);
