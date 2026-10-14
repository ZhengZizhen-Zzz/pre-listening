import { newTrainingRun, prepareQuestionTurns, validateQuestions, validateTrainingFeedback } from './training-core.mjs';

// Curated examples, never scored against user input or sent to a model.
const examples = [
  {
    question:'还没有完成访谈，为什么先关注提醒和取消流程？', segmentId:'s3', quote:'提醒和取消流程是否是主要问题，目前仍然是假设。',
    purpose:'说明研究方向的由来，同时区分假设与结论。',
    criteria:[['选择依据','解释为什么先关注这两个环节。'],['事实边界','明确哪些内容尚待验证。']],
    answer:'我想先关注预约成功以后的流程，但这两个方向目前只是研究假设，还没有访谈结果支持。下一步会观察同学确认预约和取消预约的过程，再决定是否继续。',
    summary:'说明了尚待验证，但选择这两个环节的依据还可以更具体。',
    checks:[['partly','我想先关注预约成功以后的流程','交代了研究范围，还没解释为何优先看提醒和取消。'],['met','还没有访谈结果支持','保留了尚未验证的前提。']],
    nextStep:'如果有真实观察，补充一条；如果没有，就明确这是探索方向，不必编造依据。'
  },
  {
    question:'如果同学觉得新方案不错，但完成任务没有更快，你会怎么判断？', segmentId:'s5', quote:'如果大家觉得不错，我们就继续做。',
    purpose:'区分主观偏好和任务效果。',
    criteria:[['判断依据','同时考虑使用感受和实际任务表现。'],['后续行动','说明结果不一致时如何继续验证。']],
    answer:'我不会只按“觉得不错”决定推进，会同时看任务是否完成、在哪一步停顿和耗时。如果偏好变好了但操作没有改善，我会回看操作过程并追问原因，再决定要不要调整方案。',
    summary:'回答了两类结果不一致时的判断方法，也给出了下一步。',
    checks:[['met','同时看任务是否完成、在哪一步停顿和耗时','补充了主观偏好之外的任务依据。'],['met','回看操作过程并追问原因','说明了如何定位差异，没有直接断言方案有效。']],
    nextStep:'再练时先说判断原则，再说具体操作，让听众更快抓到结论。'
  },
  {
    question:'你准备找哪些同学访谈，怎样避免只听到熟人的赞同？', segmentId:'s6', quote:'我会优先找近期有预约经历、也遇到过临时改变计划的同学，了解他们实际怎样处理。',
    purpose:'说明招募对象与访谈方式。',
    criteria:[['对象匹配','招募对象确实经历过所研究的场景。'],['降低引导','关注真实经历，而非诱导对方案的认同。']],
    answer:'先找近期预约过自习室、也有过临时取消经历的同学，不只找熟人。访谈时先请他们回忆最近一次操作，问当时怎么做、哪里遇到阻碍，之后再展示方案。',
    summary:'对象与研究场景匹配，也避免了一开始就询问是否喜欢方案。',
    checks:[['met','近期预约过自习室、也有过临时取消经历','给出了与研究问题有关的招募条件。'],['met','先请他们回忆最近一次操作','先了解行为，再展示方案，有助于减少引导。']],
    nextStep:'把“哪里遇到阻碍”改成“当时的过程怎么样”，避免预设对方一定有问题。'
  }
];

export function demoTrainingRun(parentId, session, deckName) {
  const questions=validateQuestions({questions:examples.map(e=>({question:e.question,evidence:{source:'speech',segmentId:e.segmentId,quote:e.quote},rubric:{purpose:e.purpose,criteria:e.criteria.map(([label,description])=>({label,description}))}}))},session,3,true).questions;
  const run=prepareQuestionTurns(newTrainingRun(parentId,'answer',session,{deckName,questions}));
  run.previewOnly=true;
  run.turns.forEach((turn,i)=>{
    const e=examples[i],attempt=turn.attempts[0];attempt.text=e.answer;attempt.source='demo';
    attempt.feedback=validateTrainingFeedback({summary:e.summary,nextStep:e.nextStep,checks:e.checks.map(([assessment,quote,reason],n)=>({id:`point_${n+1}`,assessment,quote,reason}))},{session,question:turn.question,answer:e.answer},'answer');
  });
  return run;
}
