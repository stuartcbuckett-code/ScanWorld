const T=require('../src/topo.js');
let seed=5;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;const g=()=>{let u=0;while(!u)u=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*rnd())};
const pts=[];const push=(x,y,z)=>pts.push(x+g()*0.005,y+g()*0.005,z+g()*0.005);
// terrain 80x60: general slope 2% in x; a bank: at y in [30,32] rises 1.5 m (y>32 higher); a kerb at x=20 (road x<20 is 0.15 lower)
const surf=(x,y)=>{let z=10+0.02*x; if(y>32) z+=1.5; else if(y>30) z+=1.5*(y-30)/2; if(x<20) z-=0.15; return z};
for(let k=0;k<80*60*60;k++){const x=rnd()*80,y=rnd()*60;push(x,y,surf(x,y))}
// building 10x8x5 at (50..60, 8..16): walls + roof, remove ground inside
for(let k=0;k<20000;k++){const t=rnd(),z=rnd()*5,side=Math.floor(rnd()*4);let x,y;if(side==0){x=50+t*10;y=8}else if(side==1){x=50+t*10;y=16}else if(side==2){x=50;y=8+t*8}else{x=60;y=8+t*8}push(x,y,surf(x,y)+z)}
for(let k=0;k<12000;k++){const x=50+rnd()*10,y=8+rnd()*8;push(x,y,surf(55,12)+5)}
// trees: 4 trees with spherical canopies
const trees=[[10,45,8,3],[25,50,10,4],[65,40,7,2.5],[70,52,9,3.5]];
for(const [tx,ty,h,r] of trees){for(let k=0;k<4000;k++){const a=rnd()*2*Math.PI,b=Math.acos(2*rnd()-1),rr=r*Math.cbrt(rnd());push(tx+rr*Math.sin(b)*Math.cos(a),ty+rr*Math.sin(b)*Math.sin(a),surf(tx,ty)+h-r+rr*Math.cos(b))}for(let k=0;k<300;k++){const a=rnd()*2*Math.PI;push(tx+0.15*Math.cos(a),ty+0.15*Math.sin(a),surf(tx,ty)+rnd()*(h-r))}}
// poles at (30,10) and (40,20): 0.2 dia, 6 m
for(const [px,py] of [[30,10],[40,20]])for(let k=0;k<800;k++){const a=rnd()*2*Math.PI;push(px+0.1*Math.cos(a),py+0.1*Math.sin(a),surf(px,py)+rnd()*6)}
// fence along y=5 from x=25..45, 1.8 high, thin
for(let k=0;k<6000;k++){const x=25+rnd()*20;push(x,5+rnd()*0.05,surf(x,5)+rnd()*1.8)}
const pos=Float32Array.from(pts),n=pts.length/3;
if(process.env.WRITE){const off=process.env.OFF?process.env.OFF.split(',').map(Number):[0,0,0];let o='';for(let i=0;i<n;i++)o+=(pos[i*3]+off[0]).toFixed(4)+' '+(pos[i*3+1]+off[1]).toFixed(4)+' '+(pos[i*3+2]+off[2]).toFixed(4)+'\n';require('fs').writeFileSync(process.env.WRITE,o);process.exit(0)}console.log('points',n);
(async()=>{const t0=Date.now();const r=await T.topoSurvey(pos,n,{spacing:0.1,tinCell:0.5,gradeChange:0.2});
console.log('ms',Date.now()-t0,'analysis',r.m,'counts',r.counts);
console.log('breaklines',r.breaklines.length,r.breaklines.map(b=>b.kind+' n'+b.pts.length+' from '+b.pts[0].map(v=>v.toFixed(1))+' to '+b.pts[b.pts.length-1].map(v=>v.toFixed(1))).slice(0,12));
console.log('tin pts',r.tin.pts.length,'tris',r.tin.tris.length/3);
const cs=T.tinContours(r.tin,0.5,0);console.log('contours',cs.length,'levels',[...new Set(cs.map(c=>c.level))].length);
console.log('trees',r.trees.map(t=>[t.x.toFixed(1),t.y.toFixed(1),'h',t.height.toFixed(1),'s',t.spread.toFixed(1)]));
console.log('buildings',r.buildings.map(b=>[b.area.toFixed(0),'h',b.height.toFixed(1),b.loop.length+' verts',JSON.stringify(b.loop.map(p=>p.map(v=>+v.toFixed(1))))]));
console.log('poles',r.poles.map(p=>[p.x.toFixed(2),p.y.toFixed(2),'h',p.height.toFixed(1)]));
console.log('walls',r.walls.map(w=>[w.a.map(v=>v.toFixed(1)),w.b.map(v=>v.toFixed(1)),'h',w.height.toFixed(1)]));
console.log('spots',r.spots.length,'extent verts',r.extent&&r.extent.length);
// check ground accuracy: TIN z vs true surface at random points
let se=0,c=0,mx=0;for(let k=0;k<2000;k++){const x=5+rnd()*70,y=5+rnd()*50;if(x>49&&x<61&&y>7&&y<17)continue;if(Math.abs(y-31)<1.5||Math.abs(x-20)<0.6)continue;const z=T.tinZ(r.tin,x,y,r.idxGrid);if(!isFinite(z))continue;const e=z-surf(x,y);se+=e*e;c++;mx=Math.max(mx,Math.abs(e))}console.log('TIN rms vs truth',Math.sqrt(se/c).toFixed(4),'max',mx.toFixed(3),'n',c);
console.log(T.landXML(r.tin,r.breaklines,[0,0,0],'test').length);
})().catch(e=>{console.error(e);process.exit(1)});
