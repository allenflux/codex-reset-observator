export type StorageAdapter = {
  getProcessedIds: () => Promise<string[]>;
  saveProcessedIds: (ids: string[]) => Promise<void>;
};

export type FetchAdapter = (payload: any) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<any>;
}>;

export class TweetDeduplicator {
  private queue: Promise<any> = Promise.resolve();

  constructor(
    private storage: StorageAdapter,
    private fetcher: FetchAdapter,
  ) {}

  public processTweet(payload: {
    tweetId: string;
    [key: string]: any;
  }): Promise<{ success: boolean; skipped?: boolean; data?: any; error?: string }> {
    // Chain processing through a sequential Promise queue (Mutex)
    const resultPromise = this.queue.then(() => this.executeProcessTweet(payload));
    this.queue = resultPromise.catch(() => {});
    return resultPromise;
  }

  private async executeProcessTweet(payload: { tweetId: string; [key: string]: any }) {
    const { tweetId } = payload;
    const processedIds = await this.storage.getProcessedIds();

    // 1. Skip if already processed in storage
    if (processedIds.includes(tweetId)) {
      return { success: true, skipped: true };
    }

    // 2. Fetch Webhook
    const res = await this.fetcher(payload);
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    // 3. Save to storage strictly on 2xx success
    const updatedIds = [...processedIds];
    if (!updatedIds.includes(tweetId)) {
      updatedIds.push(tweetId);
      if (updatedIds.length > 100) {
        updatedIds.shift();
      }
      await this.storage.saveProcessedIds(updatedIds);

      // Re-verify storage persistence after write
      const reVerifiedIds = await this.storage.getProcessedIds();
      if (!reVerifiedIds.includes(tweetId)) {
        throw new Error(`Storage verification failed: tweetId ${tweetId} was not persisted.`);
      }
    }

    const json = await res.json();
    return { success: true, data: json };
  }
}
