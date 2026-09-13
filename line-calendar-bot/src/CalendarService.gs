/**
 * CalendarService.gs
 * Google カレンダーへの登録・照会・取り消しを行う。
 */

function resolveCalendar_(calendarId) {
  var cal = (!calendarId || calendarId === 'primary')
    ? CalendarApp.getDefaultCalendar()
    : CalendarApp.getCalendarById(calendarId);
  if (!cal) throw new Error('カレンダーが見つかりません: ' + calendarId);
  return cal;
}

/** LINE のトーク（個人／グループ）ごとに登録先カレンダーを切り替える。 */
function calendarIdForSource_(cfg, sourceId) {
  if (sourceId && cfg.sourceCalendarMap[sourceId]) return cfg.sourceCalendarMap[sourceId];
  return cfg.calendarId;
}

/**
 * 解析済みの予定をカレンダーに登録する。
 * @return {{id: string, calendarId: string}}
 */
function createEventFromSchedule_(calendarId, schedule, note) {
  var cal = resolveCalendar_(calendarId);
  var event;
  if (schedule.allDay) {
    var days = Math.round((schedule.end - schedule.start) / 86400000);
    event = (days <= 1)
      ? cal.createAllDayEvent(schedule.title, schedule.start)
      // createAllDayEvent の終了日は排他的（9/15-9/17 なら 9/18 を渡す）
      : cal.createAllDayEvent(schedule.title, schedule.start, schedule.end);
  } else {
    event = cal.createEvent(schedule.title, schedule.start, schedule.end);
  }
  if (schedule.location) event.setLocation(schedule.location);
  event.setDescription(buildDescription_(schedule, note));
  return { id: event.getId(), calendarId: cal.getId() };
}

function buildDescription_(schedule, note) {
  var lines = ['LINE から自動登録しました。'];
  if (note) lines.push(note);
  if (schedule.source) lines.push('', '--- 元のメッセージ ---', schedule.source);
  return lines.join('\n');
}

/** 指定期間の予定を取得する。 */
function listUpcomingEvents_(calendarId, from, to) {
  return resolveCalendar_(calendarId).getEvents(from, to);
}

/** 登録済みの予定を削除する。存在しない場合は false。 */
function deleteEventById_(calendarId, eventId) {
  var cal = resolveCalendar_(calendarId);
  var event = cal.getEventById(eventId);
  if (!event) return false;
  event.deleteEvent();
  return true;
}

/* ------------------------------------------------------------------ *
 * 「取消」用の直前登録の記録
 * ------------------------------------------------------------------ */

function rememberLastEvents_(sourceId, calendarId, eventIds) {
  if (!sourceId || !eventIds.length) return;
  var props = getProps_();
  var map = parseJsonProperty_(props.getProperty(PROP.LAST_EVENTS));
  map[sourceId] = { calendarId: calendarId, eventIds: eventIds, at: new Date().toISOString() };
  props.setProperty(PROP.LAST_EVENTS, JSON.stringify(trimLastEvents_(map)));
}

function takeLastEvents_(sourceId) {
  var props = getProps_();
  var map = parseJsonProperty_(props.getProperty(PROP.LAST_EVENTS));
  var entry = map[sourceId];
  if (!entry) return null;
  delete map[sourceId];
  props.setProperty(PROP.LAST_EVENTS, JSON.stringify(map));
  return entry;
}

/** スクリプトプロパティが肥大化しないよう、新しい順に 50 トークまでに保つ。 */
function trimLastEvents_(map) {
  var keys = Object.keys(map);
  if (keys.length <= 50) return map;
  keys.sort(function (a, b) { return String(map[b].at).localeCompare(String(map[a].at)); });
  var trimmed = {};
  keys.slice(0, 50).forEach(function (k) { trimmed[k] = map[k]; });
  return trimmed;
}

/* ------------------------------------------------------------------ *
 * 確認待ちの予定（ボタンを押すまで登録しない）
 * ------------------------------------------------------------------ */

var PENDING_TTL_SECONDS = 21600; // CacheService の上限（6時間）

/**
 * 解析済みの予定を一時保存し、postback に載せる短いキーを返す。
 * postback の data は 300 バイトまでなので、本体はキャッシュに置いてキーだけ渡す。
 */
function storePendingSchedules_(sourceId, schedules) {
  var key = 'pending_' + Utilities.getUuid().replace(/-/g, '').substring(0, 20);
  var payload = {
    sourceId: sourceId,
    schedules: schedules.map(function (s) {
      return {
        title: s.title, start: s.start.toISOString(), end: s.end.toISOString(),
        allDay: s.allDay, location: s.location, source: s.source
      };
    })
  };
  CacheService.getScriptCache().put(key, JSON.stringify(payload), PENDING_TTL_SECONDS);
  return key;
}

/** 一時保存した予定を取り出して消す（二重登録を防ぐため取り出しは 1 回だけ）。 */
function takePendingSchedules_(key) {
  if (!key) return null;
  var cache = CacheService.getScriptCache();
  var raw = cache.get(key);
  if (!raw) return null;
  cache.remove(key);
  var data = JSON.parse(raw);
  data.schedules = data.schedules.map(function (s) {
    return {
      title: s.title, start: new Date(s.start), end: new Date(s.end),
      allDay: s.allDay, location: s.location, source: s.source
    };
  });
  return data;
}
