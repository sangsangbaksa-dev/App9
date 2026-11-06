// Exercises the built Pages bundle with its production CSP. No real API or account calls.
const engines=require('playwright');
const engineName=process.env.BROWSER_ENGINE||'chromium';
if(!['chromium','firefox','webkit'].includes(engineName))throw new Error('Unsupported BROWSER_ENGINE');
const engine=engines[engineName];
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'), dist=path.join(root,'dist');
const APP="App9";
const out=path.join(root,'artifacts/browser',engineName);fs.mkdirSync(out,{recursive:true});
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.json':'application/json','.webmanifest':'application/manifest+json','.xml':'application/xml','.txt':'text/plain'};
const csp=fs.readFileSync(path.join(dist,'_headers'),'utf8').match(/Content-Security-Policy:\s*(.*)/i)?.[1];
let server,browser;
const results=[],failures=[];
async function main(){
 server=http.createServer((req,res)=>{
  let target;
  try{target=decodeURIComponent(req.url.split('?')[0]);}catch{res.writeHead(400);return res.end();}
  if(target==='/api/license'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end('{"configured":false}');}
  let file=path.resolve(dist,'.'+target);
  if(file!==dist&&!file.startsWith(dist+path.sep)){res.writeHead(404);return res.end();}
  if(fs.existsSync(file)&&fs.statSync(file).isDirectory())file=path.join(file,'index.html');
  else if(!fs.existsSync(file)&&fs.existsSync(file+'.html'))file+='.html';
  if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end('Not found');}
  res.writeHead(200,{'content-type':TYPES[path.extname(file)]||'application/octet-stream','content-security-policy':csp});
  res.end(fs.readFileSync(file));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 browser=await engine.launch({...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH}:{}),...(engineName==='chromium'?{args:['--no-sandbox']}:{})});
 const full=process.env.FULL_AUDIT==='1',simple=APP.startsWith('App');
 const langs=simple?['ko']:(full?['en','ko','ja','zh','es']:['en','ko']);
 const widths=full?[360,390,768,1280]:[360,1280];
 const schemes=['light','dark'];
 const zones=full?['Asia/Seoul','America/New_York','Pacific/Auckland']:['Asia/Seoul'];
 const routes=simple?['/']:['/',APP==='quickbill'?'/app':'/app/'];
 const axe=fs.readFileSync(require.resolve('axe-core/axe.min.js'),'utf8');
 for(const lang of langs)for(const width of widths)for(const colorScheme of schemes)for(const timezoneId of zones){
  const label=`${lang}-${width}-${colorScheme}-${timezoneId.replaceAll('/','-')}`;
  const ctx=await browser.newContext({viewport:{width,height:850},locale:lang,timezoneId,colorScheme,serviceWorkers:'block',acceptDownloads:true});
  // Paid apps use a local fixture, not a real buyer key; licence verification is covered separately by unit tests.
  await ctx.addInitScript(({app,lang})=>{
   if(app==='lendnest')localStorage.setItem('lendnest.licence',JSON.stringify({key:'LOCAL-TEST-0000',checked:Date.now()}));
   if(app==='stayline')localStorage.setItem('stayline.v1',JSON.stringify({v:1,trackers:[],active:'',pro:true,lang}));
  },{app:APP,lang});
  const pg=await ctx.newPage(),errors=[];
  pg.setDefaultTimeout(10000);
  pg.on('pageerror',e=>errors.push(e.message));
  pg.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await pg.route('**/*',route=>{
   const u=new URL(route.request().url());
   if(u.origin!==base&&['http:','https:'].includes(u.protocol))return route.abort();
   return route.continue();
  });
  for(const route of routes){
   const routeName=route==='/'?'landing':'app';
   try{
    const landing=route==='/'&&!simple;
    const local=landing&&lang!=='en'&&fs.existsSync(path.join(dist,lang,'index.html'))?'/'+lang+'/':route;
    const response=await pg.goto(base+local);assert.equal(response.status(),200);
    await pg.evaluate(()=>document.fonts.ready);
    await pg.waitForTimeout(150);
    await pg.evaluate(axe);
    const audit=await pg.evaluate(async()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,violations:(await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa']}})).violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}))}));
    assert.ok(audit.scroll<=audit.width,`Horizontal overflow ${audit.scroll}/${audit.width}`);
    assert.deepEqual(audit.violations,[],'Accessibility violations');
    assert.deepEqual(errors,[],'Browser errors');
    results.push({label,route:local,ok:true});
    if(engineName!=='webkit'&&(!full||width===360&&timezoneId==='Asia/Seoul'))await pg.screenshot({caret:'initial',path:path.join(out,`${label}-${routeName}.png`),fullPage:true});
   }catch(e){const f={label,route,message:e.message,errors:[...errors]};failures.push(f);results.push({...f,ok:false});if(engineName!=='webkit')await pg.screenshot({caret:'initial',path:path.join(out,`${label}-${routeName}-failed.png`),fullPage:true}).catch(()=>{});}
  }
  await ctx.close();
  console.log(APP,label,failures.length?'failures='+failures.length:'OK');
 }
 const flowPath=path.join(__dirname,'browser-flows.cjs');
 if(fs.existsSync(flowPath)){
  const ctx=await browser.newContext({viewport:{width:390,height:850},locale:APP.startsWith('App')?'ko':'en',timezoneId:'Asia/Seoul',serviceWorkers:'block',permissions:engineName==='chromium'?['clipboard-read','clipboard-write']:[],acceptDownloads:true});
  const page=await ctx.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{await require(flowPath)(page,base);assert.deepEqual(errors,[]);results.push({label:'functional',ok:true});}
  catch(e){failures.push({label:'functional',message:e.message});if(engineName!=='webkit')await page.screenshot({caret:'initial',path:path.join(out,'functional-failed.png'),fullPage:true});}
  await ctx.close();
 }
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({app:APP,engine:engineName,version:browser.version(),realDevice:false,screenshots:engineName!=='webkit',results,failures},null,2));
 assert.equal(failures.length,0,JSON.stringify(failures.slice(0,10),null,2));
 console.log(`${APP}: ${results.length} page checks passed`);
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));});
