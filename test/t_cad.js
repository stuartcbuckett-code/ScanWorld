const C=require('../src/cad.js');
let seed=11;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;const g=()=>{let u=0;while(!u)u=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*rnd())};
const pts=[];const push=(x,y,z)=>pts.push(x+g()*0.0015,y+g()*0.0015,z+g()*0.0015);
const dens=4000; // points per m2
// floor 10x8
for(let k=0;k<10*8*dens*0.5;k++)push(rnd()*10,rnd()*8,0);
// wall x=0
for(let k=0;k<8*4*dens*0.5;k++)push(0,rnd()*8,rnd()*4);
// pipe DN150 OD 168.3 along x at y=3,z=2.2 from x=1..8, arc 270° (missing top quarter)
function pipe(p0,ax,L,r,arc=1.5*Math.PI){const u=Math.abs(ax[2])<0.9?[-ax[1],ax[0],0]:[1,0,0];const ul=Math.hypot(...u);u[0]/=ul;u[1]/=ul;u[2]/=ul;const v=[ax[1]*u[2]-ax[2]*u[1],ax[2]*u[0]-ax[0]*u[2],ax[0]*u[1]-ax[1]*u[0]];
 const N=Math.round(L*2*Math.PI*r*dens*(arc/(2*Math.PI)));for(let k=0;k<N;k++){const t=rnd()*L,a=-Math.PI/2-arc/2+rnd()*arc;const c=Math.cos(a)*r,s=Math.sin(a)*r;push(p0[0]+ax[0]*t+u[0]*c+v[0]*s,p0[1]+ax[1]*t+u[1]*c+v[1]*s,p0[2]+ax[2]*t+u[2]*c+v[2]*s)}}
pipe([1,3,2.2],[1,0,0],7,0.08415);
// flanges at x=3.5 (OD .279, thk .03): rim + faces
function flange(c,ax,od,th,r){const u=[0,1,0],v=[0,0,1];for(let k=0;k<3000;k++){const a=rnd()*2*Math.PI,t=rnd()*th;push(c[0]+t,c[1]+Math.cos(a)*od/2,c[2]+Math.sin(a)*od/2)}for(let k=0;k<3000;k++){const a=rnd()*2*Math.PI,rr=r+rnd()*(od/2-r),f=rnd()<0.5?0:th;push(c[0]+f,c[1]+Math.cos(a)*rr,c[2]+Math.sin(a)*rr)}}
flange([3.5,3,2.2],[1,0,0],0.279,0.03,0.08415); flange([6.0,3,2.2],[1,0,0],0.279,0.03,0.08415);
// vertical pipe DN100 OD 114.3 at (8.5,5) z 0.3..3.5 full arc
pipe([8.5,5,0.3],[0,0,1],3.2,0.05715,2*Math.PI);
// sloped pipe DN50 OD 60.3
const sd=[0.8,0.6,0.0];pipe([2,6,1.5],sd,4,0.03015,2*Math.PI);
// I-beam 310UB40.4 along y at x=5, z centre 3.5, from y=0.5..7.5: d=.304 bf=.165 tf=.0102 tw=.0061 ; sample outer surfaces (no top face)
function ibeam(x0,zc,y0,y1,d,b,tf,tw){const L=y1-y0;const S=(n,f)=>{for(let k=0;k<n;k++)f()};
 const nA=Math.round(L*b*dens);S(nA,()=>push(x0-b/2+rnd()*b,y0+rnd()*L,zc-d/2)); // bottom of bottom flange
 S(nA,()=>push(x0-b/2+rnd()*b,y0+rnd()*L,zc-d/2+tf)); // top of bottom flange (both sides)
 S(nA,()=>push(x0-b/2+rnd()*b,y0+rnd()*L,zc+d/2-tf)); // underside top flange
 const nW=Math.round(L*(d-2*tf)*dens);S(nW,()=>push(x0-tw/2,y0+rnd()*L,zc-d/2+tf+rnd()*(d-2*tf)));S(nW,()=>push(x0+tw/2,y0+rnd()*L,zc-d/2+tf+rnd()*(d-2*tf)));
 const nE=Math.round(L*tf*dens);S(nE*2,()=>{const s=rnd()<0.5?-1:1;push(x0+s*b/2,y0+rnd()*L,zc+(rnd()<0.5?-1:1)*(d/2-rnd()*tf))});}
ibeam(5,3.5,0.5,7.5,0.304,0.165,0.0102,0.0061);
// column 250UC72.9 vertical at (2,1.2) : d=.254 bf=.254 flanges ⟂ x
function column(xc,yc,z0,z1,d,b,tf,tw){const L=z1-z0;const S=(n,f)=>{for(let k=0;k<n;k++)f()};const nA=Math.round(L*b*dens);
 S(nA,()=>push(xc-d/2,yc-b/2+rnd()*b,z0+rnd()*L));S(nA,()=>push(xc+d/2,yc-b/2+rnd()*b,z0+rnd()*L));S(nA,()=>push(xc-d/2+tf,yc-b/2+rnd()*b,z0+rnd()*L));S(nA,()=>push(xc+d/2-tf,yc-b/2+rnd()*b,z0+rnd()*L));
 const nW=Math.round(L*(d-2*tf)*dens);S(nW,()=>push(xc-d/2+tf+rnd()*(d-2*tf),yc-tw/2,z0+rnd()*L));S(nW,()=>push(xc-d/2+tf+rnd()*(d-2*tf),yc+tw/2,z0+rnd()*L));}
column(2,1.2,0,4,0.254,0.254,0.0142,0.0086);
pipe([1,7.2,0.8],[1,0,0],2.8,0.04445,2*Math.PI); pipe([4,7.2,1.0],[0,0,1],2,0.04445,2*Math.PI);
// 200PFC channel along x at y=0.5 z=1.2 : web vertical at y=0.5 facing +y, flanges toward +y (d=.2 b=.075)
(function(){const L=4,x0=5.5,d=0.2,b=0.075,tf=0.012,tw=0.006,y0=0.5,zc=1.2;const S=(n,f)=>{for(let k=0;k<n;k++)f()};
 S(Math.round(L*d*dens),()=>push(x0+rnd()*L,y0,zc-d/2+rnd()*d));S(Math.round(L*d*dens),()=>push(x0+rnd()*L,y0+tw,zc-d/2+tf+rnd()*(d-2*tf)));
 for(const zz of [zc-d/2,zc-d/2+tf,zc+d/2-tf,zc+d/2])S(Math.round(L*b*dens),()=>push(x0+rnd()*L,y0+rnd()*b,zz));})();
const n=pts.length/3,pos=Float32Array.from(pts);
if(process.env.WRITE){const off=process.env.OFF?process.env.OFF.split(',').map(Number):[0,0,0];let o='';for(let i=0;i<n;i++)o+=(pos[i*3]+off[0]).toFixed(4)+' '+(pos[i*3+1]+off[1]).toFixed(4)+' '+(pos[i*3+2]+off[2]).toFixed(4)+'\n';require('fs').writeFileSync(process.env.WRITE,o);process.exit(0)}console.log('points',n);
(async()=>{const t=Date.now();const r=await C.scanToCad(pos,n,{spacing:0.015,minR:0.01,maxR:0.4});console.log('ms',Date.now()-t,'analysis pts',r.n);
 console.log('planes',r.planes.map(p=>p.kind+' '+p.area.toFixed(1)+'m2 loops '+p.loops.length+' verts '+(p.loops[0]||[]).length));
 for(const p of r.pipes)console.log('PIPE',p.label,'L',p.length.toFixed(3),'dir',p.dir,'axis',p.axis.map(v=>v.toFixed(3)).join(','),'p0',p.p0.map(v=>v.toFixed(3)).join(','),'rms',(p.rms*1000).toFixed(1));
 for(const s of r.steel)console.log("STEEL flat",s.flat&&s.flat.toFixed(2),JSON.stringify(s.axis.map(v=>+v.toFixed(4))),JSON.stringify(s.u.map(v=>+v.toFixed(4))),s.label,s.sec.shape,s.sec.key,'W',(s.sec.W*1000).toFixed(0),'H',(s.sec.H*1000).toFixed(0),'L',s.length.toFixed(2),'prec',s.sec.prec.toFixed(2),'p0',s.p0.map(v=>v.toFixed(3)).join(','));
 for(const f of r.flanges)console.log('FLANGE at',f.at.map(v=>v.toFixed(3)).join(','),'OD',(f.od*1000).toFixed(0),'thk',(f.thick*1000).toFixed(0));
 for(const f of r.fittings)console.log('FITTING at',f.at.map(v=>v.toFixed(3)).join(','),'OD',(f.od*1000).toFixed(0),'len',(f.thick*1000).toFixed(0));
 console.log('bends',r.bends.length);
})();
setTimeout(async()=>{},0);
module.exports={};
