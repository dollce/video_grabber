import type { CapturedResponse } from './types';
import { httpUrl } from './detection';

const DATABASE = 'video-grabber-capture';
const STORE = 'responses';
let opening: Promise<IDBDatabase> | undefined;

/** Bound redirect metadata independently of the captured response body. */
export function boundedAliases(url: string, values: readonly string[]): string[] {
  const aliases: string[] = [];
  let characters = 0;
  for (const value of values) {
    if (!httpUrl(value) || value === url || aliases.includes(value)) continue;
    if (aliases.length >= 20 || characters + value.length > 32768) break;
    aliases.push(value);
    characters += value.length;
  }
  return aliases;
}

function database(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 2);
      request.onupgradeneeded = () => {
        const store = request.result.objectStoreNames.contains(STORE)
          ? request.transaction!.objectStore(STORE)
          : request.result.createObjectStore(STORE, { keyPath: 'id' });
        if (!store.indexNames.contains('tab')) store.createIndex('tab', 'tabId');
        if (!store.indexNames.contains('tabUrl')) store.createIndex('tabUrl', ['tabId', 'url']);
        // A single keyPath with multiEntry permits each key to be [tabId, URL].
        // Version-1 records remain readable through their original tabUrl index.
        if (!store.indexNames.contains('tabAlias')) store.createIndex('tabAlias', 'aliasKeys', { multiEntry: true });
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
  const aliases = boundedAliases(response.url, response.aliases ?? []);
  transaction.objectStore(STORE).put({ ...response, aliases, aliasKeys: aliases.map(url => [response.tabId, url]) });
  await completion(transaction);
}

/** Observed final/redirect URL lookup, oldest first, with one body per response. */
export async function getCapturedResponses(tabId: number, url: string): Promise<CapturedResponse[]> {
  const db = await database();
  const store = db.transaction(STORE).objectStore(STORE);
  const lookup = (index: string) => new Promise<CapturedResponse[]>((resolve, reject) => {
    const request = store.index(index).getAll(IDBKeyRange.only([tabId, url]));
    request.onsuccess = () => resolve(request.result as CapturedResponse[]);
    request.onerror = () => reject(request.error);
  });
  const matches = await Promise.all([lookup('tabUrl'), lookup('tabAlias')]);
  return [...new Map(matches.flat().filter(record => record.tabId === tabId).map(record => [record.id, record])).values()]
    .sort((a, b) => a.capturedAt - b.capturedAt);
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
