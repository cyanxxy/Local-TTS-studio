/**
 * Small promise helpers shared by the IndexedDB-backed stores (voice library,
 * generation history). They work in browsers and in the Electron renderer,
 * whose origin keeps its own IndexedDB just like a browser tab.
 */

/**
 * One schema step. `migrate` runs inside the version-change transaction when
 * the stored database is older than `version`, so each step only has to move
 * the schema from `version - 1` to `version`.
 */
export interface IndexedDbMigration {
  version: number;
  migrate: (database: IDBDatabase, transaction: IDBTransaction) => void;
}

export interface OpenVersionedDatabaseOptions {
  name: string;
  migrations: readonly IndexedDbMigration[];
  /** Shown when another tab holds an older version open during an upgrade. */
  blockedMessage: string;
  /** Shown when the browser provides no IndexedDB at all. */
  unsupportedMessage: string;
}

export function isIndexedDbSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
}

/** The schema version a migration list produces: its highest step. */
export function latestMigrationVersion(migrations: readonly IndexedDbMigration[]): number {
  let latest = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error("IndexedDB migration versions must be positive integers.");
    }
    if (migration.version <= latest) {
      throw new Error("IndexedDB migrations must be listed in strictly increasing version order.");
    }
    latest = migration.version;
  }
  if (latest === 0) throw new Error("An IndexedDB schema needs at least one migration.");
  return latest;
}

export function openVersionedDatabase(options: OpenVersionedDatabaseOptions): Promise<IDBDatabase> {
  if (!isIndexedDbSupported()) {
    return Promise.reject(new Error(options.unsupportedMessage));
  }
  let version: number;
  try {
    version = latestMigrationVersion(options.migrations);
  } catch (cause) {
    return Promise.reject(cause);
  }

  const request = indexedDB.open(options.name, version);
  request.onupgradeneeded = (event) => {
    const database = request.result;
    const transaction = request.transaction;
    // The version-change transaction always exists inside onupgradeneeded.
    if (!transaction) return;
    for (const migration of options.migrations) {
      if (migration.version > event.oldVersion) migration.migrate(database, transaction);
    }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    request.onsuccess = () => {
      const database = request.result;
      // A newer tab upgrading the schema must not stay blocked behind us.
      database.onversionchange = () => database.close();
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      resolve(database);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error(`Failed to open ${options.name}.`));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error(options.blockedMessage));
    };
  });
}

export function deleteIndexedDatabase(name: string): Promise<void> {
  if (!isIndexedDbSupported()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Failed to delete ${name}.`));
    request.onblocked = () => reject(new Error(`Deleting ${name} was blocked by another open tab.`));
  });
}

/**
 * Values rehydrated from IndexedDB or structured clone may come from another
 * realm, where `instanceof ArrayBuffer` no longer recognizes a real buffer.
 */
export function isArrayBufferLike(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer
    || Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

export function isUint8ArrayLike(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
    || Object.prototype.toString.call(value) === "[object Uint8Array]";
}
