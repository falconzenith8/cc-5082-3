export class EventRecorder {
  constructor(limit = 4000) {
    this.limit = limit;
    this.nextSeq = 1;
    this.events = [];
    this.frames = [];
  }

  push(type, atMs, data = {}) {
    const event = { seq: this.nextSeq++, type, atMs, ...data };
    this.events.push(event);
    if (this.events.length > this.limit) this.events.shift();
    return event;
  }

  frame(frame, atMs) {
    this.frames.push({ atMs, ...frame });
  }

  eventsSince(seq) {
    return this.events.filter((event) => event.seq > seq);
  }

  replayPayload(meta) {
    return {
      meta,
      events: this.events,
      frames: this.frames,
      durationMs: meta.durationMs,
      scoreToWin: meta.scoreToWin,
      config: meta.config
    };
  }
}
