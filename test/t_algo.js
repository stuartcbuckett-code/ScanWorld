const A=require('../src/algo.js');
let seed=7;const r=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
function scene(n){const p=new Float32Array(n*3);for(let i=0;i<n;i++){const t=i%3;let x,y,z;if(t==0){x=r()*10;y=r()*8;z=0}else if(t==1){x=5;y=r()*8;z=r()*3}else{x=2+r();y=2+r();z=r()}p.set([x,y,z],i*3)}return p}
(async()=>{
 const n=300000,ref=scene(n);
 // C2C: compare = ref + 0.01 z offset on floor -> distances ~0.01 for floor pts
 const cmp=scene(100000); for(let i=0;i<100000;i++) cmp[i*3+2]+=0.02;
 let t=Date.now(); const d=await A.c2c(cmp,100000,ref,n,{maxDist:0.5}); console.log('c2c ms',Date.now()-t, A.stats(d,100000));
 // brute check 200 pts
 let bad=0;for(let s=0;s<200;s++){const i=s*499;let b=1e9;for(let j=0;j<n;j++){const a=ref[j*3]-cmp[i*3],bb=ref[j*3+1]-cmp[i*3+1],c=ref[j*3+2]-cmp[i*3+2];const q=a*a+bb*bb+c*c;if(q<b)b=q}if(Math.abs(Math.sqrt(b)-d[i])>1e-6)bad++}console.log('c2c brute mismatches',bad);
 // C2M vs design floor/wall
 const tris=Float64Array.from([0,0,0,10,0,0,10,8,0, 0,0,0,10,8,0,0,8,0, 5,0,0,5,8,0,5,8,3, 5,0,0,5,8,3,5,0,3]);
 t=Date.now(); const dm=await A.c2m(cmp,100000,tris,{maxDist:0.3}); console.log('c2m ms',Date.now()-t,A.stats(dm,100000));
 console.log('floor pt signed',dm[0],'wall pt',dm[1],'box pt',dm[2]);
 // plane fit on floor
 const idx=[];for(let i=0;i<n;i+=3)idx.push(i); const pl=A.fitPlane(ref,idx);console.log('plane',pl.normal,pl.rms,pl.dipDeg);
 // ICP: move ref by known transform, recover
 const mov=ref.slice(); const ang=0.05; const T0={R:[Math.cos(ang),-Math.sin(ang),0,Math.sin(ang),Math.cos(ang),0,0,0,1],t:[0.1,-0.05,0.03]}; A.applyRT(mov,n,T0);
 t=Date.now(); const res=await A.icp(mov,n,ref,n,{maxDist:0.5,sample:30000,iterations:60,overlap:0.95}); console.log('icp ms',Date.now()-t,res.rms,res.iterations, res.T.t.map(v=>v.toFixed(5)), res.T.R.map(v=>v.toFixed(5)).join(' '));
 const chk=A.composeRT(T0,res.T); console.log('composed (should be identity):',chk.R.map(v=>v.toFixed(5)).join(' '),chk.t.map(v=>v.toFixed(5)));
 // voxel
 t=Date.now(); const vi=A.voxelSubsample(ref,n,0.1); console.log('voxel',vi.length,Date.now()-t,'ms');
 const keep=await A.radiusOutliers(ref,n,0.1,3); let k=0;for(const v of keep)k+=v;console.log('outlier keep',k,'/',n);
 const R=A.fillHoles(A.rasterize(ref,n,0.25,'max')); const cs=A.contours(R,0.5); console.log('contours',cs.length,cs.slice(0,3).map(c=>[c.level,c.pts.length]));
 console.log('vol',A.volumeVsPlane(R,0));
 const g=A.groundFilter(ref,n,1,0.1); let gs=0;for(let i=0;i<n;i++)gs+=g[i];console.log('ground',gs,'expected ~',n/3+ (n/3)*0.1/3/1);
 const P=[[0,0,0],[1,0,0],[0,1,0],[0,0,1]];const Q=P.map(p=>[p[1]+5,-p[0]+2,p[2]+1]);console.log('horn',A.bestRigid(P,Q));
})();
