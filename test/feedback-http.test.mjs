import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {FEEDBACK_CONSENT} from '../public/feedback-core.mjs';

test('HTTP：试用者可提交、不可读取；后台只在本机；重启可读且无付费调用',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'rehearsal-feedback-http-')),root=fileURLToPath(new URL('../',import.meta.url)),origin='https://feedback-test.example';
  const trial=path.join(dir,'trial');await mkdir(trial);await writeFile(path.join(trial,'origin.txt'),origin);
  await writeFile(path.join(trial,'access.json'),JSON.stringify({passwordHash:createHash('sha256').update('test-password').digest('hex'),secret:randomBytes(32).toString('hex')}));
  const children=[];t.after(async()=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}}await rm(dir,{recursive:true,force:true});});
  async function start(isTrial){
    // This contract test rejects invalid uploads before conversion; use an existing executable
    // for availability probing so the test does not depend on a local LibreOffice install.
    const env={...process.env,SOFFICE_PATH:process.execPath,DEEPSEEK_API_KEY:'',DASHSCOPE_API_KEY:'',REHEARSAL_DATA_DIR:path.join(dir,'local'),REHEARSAL_FEEDBACK_DIR:path.join(dir,'inbox')};
    if(isTrial)env.TRIAL_DIR=trial;else delete env.TRIAL_DIR;
    const child=spawn(process.execPath,['--input-type=module','-e',"import {server} from './server.mjs';server.listen(0,'127.0.0.1',()=>console.log('READY '+server.address().port));"],{cwd:root,env,stdio:['ignore','pipe','pipe']});children.push(child);
    const port=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('test server start timeout')),20000);child.stdout.on('data',b=>{output+=b;const found=output.match(/READY (\d+)/);if(found){clearTimeout(timer);resolve(Number(found[1]));}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('test server stopped'));});});
    return {child,url:`http://127.0.0.1:${port}`};
  }
  const external=await start(true),local=await start(false);
  const request=(service,route,options={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(service.url+route,{method:options.method||'GET',headers:{...(service===external?{Host:new URL(origin).host}:{}),...options.headers}},res=>{
      const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });req.on('error',reject);req.end(options.body);
  });
  assert.equal((await request(external,'/api/feedback',{method:'POST',body:'{}'})).status,401);
  const login=await request(external,'/trial-login',{method:'POST',headers:{Origin:origin,Accept:'application/json'},body:'password=test-password'});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const h=await (await request(external,'/api/health',{headers:{Cookie:cookie}})).json(),headers={Cookie:cookie,Origin:origin,'X-Local-Token':h.csrf,'Content-Type':'application/json'};
  const payload={clientId:'http-test',consent:true,consentVersion:FEEDBACK_CONSENT,nickname:'HTTP 合成测试',comment:'网页试用反馈'};
  assert.equal((await request(external,'/api/feedback',{method:'POST',headers:{...headers,'X-Local-Token':''},body:JSON.stringify(payload)})).status,403);
  assert.equal((await request(external,'/api/feedback',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify(payload)})).status,403);
  assert.equal((await request(external,'/api/feedback',{method:'POST',headers,body:JSON.stringify({...payload,consent:false})})).status,400);
  const sent=await request(external,'/api/feedback',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(sent.status,200);const receipt=await sent.json();
  const repeat=await (await request(external,'/api/feedback',{method:'POST',headers,body:JSON.stringify(payload)})).json();assert.equal(repeat.id,receipt.id);assert.equal(repeat.unchanged,true);
  for(const route of ['/feedback-admin.html','/%66eedback-admin.html','/feedback-admin.mjs','/api/feedback-admin',`/api/feedback-admin/${receipt.id}`])assert.equal((await request(external,route,{headers})).status,404);
  assert.equal((await request(external,'/.local/trial/feedback/'+receipt.id+'.json',{headers})).status,404);
  // Import transport shares login + CSRF but never shares another browser's files.
  const uploadRoute='/api/materials/imports';
  const uploadSpec={size:8,format:'pptx',requestId:'11111111-2222-4333-8444-555555555555'};
  assert.equal((await request(external,uploadRoute,{method:'POST',headers:{Host:new URL(origin).host},body:JSON.stringify(uploadSpec)})).status,401);
  assert.equal((await request(external,uploadRoute,{method:'POST',headers:{...headers,'X-Local-Token':''},body:JSON.stringify(uploadSpec)})).status,403);
  assert.equal((await request(external,uploadRoute,{method:'POST',headers,body:JSON.stringify({...uploadSpec,size:500*1024**2+1})})).status,413);
  const created=await request(external,uploadRoute,{method:'POST',headers,body:JSON.stringify(uploadSpec)});assert.equal(created.status,201);const upload=await created.json();
  const otherLogin=await request(external,'/trial-login',{method:'POST',headers:{Host:new URL(origin).host,Origin:origin,Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:'password=test-password'});
  const otherCookie=otherLogin.headers.get('set-cookie').split(';')[0];
  const otherHealth=await(await request(external,'/api/health',{headers:{Host:new URL(origin).host,Cookie:otherCookie}})).json();
  const otherHeaders={...headers,Cookie:otherCookie,'X-Local-Token':otherHealth.csrf};
  for(const [method,suffix] of [['GET',''],['GET','/preview'],['POST','/complete'],['PUT','/chunks/0'],['DELETE','']])assert.equal((await request(external,uploadRoute+'/'+upload.id+suffix,{method,headers:otherHeaders,body:method==='PUT'?'notazip!':undefined})).status,410);
  assert.equal((await request(external,uploadRoute+'/'+upload.id+'/chunks/0',{method:'PUT',headers,body:'short'})).status,400);
  for(let i=0;i<2;i++)assert.equal((await request(external,uploadRoute+'/'+upload.id+'/chunks/0',{method:'PUT',headers,body:'notazip!'})).status,200);
  const failed=await(await request(external,uploadRoute+'/'+upload.id+'/complete',{method:'POST',headers})).json();assert.equal(failed.state,'failed');assert.equal(failed.code,'invalid_format');
  assert.equal((await request(external,uploadRoute+'/'+upload.id,{method:'DELETE',headers})).status,200);
  const lh=await (await request(local,'/api/health')).json(),adminHeaders={'X-Local-Token':lh.csrf};
  assert.equal((await request(local,'/api/feedback-admin')).status,403);
  assert.equal((await request(local,'/api/feedback-admin',{headers:{...adminHeaders,Origin:'https://evil.example'}})).status,403);
  assert.equal((await request(local,'/api/feedback-admin',{headers:{...adminHeaders,Host:'evil.example'}})).status,403);
  const items=(await (await request(local,'/api/feedback-admin',{headers:adminHeaders})).json()).items;assert.equal(items.length,1);
  assert.equal((await (await request(local,'/api/feedback-admin/'+receipt.id,{headers:adminHeaders})).json()).comment,'网页试用反馈');
  local.child.kill();await new Promise(resolve=>local.child.once('exit',resolve));const reboot=await start(false),rh=await (await request(reboot,'/api/health')).json();
  assert.equal((await (await request(reboot,'/api/feedback-admin',{headers:{'X-Local-Token':rh.csrf}})).json()).items.length,1);
  assert.equal((await (await request(external,'/api/health',{headers:{Cookie:cookie}})).json()).paidRequests,h.paidRequests);
});
