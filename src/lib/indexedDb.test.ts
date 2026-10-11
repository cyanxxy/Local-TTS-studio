import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChangeNotifier,
  deleteIndexedDatabase,
  isArrayBufferLike,
  isIndexedDbSupported,
  isUint8ArrayLike,
  latestMigrationVersion,
  openVersionedDatabase,
  requestResult,
  runTransaction,
  transactionDone,
  type IndexedDbMigration,
} from "./indexedDb";

const NAME = "open-tts-indexeddb-test";

function options(migrations: readonly IndexedDbMigration[]) {
  return {
    name: NAME,
    migrations,
    blockedMessage: "blocked by another tab",
    unsupportedMessage: "no IndexedDB",
  };
}

const V1: IndexedDbMigration = {
  version: 1,
  migrate: (database) => {
    database.createObjectStore("items", { keyPath: "id" });
  },
};

describe("indexedDb helpers", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates migration ordering", () => {
    expect(latestMigrationVersion([V1, { version: 3, migrate: () => {} }])).toBe(3);
    expect(() => latestMigrationVersion([])).toThrow(/at least one migration/);
    expect(() => latestMigrationVersion([{ version: 0, migrate: () => {} }])).toThrow(/positive integers/);
    expect(() => latestMigrationVersion([V1, V1])).toThrow(/strictly increasing/);
  });

  it("runs only the migrations newer than the stored version", async () => {
    const database = await openVersionedDatabase(options([V1]));
    const transaction = database.transaction("items", "readwrite");
    transaction.objectStore("items").put({ id: "a", value: 1 });
    await transactionDone(transaction);
    database.close();

    const v1 = vi.fn();
    const v2 = vi.fn((db: IDBDatabase, upgrade: IDBTransaction) => {
      upgrade.objectStore("items").createIndex("value", "value");
      db.createObjectStore("extra", { keyPath: "id" });
    });
    const upgraded = await openVersionedDatabase(options([
      { version: 1, migrate: v1 },
      { version: 2, migrate: v2 },
    ]));
    expect(v1).not.toHaveBeenCalled();
    expect(v2).toHaveBeenCalledTimes(1);
    expect(upgraded.version).toBe(2);
    expect([...upgraded.objectStoreNames].sort()).toEqual(["extra", "items"]);
    const read = upgraded.transaction("items", "readonly");
    const record = await requestResult(read.objectStore("items").index("value").get(1));
    expect(record).toEqual({ id: "a", value: 1 });
    upgraded.close();
  });

  it("closes itself when a newer version needs the database", async () => {
    const database = await openVersionedDatabase(options([V1]));
    const close = vi.spyOn(database, "close");
    const upgraded = await openVersionedDatabase(options([V1, { version: 2, migrate: () => {} }]));
    expect(close).toHaveBeenCalled();
    upgraded.close();
  });

  it("rejects with the blocked message when an old connection refuses to close", async () => {
    const database = await openVersionedDatabase(options([V1]));
    database.onversionchange = null;
    await expect(openVersionedDatabase(options([V1, { version: 2, migrate: () => {} }])))
      .rejects.toThrow("blocked by another tab");
    database.close();
  });

  it("rejects invalid migration lists and missing IndexedDB", async () => {
    await expect(openVersionedDatabase(options([]))).rejects.toThrow(/at least one migration/);
    vi.stubGlobal("indexedDB", undefined);
    expect(isIndexedDbSupported()).toBe(false);
    await expect(openVersionedDatabase(options([V1]))).rejects.toThrow("no IndexedDB");
    await expect(deleteIndexedDatabase(NAME)).resolves.toBeUndefined();
  });

  it("deletes a database", async () => {
    (await openVersionedDatabase(options([V1]))).close();
    await deleteIndexedDatabase(NAME);
    const reopened = await openVersionedDatabase(options([V1]));
    const count = await requestResult(reopened.transaction("items").objectStore("items").count());
    expect(count).toBe(0);
    reopened.close();
  });

  it("surfaces failed requests and aborted transactions", async () => {
    const database = await openVersionedDatabase(options([V1]));
    const transaction = database.transaction("items", "readwrite");
    const store = transaction.objectStore("items");
    store.add({ id: "dup" });
    const failed = requestResult(store.add({ id: "dup" }));
    const done = transactionDone(transaction);
    await expect(failed).rejects.toBeTruthy();
    await expect(done).rejects.toBeTruthy();
    database.close();
  });

  it("recognizes buffers from other realms", () => {
    expect(isArrayBufferLike(new ArrayBuffer(1))).toBe(true);
    expect(isArrayBufferLike(new Uint8Array(1))).toBe(false);
    expect(isUint8ArrayLike(new Uint8Array(1))).toBe(true);
    expect(isUint8ArrayLike(new ArrayBuffer(1))).toBe(false);
  });
});

describe("runTransaction", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("commits successful work and rolls back a throwing operation", async () => {
    const open = () => openVersionedDatabase(options([V1]));
    await runTransaction(open, ["items"], "readwrite", async (transaction) => {
      transaction.objectStore("items").put({ id: "kept" });
    });
    await expect(runTransaction(open, ["items"], "readwrite", async (transaction) => {
      transaction.objectStore("items").put({ id: "rolled-back" });
      await requestResult(transaction.objectStore("items").get("kept"));
      throw new Error("validation failed");
    })).rejects.toThrow("validation failed");
    const keys = await runTransaction(open, ["items"], "readonly", (transaction) => (
      requestResult(transaction.objectStore("items").getAllKeys())
    ));
    expect(keys).toEqual(["kept"]);
  });
});

describe("createChangeNotifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("notifies local listeners and isolates faulty ones", () => {
    const notifier = createChangeNotifier("open-tts-test-local");
    const first = vi.fn(() => {
      throw new Error("bad listener");
    });
    const second = vi.fn();
    const unsubscribeFirst = notifier.subscribe(first);
    const unsubscribeSecond = notifier.subscribe(second);
    notifier.emit();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    unsubscribeSecond();
    notifier.emit();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("relays changes between notifiers on the same channel", async () => {
    const listening = createChangeNotifier("open-tts-test-relay");
    const writer = createChangeNotifier("open-tts-test-relay");
    const listener = vi.fn();
    const unsubscribe = listening.subscribe(listener);
    writer.emit();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    unsubscribe();
  });

  it("works without BroadcastChannel", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const notifier = createChangeNotifier("open-tts-test-none");
    const listener = vi.fn();
    const unsubscribe = notifier.subscribe(listener);
    notifier.emit();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
