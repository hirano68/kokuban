/**
 * ChatSource.gs — Google Chat からメッセージを読む / スペースに返信する。
 *
 * Apps Script の拡張サービス「Chat API」(識別子 Chat) が有効ならそれを使い、
 * 無効な場合は UrlFetchApp で REST API を直接叩く。どちらでも動くようにしてある。
 */
var ChatSource = (function () {
  'use strict';

  var BASE_URL = 'https://chat.googleapis.com/v1/';

  function advancedServiceAvailable() {
    return (typeof Chat !== 'undefined') && Chat && Chat.Spaces;
  }

  function restCall(path, params, method, payload) {
    var url = BASE_URL + path;
    var query = [];
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] === undefined || params[k] === null || params[k] === '') return;
        query.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      });
    }
    if (query.length) url += '?' + query.join('&');

    var options = {
      method: method || 'get',
      muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
    };
    if (payload) {
      options.contentType = 'application/json; charset=utf-8';
      options.payload = JSON.stringify(payload);
    }
    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    var body = res.getContentText();
    if (code >= 300) {
      throw new Error('Chat API エラー (' + code + '): ' + body);
    }
    return body ? JSON.parse(body) : {};
  }

  /** 自分が参加しているスペースの一覧。 */
  function listSpaces(cfg) {
    var spaces = [];
    var pageToken = null;
    var filter = cfg.includeDirectMessages ? '' : 'spaceType = "SPACE"';
    do {
      var params = { pageSize: 100 };
      if (pageToken) params.pageToken = pageToken;
      if (filter) params.filter = filter;
      var res;
      if (advancedServiceAvailable()) {
        res = Chat.Spaces.list(params);
      } else {
        res = restCall('spaces', params);
      }
      (res.spaces || []).forEach(function (s) { spaces.push(s); });
      pageToken = res.nextPageToken;
    } while (pageToken);
    return spaces;
  }

  /** 設定に従って監視対象のスペース名を決める。 */
  function resolveTargetSpaces(cfg) {
    var names;
    if (cfg.spaces && cfg.spaces.length) {
      names = cfg.spaces.slice();
    } else {
      names = listSpaces(cfg).map(function (s) { return s.name; });
    }
    if (cfg.excludeSpaces && cfg.excludeSpaces.length) {
      names = names.filter(function (n) { return cfg.excludeSpaces.indexOf(n) === -1; });
    }
    return names;
  }

  /**
   * 指定スペースの、cursor（RFC3339）より後のメッセージを古い順に返す。
   */
  function listMessagesSince(spaceName, cursorRfc3339, cfg) {
    var messages = [];
    var pageToken = null;
    var filter = cursorRfc3339 ? 'createTime > "' + cursorRfc3339 + '"' : '';
    do {
      var params = { pageSize: 100, orderBy: 'createTime asc', showDeleted: false };
      if (pageToken) params.pageToken = pageToken;
      if (filter) params.filter = filter;
      var res;
      if (advancedServiceAvailable()) {
        res = Chat.Spaces.Messages.list(spaceName, params);
      } else {
        res = restCall(spaceName + '/messages', params);
      }
      (res.messages || []).forEach(function (m) { messages.push(m); });
      pageToken = res.nextPageToken;
    } while (pageToken && messages.length < cfg.maxMessagesPerSpace);

    if (messages.length > cfg.maxMessagesPerSpace) {
      messages = messages.slice(0, cfg.maxMessagesPerSpace);
    }
    return messages;
  }

  /** スペース（スレッド）にメッセージを投稿する。 */
  function postMessage(spaceName, text, threadName) {
    var payload = { text: text };
    var params = {};
    if (threadName) {
      payload.thread = { name: threadName };
      params.messageReplyOption = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
    }
    if (advancedServiceAvailable()) {
      return Chat.Spaces.Messages.create(payload, spaceName, params);
    }
    return restCall(spaceName + '/messages', params, 'post', payload);
  }

  /** spaces/AAA/messages/BBB → Chat のメッセージへのリンク */
  function buildPermalink(messageName) {
    if (!messageName) return null;
    var m = /^spaces\/([^\/]+)\/messages\/(.+)$/.exec(messageName);
    if (!m) return null;
    return 'https://chat.google.com/room/' + m[1] + '/' + m[2];
  }

  /**
   * メッセージ本文。@メンション（Bot・人ともに）は取り除く。
   * 「@事務所」のような場所指定は annotations に含まれないので残る。
   */
  function messageText(message) {
    if (!message) return '';
    var text = message.text || message.argumentText || '';
    var annotations = message.annotations || [];
    for (var i = 0; i < annotations.length; i++) {
      var a = annotations[i];
      if (a.type !== 'USER_MENTION' || !a.userMention || !a.userMention.user) continue;
      var displayName = a.userMention.user.displayName;
      if (!displayName) continue;
      text = text.split('@' + displayName).join(' ');
    }
    if (!text.trim() && message.argumentText) text = message.argumentText;
    return text.trim();
  }

  return {
    listSpaces: listSpaces,
    resolveTargetSpaces: resolveTargetSpaces,
    listMessagesSince: listMessagesSince,
    postMessage: postMessage,
    buildPermalink: buildPermalink,
    messageText: messageText
  };
})();
