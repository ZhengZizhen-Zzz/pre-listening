import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanOriginalNotes,readPptxNotes} from '../public/pptx-notes.mjs';
test('stored original notes validate page bounds, duplicates and lengths without changing text',()=>{
 const text='  原备注\n第二段 <script>仅作文本</script>  ';
 assert.deepEqual(cleanOriginalNotes([{page:1,text},{page:1,text:'重复'},{page:0,text:'无效'},{page:3,text:'越界'},{page:2,text:42}],2),[{page:1,text}]);
 assert.deepEqual(cleanOriginalNotes([{page:1,text:'x'.repeat(100001)}]),[]);
});
test('broken notes do not prevent importing a presentation; cancellation propagates',async()=>{
 assert.deepEqual(await readPptxNotes(new Blob(['broken'])),{notes:[],status:'unavailable'});
 const controller=new AbortController();controller.abort();await assert.rejects(readPptxNotes(new Blob(['broken']),{signal:controller.signal}),{name:'AbortError'});
});
