export class EventRecorder {
  constructor(limit = 4000, frameLimit = 2000) {
    this.limit = limit;
    this.frameLimit = frameLimit;
    this.nextSeq = 1;
    this.events = [];
    this.frames = [];
    this.droppedEvents = 0;
    this.droppedFrames = 0;
  }

  push(type, atMs, data = {}) {
    const event = { seq: this.nextSeq++, type, atMs, ...data };
    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events.shift();
      this.droppedEvents += 1;
    }
    return event;
  }

  frame(frame, atMs) {
    this.frames.push({ atMs, ...frame });
    if (this.frames.length > this.frameLimit) {
      this.frames.shift();
      this.droppedFrames += 1;
    }
  }

  stats() {
    return {
      eventLimit: this.limit,
      frameLimit: this.frameLimit,
      events: this.events.length,
      frames: this.frames.length,
      droppedEvents: this.droppedEvents,
      droppedFrames: this.droppedFrames,
      lastSeq: this.nextSeq - 1
    };
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
