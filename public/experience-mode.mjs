// Only the separate static build enables this flag. The live app keeps its normal flow.
export const isShowcase = typeof __PRE_SHOWCASE__ !== 'undefined' && __PRE_SHOWCASE__;
