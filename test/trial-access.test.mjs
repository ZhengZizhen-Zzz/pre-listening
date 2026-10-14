import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { TrialAccess, loginPage, TRIAL_TOTAL_LIMIT } from '../lib/trial-access.mjs';

async function setup(t, options) {
  const directory = await mkdtemp(path.join(tmpdir(),'rehearsal-access-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  await writeFile(path.join(directory,'access.json'),JSON.stringify({passwordHash:createHash('sha256').update('test-password').digest('hex'),secret:randomBytes(32).toString('hex')}));
  const access = new TrialAccess(directory,options); await access.init(); return access;
}
test('未配置外网地址时拒绝访问，只接受完整 HTTPS origin',async t=>{
  const access=await setup(t); await assert.rejects(access.origin(),{status:503});
  for(const value of ['http://example.com','https://example.com/path','https://a:b@example.com']){
    await writeFile(path.join(access.directory,'origin.txt'),value);await assert.rejects(access.origin(),{status:503});
  }
  await writeFile(path.join(access.directory,'origin.txt'),'https://example.com');assert.equal((await access.origin()).host,'example.com');
});
test('密码登录得到独立签名身份，篡改、过期、错误密码均拒绝',async t=>{
  let now=1000;const access=await setup(t,{now:()=>now});
  assert.throws(()=>access.login('wrong'),{status:401});
  const cookie=access.login('test-password');assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
  const req={headers:{cookie}};const first=access.session(req);assert.ok(first);
  const second=access.session({headers:{cookie:access.login('test-password')}});assert.notEqual(first.owner,second.owner);assert.notEqual(access.csrf(first.owner),access.csrf(second.owner));
  assert.equal(access.session({headers:{cookie:cookie.replace('=','=x')}}),null);
  assert.equal(access.session({headers:{}}),null);
  now+=86400001;assert.equal(access.session(req),null);
});
test('额度落盘重启不重置，单人24次、总计400次',async t=>{
  const access=await setup(t);for(let i=0;i<24;i++)await access.consume('alice');
  await assert.rejects(access.consume('alice'),{status:429});
  const reboot=new TrialAccess(access.directory);await reboot.init();await assert.rejects(reboot.consume('alice'),{status:429});
  for(let i=24;i<TRIAL_TOTAL_LIMIT;i++)await reboot.consume('user-'+Math.floor(i/24));
  await assert.rejects(reboot.consume('d'),{status:429});assert.equal(reboot.usage.total,TRIAL_TOTAL_LIMIT);
});
test('登录尝试限流，展示文字转义',async t=>{
  const access=await setup(t);for(let i=0;i<20;i++)assert.throws(()=>access.login('wrong'),{status:401});
  assert.throws(()=>access.login('test-password'),{status:429});assert.ok(!loginPage('<script>alert(1)</script>').includes('<script>'));
});
