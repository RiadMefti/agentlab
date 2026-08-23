/** Serializes lifecycle mutations for one conversation without coupling to its adapters. */
export class ConversationLifecycle {
  readonly #tails = new Map<string, Promise<void>>();

  public async serialize<Result>(
    conversationId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const preceding = this.#tails.get(conversationId) ?? Promise.resolve();
    let release = (): void => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = preceding.then(() => turn);
    this.#tails.set(conversationId, tail);

    await preceding;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(conversationId) === tail) {
        this.#tails.delete(conversationId);
      }
    }
  }
}
