import test from 'node:test';
import assert from 'node:assert/strict';
import {pageNumbers, previewBounds, defaultPreviewHeight} from '../public/preview-controls.mjs';
import {zoomGeometry} from '../public/slide-zoom.mjs';
import {createPreviewCache} from '../public/preview-cache.mjs';

test('60 页的任意当前位置都可达；导航最多七项并保留首末页', () => {
  for(let total=1;total<=60;total++)for(let current=1;current<=total;current++) {
    const items=pageNumbers(total,current), numbers=items.filter(Number.isInteger);
    assert.ok(items.length<=7, `${total}/${current}: ${items}`);
    assert.ok(numbers.includes(current)); assert.equal(numbers[0],1); assert.equal(numbers.at(-1),total);
    assert.deepEqual(numbers,[...new Set(numbers)].sort((a,b)=>a-b));
  }
});
test('横版、竖版和窄屏的拖动上限与页面实际宽度吻合', () => {
  for(const ratio of [16/9,4/3,3/4])for(const width of [280,700,1100]){
    const {min,max}=previewBounds(width,ratio);
    assert.ok(min<=max);assert.ok(min>0);assert.ok(Math.abs((max-24)*ratio-(width-24))<.001);
  }
});
test('landscape decks use available width by default while portrait pages stay bounded',()=>{
  assert.ok(defaultPreviewHeight(1000,16/9,800)>800*.56);
  assert.equal(defaultPreviewHeight(1000,16/9,800),previewBounds(1000,16/9).max);
  assert.ok(defaultPreviewHeight(1200,3/4,800)<=640);
  assert.equal(defaultPreviewHeight(320,16/9,700),previewBounds(320,16/9).max);
});
test('whole-page zoom fits both slide orientations and preserves aspect ratio at 300 percent',()=>{
  for(const [width,height] of [[1200,680],[360,500]])for(const [pageWidth,pageHeight] of [[1920,1080],[800,1200]]){
    const args={width,height,pageWidth,pageHeight},fit=zoomGeometry(args),large=zoomGeometry({...args,zoom:3});
    assert.ok(fit.imageWidth<=width-32+.001&&fit.imageHeight<=height-32+.001);
    assert.ok(Math.abs(large.imageWidth/large.imageHeight-pageWidth/pageHeight)<.0001);
    assert.ok(Math.abs(large.imageWidth-fit.imageWidth*3)<.0001);
    assert.ok(large.sheetWidth>=large.imageWidth+32&&large.sheetHeight>=large.imageHeight+32);
  }
});
test('zoom is bounded and hidden or missing image sizes do not produce invalid layout',()=>{
  const args={width:1200,height:680,pageWidth:1920,pageHeight:1080};
  assert.equal(zoomGeometry({...args,zoom:40}).zoom,3);assert.equal(zoomGeometry({...args,zoom:-4}).zoom,1);
  assert.equal(zoomGeometry({...args,width:0}),null);assert.equal(zoomGeometry({...args,pageHeight:NaN}),null);
});
function fixture() {
  const meta=new Map(),assets=new Map();
  const records={getMeta:async k=>meta.get(k),setMeta:async(k,v)=>meta.set(k,v),getAsset:async id=>assets.get(id)};
  return {meta,assets,records,cache:createPreviewCache(records)};
}
test('相同内容可复用，改名不影响；同名文件内容变化不复用', async () => {
  const {cache,assets}=fixture();assets.set('preview',new Blob(['%PDF-old']));
  const file=new File(['slide A'],'talk.pptx');const first=await cache.find(file);
  assert.equal(first.blob,null);await cache.remember(first.key,'preview');
  const renamed=await cache.find(new File(['slide A'],'renamed.pptx'));
  assert.equal(renamed.assetId,'preview');assert.equal(await renamed.blob.text(),'%PDF-old');
  const changed=await cache.find(new File(['slide B'],'talk.pptx'));assert.equal(changed.blob,null);
});
test('缓存附件不存在或浏览器存储失败时，退回正常导入', async () => {
  const {cache}=fixture();const file=new Blob(['slides']);const first=await cache.find(file);
  await cache.remember(first.key,'missing');assert.equal((await cache.find(file)).blob,null);
  const broken=createPreviewCache({getMeta:async()=>{throw new Error('storage denied');}});
  assert.equal((await broken.find(file)).blob,null);await broken.remember('key','asset');
});
test('最近八份预览只保留引用，不重复存储或删除历史附件', async () => {
  const {cache,meta,assets}=fixture();assets.set('original',new Blob(['saved']));
  for(let i=0;i<10;i++)await cache.remember(`key${i}`,`asset${i}`);
  await cache.remember('key8','asset8');
  const entries=[...meta.values()][0];assert.equal(entries.length,8);assert.equal(entries[0].key,'key8');
  assert.equal(entries.filter(e=>e.key==='key8').length,1);assert.equal(assets.size,1);
});

test('large decks skip cache hashing instead of allocating a second full copy',async()=>{
 const {cache}=fixture();const large={size:100*1024**2,arrayBuffer:()=>{throw new Error('must not read full file');}};
 assert.deepEqual(await cache.find(large),{key:null,blob:null});
});
