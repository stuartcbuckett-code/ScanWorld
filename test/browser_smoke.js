const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }); const pg = await ctx.newPage(); const errs=[];
  pg.on('pageerror', e => errs.push('PAGEERR ' + e.message)); pg.on('console', m => { if (m.type()==='error') errs.push('error '+m.text()); });
  await pg.addInitScript('try{localStorage.setItem("sb-lod", JSON.stringify({on:false}))}catch(e){}');
  await pg.goto((process.env.URL || 'http://localhost:8080/') ); 
  await pg.waitForFunction(()=>window.__sb && window.__sb.S.layers.length && document.querySelector('#prog').hidden,null,{timeout:180000});
  console.log('platform', await pg.evaluate(()=>__sb.S.layers.map(L=>[L.name,L.n])), 'title', await pg.title());
  await pg.click('.tab[data-tab="review"]'); await pg.click('#pane-review button:has-text("Mundaring Weir")');
  await pg.waitForFunction(()=>__sb.S.layers.some(L=>/Weir/.test(L.name)) && document.querySelector('#prog').hidden,null,{timeout:300000});
  console.log('weir', await pg.evaluate(()=>__sb.S.layers.map(L=>[L.name,L.n])));
  await pg.evaluate(()=>__sb.addAnnotation(__sb.S.cam.target.clone(),'test'));
  const dl = pg.waitForEvent('download',{timeout:60000}); await pg.click('#pane-review button:has-text("Save project")'); const d = await dl; console.log('download', d.suggestedFilename());
  await pg.waitForTimeout(1500); await pg.screenshot({ path: 'smoke.png' });
  console.log(errs.join('\n') || 'no page errors'); await b.close();
})();
