/**
 * Commands.gs
 * 受信テキストを「コマンド」か「予定登録」に振り分け、返信文を組み立てる。
 */

var MAX_EVENTS_PER_MESSAGE = 10;

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
 * @return {Array<string>} 返信するテキスト（空配列なら無反応）
 */
function handleTextMessage_(cfg, ctx, text) {
  var trimmed = String(text || '').trim();
  if (!trimmed) return [];

  // 短いコマンド語は、グループでもキーワードなしで受け付ける
  var command = matchCommand_(trimmed);
  if (command) return runCommand_(cfg, ctx, command);

  var body = trimmed;
  if (ctx.isGroup) {
    // グループでは、日常会話を拾わないよう先頭キーワードを必須にする
    var trigger = cfg.groupTrigger;
    if (trimmed.indexOf(trigger) !== 0) return [];
    body = trimmed.substring(trigger.length).replace(/^[\s:：、。]+/, '');
    var nested = matchCommand_(body);
    if (nested) return runCommand_(cfg, ctx, nested);
  }

  return registerSchedules_(cfg, ctx, body);
}

function runCommand_(cfg, ctx, command) {
  if (command === 'help') return [helpText_(cfg, ctx)];
  if (command === 'id') return ['このトークの ID です。\n' + ctx.sourceId +
    '\n\nスクリプトプロパティの ' + PROP.SOURCE_CALENDAR_MAP + ' や ' +
    PROP.ALLOWED_SOURCE_IDS + ' に貼り付けて使います。'];
  if (command === 'list') return [upcomingText_(cfg, ctx)];
  if (command === 'cancel') return [cancelText_(cfg, ctx)];
  return [];
}

/* ------------------------------------------------------------------ *
 * 予定登録
 * ------------------------------------------------------------------ */

function registerSchedules_(cfg, ctx, body) {
  var schedules = parseSchedules(body, new Date(), {
    defaultDurationMinutes: cfg.defaultDurationMinutes
  });

  if (!schedules.length) {
    return ['日付を読み取れませんでした。\n例）9/15 14:00 現場打合せ @仙台営業所\n\n「ヘルプ」で書き方を確認できます。'];
  }
  if (schedules.length > MAX_EVENTS_PER_MESSAGE) {
    return ['一度に登録できるのは ' + MAX_EVENTS_PER_MESSAGE + ' 件までです（' +
      schedules.length + ' 件ありました）。分けて送ってください。'];
  }

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
    return ['カレンダーに登録できませんでした。\n' + failed.join('\n')];
  }

  rememberLastEvents_(ctx.sourceId, calendarId, created);

  var head = created.length === 1 ? '✅ 登録しました' : '✅ ' + created.length + '件 登録しました';
  var text = head + '\n\n' + lines.join('\n\n');
  if (failed.length) text += '\n\n⚠️ 登録できなかったもの\n' + failed.join('\n');
  text += '\n\n違っていたら「取消」と送ってください。';
  text += '\n' + calendarDayUrl_(schedules[0].start, cfg.timeZone);
  return [text];
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

function helpText_(cfg, ctx) {
  var trigger = ctx.isGroup ? cfg.groupTrigger + ' ' : '';
  return [
    '📝 予定の登録のしかた',
    '',
    (ctx.isGroup
      ? 'このグループでは、先頭に「' + cfg.groupTrigger + '」を付けたメッセージだけを登録します。'
      : 'そのままメッセージを送ると登録します。'),
    '',
    '【例】',
    trigger + '9/15 14:00 現場打合せ @仙台営業所',
    trigger + '9月15日(火) 10時〜12時 配筋検査',
    trigger + '明日 8時 朝礼',
    trigger + '来週金曜 終日 社内研修',
    trigger + '9/15-9/17 出張',
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
  ].join('\n');
}
