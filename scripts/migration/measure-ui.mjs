#!/usr/bin/env node
// Compare the frozen Python UI and both Electron modes on isolated copies of one fixture.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir,homedir,release} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
import {chromium,_electron} from 'playwright-core';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),old=resolve(process.env.SLIDE_STUDIO_OLD_REPO||join(repo,'../slide-studio-old'));
if(process.platform!=='darwin')throw Error('This comparison harness currently requires macOS and the preserved Python checkout.');
const output=resolve(process.argv[2]||join(tmpdir(),'slide-studio-ui-performance.json')),runs=Number(process.env.SLIDE_STUDIO_PERF_RUNS||5);
assert.ok(Number.isInteger(runs)&&runs>=1&&runs<=20,'Run count must be between 1 and 20');
const chrome=process.env.SLIDE_STUDIO_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const desktop=process.env.SLIDE_STUDIO_TEST_APP||join(homedir(),'Applications/Slide Studio.app');
const executable=desktop.endsWith('.app')?join(desktop,'Contents/MacOS/Slide Studio'):desktop;
const temporary=await mkdtemp(join(tmpdir(),'studio-performance-')),seed=join(temporary,'seed');
const env={...process.env,SLIDE_STUDIO_CODEX:'none',SLIDE_STUDIO_CLAUDE:'none',SLIDE_STUDIO_AGY:'none',XDG_CONFIG_HOME:join(temporary,'config')};delete env.ELECTRON_RUN_AS_NODE;
const python=join(old,'.venv/bin/python');
const prepared=spawnSync(python,['-m','slide_studio.cli','--root',seed,'import',join(repo,'tests/fixtures/nco-intro'),'--topic','nco'],{cwd:old,env,encoding:'utf8'});assert.equal(prepared.status,0,prepared.stderr);
const sha=x=>createHash('sha256').update(x).digest('hex');
const report={environment:{platform:process.platform,arch:process.arch,os_release:release(),node:process.version,legacy_commit:spawnSync('git',['-C',old,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),electron_asar_sha256:sha(await readFile(resolve(dirname(executable),'../Resources/app.asar')))},scope:'Fresh profiles and workspace copies per mode; same nco-intro fixture, Chrome binary and host Mac; AI disabled. RSS sum is sampled every 200 ms across host and every descendant plus isolated browser descendants. ps CPU is lifetime averaged, not an instantaneous utilization measure. Shared pages may be counted more than once. Not physical/private memory or an OS cold-cache benchmark.',fixture_sha256:sha(await readFile(join(seed,'decks/nco-intro/slides.qmd'))),runs:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=60000){const start=Date.now();for(;;){try{const value=await fn();if(value)return value;}catch{}if(Date.now()-start>timeout)throw Error('Benchmark readiness timeout');await sleep(50);}}
function processes(){return spawnSync('ps',['-axo','pid=,ppid=,rss=,%cpu='],{encoding:'utf8'}).stdout.trim().split('\n').map(line=>{const [pid,ppid,rss,cpu]=line.trim().split(/\s+/).map(Number);return {pid,ppid,rss,cpu};});}
function tree(rows,roots){const ids=new Set(roots.filter(Boolean));let changed=true;while(changed){changed=false;for(const row of rows)if(ids.has(row.ppid)&&!ids.has(row.pid)){ids.add(row.pid);changed=true;}}return rows.filter(r=>ids.has(r.pid));}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function terminate(child){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');for(let i=0;i<50&&child.exitCode===null;i++)await sleep(100);if(child.exitCode===null)child.kill('SIGKILL');}
for(let run=1;run<=runs;run++)for(const mode of ['python-browser','electron-desktop','electron-browser']){
 const root=join(temporary,`${mode}-${run}`),workspace=join(root,'workspace'),profile=join(root,'profile');await mkdir(root);await cp(seed,workspace,{recursive:true});
 const roots=[],seen=new Set();let peakRss=0,peakCpu=0,timer,app,browser,host,chromeProcess;const times={};
 const sample=()=>{const rows=tree(processes(),roots);for(const p of rows)seen.add(p.pid);const rss=rows.reduce((n,p)=>n+p.rss,0),cpu=rows.reduce((n,p)=>n+p.cpu,0);peakRss=Math.max(peakRss,rss);peakCpu=Math.max(peakCpu,cpu);return {rss_kib:rss,cpu_percent:cpu,processes:rows.length};};
 try{
  const start=performance.now();timer=setInterval(sample,200);let page,url;
  if(mode==='python-browser'){
   const port=await freePort();host=spawn(python,['-m','slide_studio.cli','--root',workspace,'--port',String(port),'--no-browser'],{cwd:old,env,stdio:'ignore'});roots.push(host.pid);url=`http://127.0.0.1:${port}/deck/nco-intro`;await until(async()=>{const r=await fetch(url);return r.ok;});
  }else{
   app=await _electron.launch({executablePath:executable,args:['--root',workspace,...(mode==='electron-browser'?['--studio-browser','--port','0','--no-browser']:['--deck','nco-intro'])],env:{...env,SLIDE_STUDIO_ELECTRON_HOME:profile},timeout:60000});roots.push(app.process().pid);
   if(mode==='electron-desktop')page=await app.firstWindow();else{const html=await until(()=>readFile(join(profile,'browser-connection.html'),'utf8'));url=/href="([^"]+)"/.exec(html)[1];const parsed=new URL(url);parsed.pathname='/deck/nco-intro';url=parsed.href;}
  }
  if(!page){const browserProfile=join(root,'chrome');await mkdir(browserProfile);chromeProcess=spawn(chrome,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${browserProfile}`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});roots.push(chromeProcess.pid);const port=(await until(()=>readFile(join(browserProfile,'DevToolsActivePort'),'utf8'))).split('\n')[0];browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);page=browser.contexts()[0].pages()[0];await page.setViewportSize({width:1280,height:860});await page.goto(url);}
  await page.locator('#stage[data-blocks=ready]').waitFor({timeout:60000});times.editable_ms=performance.now()-start;
  await page.waitForFunction(()=>document.querySelector('#status')?.getAttribute('data-tone')==='ok',{},{timeout:60000});await sleep(500);const idleBefore=sample();
  await page.locator('[data-tab=qmd]').click();await page.getByRole('button',{name:'すべての記法を表示',exact:true}).click();const area=page.locator('.raw textarea'),qmd=join(workspace,'decks/nco-intro/slides.qmd'),oldFrame=await page.locator('#slideBox > iframe:not(.loading)').elementHandle();
  await area.evaluate(e=>{e.focus();e.setSelectionRange(e.value.length,e.value.length);});const editStart=performance.now();await page.keyboard.insertText('\n<!-- performance -->\n');await until(async()=>(await readFile(qmd,'utf8')).includes('<!-- performance -->'));const version=sha(await readFile(qmd));await page.waitForFunction(e=>!e.isConnected,oldFrame,{timeout:60000});await page.locator('#stage[data-blocks=ready]').waitFor();times.edit_and_preview_ms=performance.now()-editStart;
  for(const format of ['html','pdf']){const at=performance.now();const result=await page.evaluate(async({format,version})=>{const {api}=await import('/web/api.js');return api('/api/deck/nco-intro/build',{method:'POST',body:{base:version,force:true,format,id:'performance-'+format}});},{format,version});assert.ok(result.files,JSON.stringify(result));times[format+'_ms']=performance.now()-at;}
  await sleep(500);const idleAfter=sample();clearInterval(timer);await browser?.close();await app?.close();await terminate(chromeProcess);await terminate(host);let remaining=[];for(let i=0;i<30;i++){await sleep(100);remaining=processes().filter(p=>seen.has(p.pid));if(!remaining.length)break;}
  const row={mode,run,...times,idle_before:idleBefore,idle_after:idleAfter,peak_rss_kib:peakRss,peak_cpu_percent:peakCpu,residual_processes:remaining.length};report.runs.push(row);await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(row));
 }finally{clearInterval(timer);await browser?.close().catch(()=>{});await app?.close().catch(()=>{});await terminate(chromeProcess);await terminate(host);}
}
const keys=['editable_ms','edit_and_preview_ms','html_ms','pdf_ms','peak_rss_kib'];report.summary={};for(const mode of ['python-browser','electron-desktop','electron-browser']){const rows=report.runs.filter(r=>r.mode===mode);report.summary[mode]=Object.fromEntries(keys.map(key=>{const values=rows.map(r=>r[key]).sort((a,b)=>a-b);return [key,{median:values[Math.floor(values.length/2)],max:values.at(-1)}];}));}
await writeFile(output,JSON.stringify(report,null,2)+'\n');await rm(temporary,{recursive:true,force:true});console.log('Complete: '+output);
