import type { Preferences } from "./types";
interface Save {
  id: string;
  value: Preferences;
  connectionId?: string;
  version: number;
}

/** Ordered full-state writes, with per-conversation recovery across connections. */
export class PreferenceSaveQueue {
  private send: (save: Save) => Promise<unknown>;
  private pending = new Map<string, Save>();
  private latest = new Map<string, Save>();
  private recovery = new Map<string, Save>();
  private chain: Promise<void> = Promise.resolve();
  private version = 0;
  constructor(send: (save: Save) => Promise<unknown>) {
    this.send = send;
  }
  stage(id: string, value: Preferences, connectionId?: string) {
    const save = { id, value, connectionId, version: ++this.version };
    this.pending.set(id, save);
    this.latest.set(id, save);
  }
  recover(id: string) {
    return this.recovery.get(id)?.value;
  }
  private remember(save: Save) {
    if ((this.recovery.get(save.id)?.version || 0) <= save.version)
      this.recovery.set(save.id, save);
  }
  preserve() {
    const preserved = this.pending.size > 0;
    for (const save of this.pending.values()) this.remember(save);
    this.pending.clear();
    // Old failures remain recoverable, but do not block unrelated new connections.
    this.chain = this.chain.catch(() => {});
    return preserved;
  }
  flush(): Promise<void> {
    const batch = [...this.pending.values()];
    this.pending.clear();
    if (!batch.length) return this.chain;
    const job = this.chain
      .catch(() => {})
      .then(async () => {
        let failure: unknown;
        for (const save of batch) {
          try {
            await this.send(save);
            if ((this.recovery.get(save.id)?.version || 0) <= save.version)
              this.recovery.delete(save.id);
          } catch (error) {
            this.remember(this.latest.get(save.id) || save);
            failure ||= error;
          }
        }
        if (failure) throw failure;
      });
    this.chain = job;
    void job.catch(() => {});
    return job;
  }
}
