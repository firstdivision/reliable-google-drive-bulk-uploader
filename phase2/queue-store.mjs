export class QueueStore {
  #indexedDB;
  #name;
  #database = null;
  #opening = null;
  #transactions = new Map();
  #closedMessage = 'Queue storage is not open. Call open() first.';

  constructor({ indexedDB = globalThis.indexedDB, name = 'batchharbor-queue' } = {}) {
    this.#indexedDB = indexedDB;
    this.#name = name;
  }

  async open() {
    if (this.#database) return;
    if (this.#opening) return this.#opening.promise;
    if (!this.#indexedDB || typeof this.#indexedDB.open !== 'function') {
      throw new Error('IndexedDB queue storage is unavailable.');
    }

    const opening = {};
    this.#opening = opening;
    opening.promise = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };
      opening.cancel = () => fail('Queue storage was closed while opening.');
      let request;
      try {
        request = this.#indexedDB.open(this.#name, 1);
      } catch {
        fail('Unable to open IndexedDB queue storage.');
        return;
      }
      request.onblocked = () => fail('Opening queue storage is blocked. Close other tabs using this database and retry.');
      request.onerror = () => fail('Unable to open IndexedDB queue storage.');
      request.onupgradeneeded = (event) => {
        if (settled) {
          request.transaction.abort();
          return;
        }
        try {
          if (event.oldVersion === 0) request.result.createObjectStore('state');
        } catch {
          fail('Unable to initialize IndexedDB queue storage.');
          request.transaction.abort();
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        if (!database.objectStoreNames.contains('state')) {
          database.close();
          fail('Queue storage schema is invalid: missing state object store.');
          return;
        }
        database.onversionchange = () => {
          database.close();
          if (this.#database === database) {
            this.#database = null;
            this.#closedMessage = 'Queue storage closed because its database version changed. Reopen before continuing.';
          }
        };
        database.onclose = () => {
          if (this.#database === database) {
            this.#database = null;
            this.#closedMessage = 'Queue storage connection closed unexpectedly. Reopen before continuing.';
          }
        };
        this.#database = database;
        settled = true;
        resolve();
      };
    });
    try {
      await opening.promise;
    } finally {
      if (this.#opening === opening) this.#opening = null;
    }
  }

  async load() {
    return this.#transaction('readonly');
  }

  async save(snapshot) {
    return this.#transaction('readwrite', snapshot);
  }

  #transaction(mode, snapshot) {
    return new Promise((resolve, reject) => {
      if (!this.#database) {
        reject(new Error(this.#closedMessage));
        return;
      }
      const operation = mode === 'readonly' ? 'load' : 'save';
      let transaction;
      let request;
      let requestFailed = false;
      try {
        transaction = this.#database.transaction('state', mode, { durability: mode === 'readwrite' ? 'strict' : 'default' });
        this.#transactions.set(transaction, reject);
        transaction.oncomplete = () => {
          this.#transactions.delete(transaction);
          if (requestFailed) {
            reject(new Error(`Unable to ${operation} queue snapshot: IndexedDB request failed.`));
          } else {
            resolve(mode === 'readonly' ? (request.result === undefined ? null : request.result) : undefined);
          }
        };
        transaction.onabort = () => {
          this.#transactions.delete(transaction);
          reject(new Error(`Unable to ${operation} queue snapshot: IndexedDB transaction aborted.`));
        };
        transaction.onerror = () => { requestFailed = true; };
        const store = transaction.objectStore('state');
        request = mode === 'readonly' ? store.get('batch') : store.put(snapshot, 'batch');
        request.onerror = () => { requestFailed = true; };
      } catch {
        if (transaction) {
          this.#transactions.delete(transaction);
          try { transaction.abort(); } catch {}
        }
        reject(new Error(`Unable to ${operation} queue snapshot: IndexedDB operation failed.`));
      }
    });
  }

  close({ abortPending = false } = {}) {
    this.#opening?.cancel();
    this.#opening = null;
    if (abortPending) {
      for (const [transaction, reject] of this.#transactions) {
        try { transaction.abort(); } catch {}
        reject(new Error('Queue storage was closed during a transaction.'));
      }
      this.#transactions.clear();
    }
    this.#database?.close();
    this.#database = null;
    this.#closedMessage = 'Queue storage is closed. Call open() before continuing.';
  }
}