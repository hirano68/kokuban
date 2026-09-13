/**
 * Store.gs — 実行状態の保存（スクリプトプロパティ）。
 *
 * - スペースごとの「どこまで読んだか」(createTime のカーソル)
 * - 処理済みメッセージ ID（二重登録の防止。カレンダー側の extendedProperties と二段構え）
 */
var Store = (function () {
  'use strict';

  var CURSOR_PREFIX = 'cursor:';
  var PROCESSED_KEY = 'processedMessages';
  var PROCESSED_MAX = 1500;
  var PROCESSED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  function props() { return PropertiesService.getScriptProperties(); }

  function getCursor(spaceName) {
    return props().getProperty(CURSOR_PREFIX + spaceName) || null;
  }

  function setCursor(spaceName, rfc3339) {
    if (!rfc3339) return;
    props().setProperty(CURSOR_PREFIX + spaceName, rfc3339);
  }

  function loadProcessed() {
    var raw = props().getProperty(PROCESSED_KEY);
    if (!raw) return {};
    try {
      return JSON.parse(raw) || {};
    } catch (err) {
      return {};
    }
  }

  function saveProcessed(map) {
    var keys = Object.keys(map);
    var now = Date.now();
    // 古いものを捨てる
    var kept = keys.filter(function (k) { return now - map[k] < PROCESSED_TTL_MS; });
    if (kept.length > PROCESSED_MAX) {
      kept.sort(function (a, b) { return map[b] - map[a]; });
      kept = kept.slice(0, PROCESSED_MAX);
    }
    var out = {};
    kept.forEach(function (k) { out[k] = map[k]; });
    props().setProperty(PROCESSED_KEY, JSON.stringify(out));
  }

  function isProcessed(messageName) {
    return Object.prototype.hasOwnProperty.call(loadProcessed(), messageName);
  }

  function markProcessed(messageNames) {
    if (!messageNames || !messageNames.length) return;
    var map = loadProcessed();
    var now = Date.now();
    messageNames.forEach(function (name) { map[name] = now; });
    saveProcessed(map);
  }

  /** 状態を全部消す（再取り込みしたいとき用） */
  function reset() {
    var all = props().getProperties();
    var toDelete = Object.keys(all).filter(function (k) {
      return k.indexOf(CURSOR_PREFIX) === 0 || k === PROCESSED_KEY;
    });
    toDelete.forEach(function (k) { props().deleteProperty(k); });
    return toDelete.length;
  }

  return {
    getCursor: getCursor,
    setCursor: setCursor,
    isProcessed: isProcessed,
    markProcessed: markProcessed,
    reset: reset
  };
})();
