export function appendRecordingPart(record,assetId){
 const offset=Math.max(0,record.recordingOffset||0),parts=[...(record.audioParts||[])];
 // Older records had only an audioAssetId; keep that prefix before appending.
 if(!parts.length&&offset>0&&record.audioAssetId&&record.audioAssetId!==assetId)parts.push({assetId:record.audioAssetId,offset:0,duration:offset,events:(record.events||[]).filter(e=>e.at<offset),transcribed:!!record.jobApplied,...(record.jobApplied?{transcript:record.segments||[]}:{}),job:record.job,jobStatus:record.jobStatus,jobTerms:record.jobTerms});
 if(!parts.some(p=>p.assetId===assetId))parts.push({assetId,offset,duration:Math.max(0,(record.durationSeconds||0)-offset),events:(record.events||[]).filter(e=>e.at>=offset).map(e=>({page:e.page,at:e.at-offset})),transcribed:false});
 return parts;
}
