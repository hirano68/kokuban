/**
 * Commands.gs
 * 受信テキストを「コマンド」か「予定登録」に振り分け、返信メッセージを組み立てる。
 *
 * 投稿の拾い方は 3 通り:
 *   1. 先頭キーワード（既定「予定」）付き … 確認なしで即登録
 *   2. 個人トーク                        … 解析できれば即登録
 *   3. グループの通常の投稿              … 日時らしきものを見つけたら確認ボタンを出す
 */

var MAX_EVENTS_PER_MESSAGE = 10;
var CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

var COMMAND_WORDS = {
  help: ['ヘルプ', 'help', 'Help', 'HELP', '使い方', '?', '？'],
  list: ['一覧', '予定一覧', '直近', '今週の予定', 'list'],
  cancel: ['取消', '取り消し', 'とりけし', 'キャンセル', 'undo', '元に戻す'],
  id: ['ID', 'id', 'Id', 'アイディー', 'トークID']
};

function matchCommand_(text) {
  var t = String(text).trim();
  for (var name in COMMAND_WORDS) {
    if (COMMAND_WORDS[name].indexOf(t) >= 0) return name;
  }
  return null;
}

/**
 * テキストメッセージ 1 件を処理する。
 * @return {Array} 返信するメッセージ（空配列なら無反応）
 */
function handleTextMessage_(cfg, ctx, text) {
  var trimmed = String(text || '').trim();
  if (!trimmed) return [];

  var command = matchCommand_(trimmed);
  if (command) return runCommand_(cfg, ctx, command);

  // 先頭キーワード付きの投稿は登録する意図が明確なので、確認を挟まない
  var trigger = cfg.groupTrigger;
  var explicit = !!trigger && trimmed.indexOf(trigger) === 0;
  var body = trimmed;
  if (explicit) {
    body = trimmed.substring(trigger.length).replace(/^[\s:：、。]+/, '');
    var nested = matchCommand_(body);
    if (nested) return runCommand_(cfg, ctx, nested);
  }

  var schedules = parseSchedules(body, new Date(), {
    defaultDurationMinutes: cfg.defaultDurationMinutes
  });

  // 会話に割り込まないよう、案内を返すのはキーワード付きか個人トークのときだけにする
  var mayAnswerPlainly = explicit || !ctx.isGroup;

  if (!schedules.length) {
    return mayAnswerPlainly ? [textMessage_(hintText_())] : [];
  }
  if (schedules.length > MAX_EVENTS_PER_MESSAGE) {
    return mayAnswerPlainly ? [textMessage_(
      '一度に登録できるのは ' + MAX_EVENTS_PER_MESSAGE + ' 件までです（' +
      schedules.length + ' 件ありました）。分けて送ってください。')] : [];
  }
  if (!passesConfidenceGate_(cfg, ctx, explicit, schedules)) return [];

  if (needsConfirmation_(cfg, ctx, explicit)) {
    return [buildConfirmMessage_(cfg, ctx, schedules)];
  }
  return registerSchedules_(cfg, ctx, schedules);
}

/** 確認ボタンの応答（postback）を処理する。 */
function handlePostback_(cfg, ctx, data) {
  var params = parsePostbackData_(data);

  if (params.action === 'dismiss') {
    takePendingSchedules_(params.key);
    return [textMessage_('登録しませんでした。')];
  }
  if (params.action !== 'create') return [];

  var pending = takePendingSchedules_(params.key);
  if (!pending) {
    return [textMessage_('この確認は期限切れです（6時間）。お手数ですがもう一度投稿してください。')];
  }
  // 確認を出したトーク以外からの応答は受け付けない
  if (pending.sourceId !== ctx.sourceId) {
    console.warn('確認の応答元が一致しません: ' + ctx.sourceId);
    return [];
  }
  return registerSchedules_(cfg, ctx, pending.schedules);
}

function parsePostbackData_(data) {
  var out = {};
  String(data || '').split('&').forEach(function (pair) {
    var i = pair.indexOf('=');
    if (i < 0) return;
    out[decodeURIComponent(pair.substring(0, i))] = decodeURIComponent(pair.substring(i + 1));
  });
  return out;
}

function runCommand_(cfg, ctx, command) {
  if (command === 'help') return [textMessage_(helpText_(cfg, ctx))];
  if (command === 'id') return [textMessage_('このトークの ID です。\n' + ctx.sourceId +
    '\n\nスクリプトプロパティの ' + PROP.SOURCE_CALENDAR_MAP + ' や ' +
    PROP.ALLOWED_SOURCE_IDS + ' に貼り付けて使います。')];
  if (command === 'list') return [textMessage_(upcomingText_(cfg, ctx))];
  if (command === 'cancel') return [textMessage_(cancelText_(cfg, ctx))];
  return [];
}

/* ------------------------------------------------------------------ *
 * 拾うかどうかの判断
 * ------------------------------------------------------------------ */

/**
 * キーワードなしでグループの投稿を拾うときだけ、確からしさで足切りする。
 * 既定は high（明示的な日付＋時刻または終日）なので、
 * 「15日分の請求書」「10時には着きます」程度では反応しない。
 */
function passesConfidenceGate_(cfg, ctx, explicit, schedules) {
  if (explicit || !ctx.isGroup) return true;
  var need = CONFIDENCE_RANK[cfg.groupMinConfidence];
  if (need === undefined) need = CONFIDENCE_RANK.high;
  for (var i = 0; i < schedules.length; i++) {
    if ((CONFIDENCE_RANK[schedules[i].confidence] || 0) >= need) return true;
  }
  return false;
}

/** 登録前に確認を挟むか。既定はグループのみ。 */
function needsConfirmation_(cfg, ctx, explicit) {
  if (explicit) return false;
  if (cfg.confirmBeforeCreate === 'never') return false;
  if (cfg.confirmBeforeCreate === 'always') return true;
  return ctx.isGroup;
}

function buildConfirmMessage_(cfg, ctx, schedules) {
  var key = storePendingSchedules_(ctx.sourceId, schedules);
  var lines = schedules.slice(0, 3).map(function (s) { return formatSchedule_(s, cfg.timeZone); });
  if (schedules.length > 3) lines.push('…ほか ' + (schedules.length - 3) + ' 件');
  return confirmMessage_(
    '予定を登録しますか？',
    'この予定を登録しますか？\n\n' + lines.join('\n\n'),
    '登録', 'action=create&key=' + key,
    'やめる', 'action=dismiss&key=' + key
  );
}

/* ------------------------------------------------------------------ *
 * 予定登録
 * ------------------------------------------------------------------ */

function registerSchedules_(cfg, ctx, schedules) {
  var calendarId = calendarIdForSource_(cfg, ctx.sourceId);
  var created = [];
  var lines = [];
  var failed = [];

  for (var i = 0; i < schedules.length; i++) {
    try {
      var ref = createEventFromSchedule_(calendarId, schedules[i], '登録元: ' + ctx.sourceId);
      created.push(ref.id);
      lines.push(formatSchedule_(schedules[i], cfg.timeZone));
    } catch (err) {
      console.error('予定の登録に失敗: ' + err);
      failed.push(schedules[i].title + '（' + err.message + '）');
    }
  }

  if (!created.length) {
    return [textMessage_('カレンダーに登録できませんでした。\n' + failed.join('\n'))];
  }

  rememberLastEvents_(ctx.sourceId, calendarId, created);

  var head = created.length === 1 ? '✅ 登録しました' : '✅ ' + created.length + '件 登録しました';
  var text = head + '\n\n' + lines.join('\n\n');
  if (failed.length) text += '\n\n⚠️ 登録できなかったもの\n' + failed.join('\n');
  text += '\n\n違っていたら「取消」と送ってください。';
  text += '\n' + calendarDayUrl_(schedules[0].start, cfg.timeZone);
  return [textMessage_(text)];
}

/* ------------------------------------------------------------------ *
 * 一覧・取消
 * ------------------------------------------------------------------ */

function upcomingText_(cfg, ctx) {
  var calendarId = calendarIdForSource_(cfg, ctx.sourceId);
  var from = new Date();
  var to = new Date(from.getTime() + 7 * 86400000);
  var events = listUpcomingEvents_(calendarId, from, to);
  if (!events.length) return 'これから 7 日間の予定はありません。';

  var lines = events.slice(0, 20).map(function (ev) {
    return formatSchedule_({
      title: ev.getTitle(),
      start: ev.getStartTime(),
      end: ev.getEndTime(),
      allDay: ev.isAllDayEvent(),
      location: ev.getLocation()
    }, cfg.timeZone);
  });
  var text = '📅 これから 7 日間の予定（' + events.length + '件）\n\n' + lines.join('\n\n');
  if (events.length > 20) text += '\n\n…ほか ' + (events.length - 20) + ' 件';
  return text;
}

function cancelText_(cfg, ctx) {
  var entry = takeLastEvents_(ctx.sourceId);
  if (!entry) return '取り消せる登録がありません。（取り消せるのは直前に登録した分だけです）';

  var removed = 0;
  for (var i = 0; i < entry.eventIds.length; i++) {
    try {
      if (deleteEventById_(entry.calendarId, entry.eventIds[i])) removed++;
    } catch (err) {
      console.error('予定の削除に失敗: ' + err);
    }
  }
  if (!removed) return '対象の予定が見つかりませんでした。すでに削除されている可能性があります。';
  return '🗑 直前に登録した ' + removed + ' 件を取り消しました。';
}

/* ------------------------------------------------------------------ *
 * 表示用の整形
 * ------------------------------------------------------------------ */

function formatSchedule_(schedule, tz) {
  var lines = [];
  if (schedule.allDay) {
    // 終日予定の終了日は排他的なので、表示は 1 日戻す
    var lastDay = new Date(schedule.end.getTime() - 86400000);
    var span = formatDateJp_(schedule.start, tz);
    if (lastDay.getTime() > schedule.start.getTime()) {
      span += ' 〜 ' + formatDateJp_(lastDay, tz);
    }
    lines.push('🗓 ' + span + ' 終日');
  } else {
    var head = '🗓 ' + formatDateJp_(schedule.start, tz) + ' ' + formatTime_(schedule.start, tz);
    head += '-' + formatTime_(schedule.end, tz);
    if (!isSameDay_(schedule.start, schedule.end, tz)) {
      head += '（' + formatDateJp_(schedule.end, tz) + '）';
    }
    lines.push(head);
  }
  lines.push('　' + (schedule.title || '予定'));
  if (schedule.location) lines.push('　📍 ' + schedule.location);
  return lines.join('\n');
}

function formatDateJp_(date, tz) {
  var y = Number(Utilities.formatDate(date, tz, 'yyyy'));
  var m = Number(Utilities.formatDate(date, tz, 'M'));
  var d = Number(Utilities.formatDate(date, tz, 'd'));
  var w = WEEKDAY_LABEL[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return m + '/' + d + '(' + w + ')';
}

function formatTime_(date, tz) {
  return Utilities.formatDate(date, tz, 'HH:mm');
}

function isSameDay_(a, b, tz) {
  return Utilities.formatDate(a, tz, 'yyyyMMdd') === Utilities.formatDate(b, tz, 'yyyyMMdd');
}

function calendarDayUrl_(date, tz) {
  return 'https://calendar.google.com/calendar/r/day/' + Utilities.formatDate(date, tz, 'yyyy/M/d');
}

function hintText_() {
  return '日付を読み取れませんでした。\n例）9/15 14:00 現場打合せ @仙台営業所\n\n「ヘルプ」で書き方を確認できます。';
}

function helpText_(cfg, ctx) {
  var lines = ['📝 予定の登録のしかた', ''];
  if (ctx.isGroup) {
    lines.push(
      'このグループの投稿から日時を見つけたら、「登録しますか？」と確認します。',
      '「登録」を押したときだけカレンダーに入ります。',
      '確認なしですぐ登録したいときは、先頭に「' + cfg.groupTrigger + '」を付けてください。');
  } else {
    lines.push('そのままメッセージを送ると登録します。');
  }
  return lines.concat([
    '',
    '【例】',
    '9/15 14:00 現場打合せ @仙台営業所',
    '9月15日(火) 10時〜12時 配筋検査',
    '明日 8時 朝礼',
    '来週金曜 終日 社内研修',
    '9/15-9/17 出張',
    '',
    '【書き方】',
    '・日付… 9/15、9月15日、明日、来週火曜、20日',
    '・時刻… 14:00、14時、14時半、10時〜12時、午後3時',
    '・場所… @のあとに書く / 場所：〇〇',
    '・終了時刻がなければ ' + cfg.defaultDurationMinutes + ' 分、時刻がなければ終日で登録します',
    '・午前/午後の指定がない 1〜' + PARSER_CONFIG.pmShiftMaxHour + '時は午後として扱います',
    '',
    '【コマンド】',
    '・一覧 … これから 7 日間の予定',
    '・取消 … 直前の登録を取り消す',
    '・ID … このトークの ID を表示（設定用）'
  ]).join('\n');
}
