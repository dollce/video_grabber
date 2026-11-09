import type { CapturedResponse } from './types';

const DATABASE = 'video-grabber-capture';
const STORE = 'responses';
let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('tab', 'tabId');
        store.createIndex('tabUrl', ['tabId', 'url']);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = undefined; };
        resolve(db);
      };
      request.onerror = () => { opening = undefined; reject(request.error); };
      request.onblocked = () => { opening = undefined; reject(new Error('수집 저장소를 열 수 없습니다. 다른 확장 프로그램 창을 닫고 다시 시도하세요.')); };
    });
  }
  return opening;
}

function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('수집 데이터 저장 실패'));
    transaction.onabort = () => reject(transaction.error ?? new Error('수집 데이터 저장 취소'));
  });
}

export async function putCaptured(response: CapturedResponse): Promise<void> {
  const db = await database();
  const transaction = db.transaction(STORE, 'readwrite');
  transaction.objectStore(STORE).put(response);
  await completion(transaction);
}

/** Exact URL lookup, oldest first, including repeated playlist snapshots. */
export async function getCapturedResponses(tabId: number, url: string): Promise<CapturedResponse[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).index('tabUrl').getAll(IDBKeyRange.only([tabId, url]));
    request.onsuccess = () => resolve((request.result as CapturedResponse[]).sort((a, b) => a.capturedAt - b.capturedAt));
    request.onerror = () => reject(request.error);
  });
}

export async function clearCaptured(tabId: number): Promise<void> {
  const db = await database();
  const transaction = db.transaction(STORE, 'readwrite');
  const request = transaction.objectStore(STORE).index('tab').openCursor(IDBKeyRange.only(tabId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) { cursor.delete(); cursor.continue(); }
  };
  await completion(transaction);
}

/** Runs at browser startup so closed-session media is not retained indefinitely. */
export async function clearAllCaptured(): Promise<void> {
  const db = await database();
  const transaction = db.transaction(STORE, 'readwrite');
  transaction.objectStore(STORE).clear();
  await completion(transaction);
}
