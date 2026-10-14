import { createHash } from 'node:crypto';

// Only normalized, diagnosis-relevant inputs participate; never hash the API key.
export function analysisKey(session, config, promptVersion) {
  return createHash('sha256').update(JSON.stringify({
    provider: config.provider, model: config.model, promptVersion,
    pages: session.pages.map(({ number, text }) => ({ number, text })),
    segments: session.segments.map(({ id, text, page, start, end, source }) => ({ id, text, page, start, end, source })),
    transcriptSource: session.transcriptSource,
    events: session.events.map(({ page, at }) => ({ page, at })),
    durationSeconds: session.durationSeconds, targetSeconds: session.targetSeconds,
    audience: session.audience, takeaways: session.takeaways
  })).digest('hex');
}

export class AnalysisCache {
  constructor({ maxEntries = 50, ttlMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
    this.entries = new Map(); this.pending = new Map();
    this.maxEntries = maxEntries; this.ttlMs = ttlMs; this.now = now;
  }

  async getOrCreate(key, producer, { cacheable = () => true } = {}) {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(id);
    if (this.entries.has(key)) return { report: structuredClone(this.entries.get(key).report), cacheHit: true };
    if (this.pending.has(key)) return { report: structuredClone(await this.pending.get(key)), cacheHit: true };
    const task = Promise.resolve().then(producer).then(report => {
      if (cacheable(report)) {
        while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
        this.entries.set(key, { report: structuredClone(report), expires: this.now() + this.ttlMs });
      }
      return report;
    });
    this.pending.set(key, task);
    try { return { report: structuredClone(await task), cacheHit: false }; }
    finally { this.pending.delete(key); }
  }
}
