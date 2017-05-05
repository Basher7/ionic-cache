import { Injectable } from '@angular/core';
import { SqlStorage } from './storage';
import { Observable } from 'rxjs/Observable';
import { Subject } from 'rxjs/Subject';
import { Request, Response, ResponseOptions } from '@angular/http';
import 'rxjs/add/observable/fromPromise';
import 'rxjs/add/observable/fromEvent';
import 'rxjs/add/observable/merge';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/share';
import 'rxjs/add/operator/catch';

export const MESSAGES = {
  0: 'Cache initialization error: ',
  1: 'Cache is not enabled.',
  2: 'Cache entry already expired: ',
  3: 'No such key: ',
  4: 'No entries were deleted, because browser is offline.'
};

@Injectable()
export class CacheService {

  private ttl: number = 60 * 60; // one hour
  private tableName: string = 'cache';
  private cacheKeys: string[] = ['key unique', 'value', 'expire INTEGER', 'type', 'groupKey'];
  private storage: SqlStorage;
  private cacheEnabled: boolean = true;
  private invalidateOffline: boolean = false;
  private networkStatusChanges: Observable<boolean>;
  private networkStatus: boolean = true;

  constructor() {
    try {
      this.storage = new SqlStorage();
      this.watchNetworkInit();
      this.initDatabase();
      this.cacheEnabled = true;
    } catch (e) {
      this.cacheEnabled = false;
      console.error(MESSAGES[0], e);
    }
  }

  /**
   * @description Disable or enable cache
   */
  enableCache(enable: boolean = true) {
    this.cacheEnabled = enable;
  }

  /**
   * @description Create DB table for cache, if not exists
   * @return {Promise<any>}
   */
  private initDatabase(): Promise<any> {
    let query = `CREATE TABLE IF NOT EXISTS ${this.tableName} (${this.cacheKeys.join(', ')})`;
    return this.storage.query(query);
  }

  /**
   * @description Delete DB table and create new one
   * @return {Promise<any>}
   */
  private resetDatabase(): Promise<any> {
    return this.storage.query(`DROP TABLE ${this.tableName}`).then(() => {
      return this.initDatabase();
    });
  }

  /**
   * @description Set default TTL
   * @param {number} ttl - TTL in seconds
   */
  setDefaultTTL(ttl: number): number {
    return this.ttl = ttl;
  }

  /**
   * @description Set if expired cache should be invalidated if device is offline
   * @param {boolean} offlineInvalidate
   */
  setOfflineInvalidate(offlineInvalidate: boolean) {
    this.invalidateOffline = !offlineInvalidate;
  }

  /**
   * @description Start watching if devices is online or offline
   */
  private watchNetworkInit() {
    this.networkStatus = navigator.onLine;
    const connect = Observable.fromEvent(window, 'online').map(() => true),
      disconnect = Observable.fromEvent(window, 'offline').map(() => false);

    this.networkStatusChanges = Observable.merge(connect, disconnect).share();
    this.networkStatusChanges.subscribe(status => {
      this.networkStatus = status;
    });
  }

  /**
   * @description Stream of network status changes
   * * @return {Observable<boolean>} network status stream
   */
  getNetworkStatusChanges() {
    return this.networkStatusChanges;
  }

  /**
   * @description Check if devices is online
   * @return {boolean} network status
   */
  isOnline() {
    return this.networkStatus;
  }

  /**
   * @description Save item to cache
   * @param {string} key - Unique key
   * @param {any} data - Data to store
   * @param {string} [groupKey] - group key
   * @param {number} [ttl] - TTL in seconds
   * @return {Promise<any>} - saved data
   */
  saveItem(key: string, data: any, groupKey: string = 'none', ttl: number = this.ttl): Promise<any> {
    if (!this.cacheEnabled) {
      return Promise.reject(MESSAGES[1]);
    }

    const expire = new Date().getTime() + (ttl * 1000),
      type = CacheService.isRequest(data) ? 'request' : typeof data,
      value = JSON.stringify(data),
      valuesMap = { key, value, expire, type, groupKey },
      values = Object.keys(valuesMap).map(key => `${valuesMap[key]}`),
      query = `INSERT OR REPLACE INTO ${this.tableName} (${Object.keys(valuesMap).join(', ')}) VALUES (${values.map(() => '?').join(', ')})`;

    return this.storage.query(query, values).then(() => data);
  }

  /**
   * @description Delete item from cache
   * @param {string} key - Unique key
   * @return {Promise<any>} - query execution promise
   */
  removeItem(key: string): Promise<any> {
    if (!this.cacheEnabled) {
      return Promise.reject(MESSAGES[1]);
    }

    return this.storage.query(`DELETE FROM ${this.tableName} WHERE key = '${key}'`);
  }

  /**
   * @description Get item from cache without expire check etc.
   * @param {string} key - Unique key
   * @return {Promise<any>} - data from cache
   */
  getRawItem(key: string): Promise<any> {
    if (!this.cacheEnabled) {
      return Promise.reject(MESSAGES[1]);
    }

    let query = `SELECT * FROM ${this.tableName} WHERE key = '${key}'`;
    return this.storage.query(query).then((data: SQLResultSet) => {
      if (data.rows.length === 0 || !data.rows.item(0)) {
        return Promise.reject(MESSAGES[3] + key);
      }
      return data.rows.item(0);
    });
  }

  /**
   * @description Get item from cache with expire check and correct type assign
   * @param {string} key - Unique key
   * @return {Promise<any>} - data from cache
   */
  getItem(key: string): Promise<any> {
    if (!this.cacheEnabled) {
      return Promise.reject(MESSAGES[1]);
    }

    return this.getRawItem(key).then(data => {
      if (data.expire < new Date().getTime()) {
        if (this.invalidateOffline) {
          return Promise.reject(MESSAGES[2] + key);
        } else if (this.isOnline()) {
          return Promise.reject(MESSAGES[2] + key);
        }
      }

      return CacheService.decodeRawData(data);
    });
  }

  /**
   * @description Decode raw data from DB
   * @param {any} data - Data
   * @return {any} - decoded data
   */
  static decodeRawData(data: any): any {
    let dataJson = JSON.parse(data.value);
    if (CacheService.isRequest(dataJson)) {
      const requestOptions = new ResponseOptions({
        body: dataJson._body,
        status: dataJson.status,
        headers: dataJson.headers,
        statusText: dataJson.statusText,
        type: dataJson.type,
        url: dataJson.url
      });
      return new Response(requestOptions);
    } else {
      return dataJson;
    }
  }

  /**
   * @description Load item from cache if it's in cache or load from origin observable
   * @param {string} key - Unique key
   * @param {any} observable - Observable with data
   * @param {string} [groupKey] - group key
   * @param {number} [ttl] - TTL in seconds
   * @return {Observable<any>} - data from cache or origin observable
   */
  loadFromObservable(key: string, observable: any, groupKey?: string, ttl?: number): Observable<any> {
    if (!this.cacheEnabled) return observable;

    observable = observable.share();

    return Observable.fromPromise(this.getItem(key))
      .catch((e) => {
        observable.subscribe(res => this.saveItem(key, res, groupKey, ttl));
        return observable;
      });
  }

  /**
   * @description Load item from cache if it's in cache or load from origin observable
   * @param {string} key - Unique key
   * @param {any} observable - Observable with data
   * @param {string} [groupKey] - group key
   * @param {number} [ttl] - TTL in seconds
   * @param {string} [delayType='expired']
   * @return {Observable<any>} - data from cache or origin observable
   */
  loadFromDelayedObservable(key: string, observable: any, groupKey?: string, ttl: number = this.ttl, delayType: string = 'expired'): Observable<any> {
    if (!this.cacheEnabled) return observable;

    const observableSubject = new Subject();
    observable = observable.share();

    const subscribeOrigin = () => {
      observable.subscribe(res => {
        this.saveItem(key, res, groupKey, ttl);
        observableSubject.next(res);
      }, null, () => {
        observableSubject.complete();
      });
    };

    this.getItem(key)
      .then((data) => {
        observableSubject.next(data);
        if (delayType === 'all') {
          subscribeOrigin();
        }
      })
      .catch((e) => {
        this.getRawItem(key)
          .then(res => {
            observableSubject.next(CacheService.decodeRawData(res));
            subscribeOrigin();
          })
          .catch(() => subscribeOrigin());
      });

    return observableSubject.asObservable();
  }

  /**
   * Perform complete cache clear
   * @return {Promise<any>}
   */
  clearAll(): Promise<any> {
    if (!this.cacheEnabled) {
      return Promise.reject(MESSAGES[2]);
    }

    return this.resetDatabase();
  }

  /**
   * @description Remove all expired items from cache
   * @param {boolean} ignoreOnlineStatus -
   * @return {Promise<any>} - query promise
   */
  clearExpired(ignoreOnlineStatus = false): Promise<any> {
    if (!this.cacheEnabled) {
      return Promise.reject(MESSAGES[2]);
    }

    if (!this.isOnline() && !ignoreOnlineStatus) {
      return Promise.reject(MESSAGES[4]);
    }

    let datetime = new Date().getTime();
    return this.storage.query(`DELETE FROM ${this.tableName} WHERE expire < ${datetime}`);
  }

  /**
   * @description Remove all item with specified group
   * @param {string} groupKey - group key
   * @return {Promise<any>} - query promise
   */
  clearGroup(groupKey: string): Promise<any> {
    if (!this.cacheEnabled) {
      return Promise.reject(MESSAGES[2]);
    }

    return this.storage.query(`DELETE FROM ${this.tableName} WHERE groupKey = '${groupKey}'`);
  }

  /**
   * @description Check if it's an request
   * @param {any} data - Variable to test
   * @return {boolean} - data from cache
   */
  static isRequest(data: any): boolean {
    return (
      data && (
        data instanceof Request ||
        (
          typeof data === 'object' && data.hasOwnProperty('_body') && data.hasOwnProperty('status') &&
          data.hasOwnProperty('statusText') &&
          data.hasOwnProperty('type') &&
          data.hasOwnProperty('headers') &&
          data.hasOwnProperty('url')
        )
      )
    );
  }
}
