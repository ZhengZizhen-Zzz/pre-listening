import test from 'node:test';import assert from 'node:assert/strict';
import {transcriptionRecoveryText,rejectedTranscriptionSubmission} from '../public/transcription-recovery.mjs';
import {readApiResponse} from '../public/api-response.mjs';
test('明确的提交拒绝保留原因并允许继续转写；网络不确定状态不能当作未提交',async()=>{
 let error;try{await readApiResponse(new Response(JSON.stringify({error:'服务提交失败',submissionStarted:false,code:'asr_admission_failed'}),{status:500}));}catch(e){error=e;}
 assert.equal(rejectedTranscriptionSubmission(error),true);assert.equal(error.code,'asr_admission_failed');
 for(const status of [400,401,403,409,413,429])assert.equal(rejectedTranscriptionSubmission({status}),true);
 assert.equal(rejectedTranscriptionSubmission({status:504}),false);
 assert.equal(rejectedTranscriptionSubmission({status:503,jobId:'accepted'}),false);
 assert.match(transcriptionRecoveryText({jobStatus:null,jobError:'已有任务正在提交，请稍后重试。'}),/已有任务/);
 assert.match(transcriptionRecoveryText({jobStatus:'uncertain',jobError:'timeout'}),/继续转写/);
 assert.match(transcriptionRecoveryText({jobStatus:'failed',jobError:'ASR_RESPONSE_HAVE_NO_WORDS'}),/未识别出发言/);
 assert.doesNotMatch(transcriptionRecoveryText({jobError:'ReferenceError: activePaid is not defined'}),/ReferenceError/);
});
