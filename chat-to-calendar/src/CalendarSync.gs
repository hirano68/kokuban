/**
 * CalendarSync.gs — 抽出した予定を Google カレンダーに登録する。
 *
 * 拡張サービス「Calendar API」(識別子 Calendar) を使う。
 * 二重登録を防ぐため、作成した予定には extendedProperties.private.chatMessage として
 * 元メッセージの ID を埋め込み、登録前に同じ ID の予定が無いか検索する。
 */
var CalendarSync = (function () {
  'use strict';

  var SOURCE_TAG = 'chat-to-calendar';

  function requireCalendarService() {
    if (typeof Calendar === 'undefined' || !Calendar || !Calendar.Events) {
      throw new Error('拡張サービス「Calendar API」が有効になっていません。'
        + 'Apps Script エディタの「サービス」から Calendar API (v3) を追加してください。');
    }
  }

  function rfc3339(date, timeZone) {
    return Utilities.formatDate(date, timeZone, "yyyy-MM-dd'T'HH:mm:ssXXX");
  }

  /** すでに同じメッセージから作った予定があるか */
  function findExisting(cfg, messageName) {
    requireCalendarService();
    var res = Calendar.Events.list(cfg.calendarId, {
      privateExtendedProperty: 'chatMessage=' + messageName,
      maxResults: 5,
      showDeleted: false
    });
    return (res.items && res.items.length) ? res.items[0] : null;
  }

  function buildDescription(cfg, ctx) {
    if (!cfg.addSourceToDescription) return undefined;
    var lines = [];
    if (ctx.messageText) lines.push(ctx.messageText);
    lines.push('');
    lines.push('--- Google Chat から自動登録 ---');
    if (ctx.senderName) lines.push('投稿者: ' + ctx.senderName);
    if (ctx.spaceDisplayName) lines.push('スペース: ' + ctx.spaceDisplayName);
    if (ctx.permalink) lines.push('元メッセージ: ' + ctx.permalink);
    return lines.join('\n');
  }

  /**
   * 予定を 1 件登録する。すでに登録済みなら null を返す。
   * @param {Object} event Parser が返した予定
   * @param {Object} ctx   {messageName, messageText, senderName, spaceName, spaceDisplayName, permalink}
   * @param {Object} cfg   設定
   */
  function createEvent(event, ctx, cfg) {
    if (!cfg.dryRun) requireCalendarService();

    if (!cfg.dryRun && ctx.messageName) {
      var existing = findExisting(cfg, ctx.messageName);
      if (existing) {
        // 同じメッセージから複数の予定を作る場合があるので、件名と開始が一致するものだけ重複扱いにする
        var sameTitle = existing.summary === (cfg.eventTitlePrefix || '') + event.title;
        if (sameTitle) return null;
      }
    }

    var resource = {
      summary: (cfg.eventTitlePrefix || '') + event.title,
      description: buildDescription(cfg, ctx),
      extendedProperties: {
        private: {
          chatMessage: ctx.messageName || '',
          source: SOURCE_TAG
        }
      }
    };
    if (event.location) resource.location = event.location;
    if (cfg.colorId) resource.colorId = String(cfg.colorId);
    if (cfg.reminderMinutes !== null && cfg.reminderMinutes !== undefined) {
      resource.reminders = {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: cfg.reminderMinutes }]
      };
    }

    if (event.allDay) {
      resource.start = { date: event.startDate };
      resource.end = { date: event.endDateExclusive };
    } else {
      resource.start = { dateTime: rfc3339(event.start, cfg.timeZone), timeZone: cfg.timeZone };
      resource.end = { dateTime: rfc3339(event.end, cfg.timeZone), timeZone: cfg.timeZone };
    }

    if (cfg.dryRun) {
      Logger.log('[dryRun] 登録スキップ: ' + Parser.describe(event));
      return { htmlLink: null, summary: resource.summary, dryRun: true };
    }

    return Calendar.Events.insert(resource, cfg.calendarId);
  }

  /** chat-to-calendar が作った予定をまとめて消す（試行錯誤のあと片付け用）。 */
  function deleteCreatedEvents(cfg, fromDate, toDate) {
    requireCalendarService();
    var res = Calendar.Events.list(cfg.calendarId, {
      privateExtendedProperty: 'source=' + SOURCE_TAG,
      timeMin: rfc3339(fromDate, cfg.timeZone),
      timeMax: rfc3339(toDate, cfg.timeZone),
      maxResults: 250,
      showDeleted: false
    });
    var items = res.items || [];
    items.forEach(function (item) { Calendar.Events.remove(cfg.calendarId, item.id); });
    return items.length;
  }

  return {
    createEvent: createEvent,
    findExisting: findExisting,
    deleteCreatedEvents: deleteCreatedEvents,
    SOURCE_TAG: SOURCE_TAG
  };
})();
