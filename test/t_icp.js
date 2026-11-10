const A=require('../src/algo.js');
let seed=7;const r=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
function scene(n){const p=new Float32Array(n*3);for(let i=0;i<n;i++){const t=i%4;let x,y,z;if(t==0){x=r()*10;y=r()*8;z=0}else if(t==1){x=5;y=r()*8;z=r()*3}else if(t==2){x=r()*10;y=8;z=r()*3}else{x=2+r();y=2+r()*2;z=r()}p.set([x,y,z],i*3)}return p}
(async()=>{const n=300000,ref=scene(n);const mov=scene(n);const ang=0.05;const T0={R:[Math.cos(ang),-Math.sin(ang),0,Math.sin(ang),Math.cos(ang),0,0,0,1],t:[0.1,-0.05,0.03]};A.applyRT(mov,n,T0);
let t=Date.now();const res=await A.icp(mov,n,ref,n,{maxDist:0.5,sample:20000,iterations:50,overlap:0.9});console.log('ms',Date.now()-t,res.rms,res.iterations);
const c=A.composeRT(T0,res.T);console.log(c.R.map(v=>v.toFixed(5)).join(' '),c.t.map(v=>v.toFixed(5)));})();
