interface Activity {
  controller: AbortController;
  completion: Promise<void>;
}

/** Keeps model files exclusive to cache deletion until all their users stop. */
export class LocalModelLifecycle<Model extends string> {
  readonly #activities = new Map<Model, Set<Activity>>();
  readonly #clears = new Map<Model, Promise<unknown>>();
  #closed = false;

  async run<Result>(model: Model, operation: (signal: AbortSignal) => Promise<Result>): Promise<Result> {
    for (;;) {
      this.#assertOpen();
      const clear = this.#clears.get(model);
      if (!clear) break;
      await clear.catch(() => undefined);
    }

    // Register without yielding after checking the gate. A clear can then
    // either precede this operation or cancel/join it, never miss it.
    const controller = new AbortController();
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const activity = { controller, completion };
    const activities = this.#activities.get(model) ?? new Set<Activity>();
    activities.add(activity);
    this.#activities.set(model, activities);
    try {
      return await operation(controller.signal);
    } finally {
      activities.delete(activity);
      if (activities.size === 0) this.#activities.delete(model);
      finish();
    }
  }

  clear<Result>(model: Model, remove: () => Promise<Result>): Promise<Result> {
    this.#assertOpen();
    const previous = this.#clears.get(model);
    const activities = [...(this.#activities.get(model) ?? [])];
    const clear = (async () => {
      await previous?.catch(() => undefined);
      await Promise.all(activities.map((activity) => activity.completion));
      return remove();
    })();
    // Publish before aborting: cancellation callbacks may themselves dispatch
    // another request. Concurrent clears remain one uninterrupted barrier.
    this.#clears.set(model, clear);
    for (const activity of activities) activity.controller.abort();
    const release = () => {
      if (this.#clears.get(model) === clear) this.#clears.delete(model);
    };
    void clear.then(release, release);
    return clear;
  }

  get busy(): boolean {
    return this.#activities.size > 0 || this.#clears.size > 0;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const activities = [...this.#activities.values()].flatMap((entries) => [...entries]);
    for (const activity of activities) activity.controller.abort();
    await Promise.allSettled([
      ...activities.map((activity) => activity.completion),
      ...this.#clears.values(),
    ]);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("The local runtime is shutting down.");
  }
}
