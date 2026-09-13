/**
 * Main.gs — エントリポイント。
 *
 * 使い方は 2 通り（両方同時に使える）:
 *
 *  1) 定期ポーリング（自動で拾う）
 *     installTriggers() を 1 度実行しておくと、pollIntervalMinutes ごとに syncNow() が動き、
 *     監視対象スペースの新着メッセージから予定を拾ってカレンダーに登録する。
 *
 *  2) Chat アプリ（Bot にメンションして登録）
 *     スペースで「@予定Bot 明日10時から現場打合せ」のようにメンションすると onMessage() が呼ばれ、
 *     その場で予定を作って結果をスレッドに返す。
 */

// ------------------------------------------------------------------ ポーリング

/** 監視対象スペースの新着メッセージを取り込む（時間主導トリガーから呼ばれる）。 */
function syncNow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('前回の実行が終わっていないためスキップしました。');
    return;
  }
  try {
    var cfg = getConfig();
    var report = pollSpaces_(cfg, false);
    Logger.log(formatReport_(report));
    if (cfg.notifyEmail && report.created.length) {
      MailApp.sendEmail(cfg.notifyEmail, 'Chat から予定を登録しました (' + report.created.length + '件)', formatReport_(report));
    }
    return report;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 登録はせずに、いま何が拾われるかだけログに出す。
 * 取り込み位置（カーソル）も進めないので、設定の試運転に使える。
 */
function previewOnly() {
  var cfg = getConfig();
  cfg.dryRun = true;
  var report = pollSpaces_(cfg, true);
  Logger.log(formatReport_(report));
  return report;
}

function pollSpaces_(cfg, preview) {
  var report = { created: [], skipped: [], errors: [], spaces: 0, messages: 0 };
  var spaceNames;
  try {
    spaceNames = ChatSource.resolveTargetSpaces(cfg);
  } catch (err) {
    report.errors.push('スペース一覧の取得に失敗: ' + err);
    return report;
  }

  var defaultCursor = rfc3339_(new Date(Date.now() - cfg.initialLookbackMinutes * 60 * 1000), cfg.timeZone);

  for (var i = 0; i < spaceNames.length; i++) {
    var spaceName = spaceNames[i];
    report.spaces++;
    try {
      var cursor = Store.getCursor(spaceName) || defaultCursor;
      var messages = ChatSource.listMessagesSince(spaceName, cursor, cfg);
      report.messages += messages.length;
      var processed = [];
      var latestCreateTime = null;

      for (var j = 0; j < messages.length; j++) {
        var message = messages[j];
        latestCreateTime = message.createTime || latestCreateTime;
        var outcome = handleMessage_(message, cfg, spaceName);
        if (outcome.created.length) {
          outcome.created.forEach(function (c) { report.created.push(c); });
          processed.push(message.name);
        } else if (outcome.skipped) {
          report.skipped.push(outcome.skipped);
        }
      }

      if (!preview) {
        if (processed.length) Store.markProcessed(processed);
        if (latestCreateTime) Store.setCursor(spaceName, latestCreateTime);
      }
    } catch (err) {
      report.errors.push(spaceName + ': ' + err);
    }
  }
  return report;
}

/** 1 メッセージを処理して、作成した予定の一覧を返す。 */
function handleMessage_(message, cfg, spaceName) {
  var result = { created: [], skipped: null };

  if (message.sender && message.sender.type === 'BOT') {
    return result;                                       // Bot の投稿は対象外
  }
  var senderName = (message.sender && message.sender.displayName) || '';
  if (cfg.ignoreSenders && cfg.ignoreSenders.indexOf(senderName) !== -1) {
    return result;
  }
  if (message.name && Store.isProcessed(message.name)) {
    return result;                                       // 取り込み済み
  }

  var text = ChatSource.messageText(message);
  if (!text) return result;

  var base = parseRfc3339_(message.createTime) || new Date();
  var parsed = Parser.parseMessage(text, base, cfg);
  if (!parsed.events.length) {
    result.skipped = truncate_(text, 40) + ' (' + parsed.skipped + ')';
    return result;
  }

  var ctx = {
    messageName: message.name,
    messageText: truncate_(text, 900),
    senderName: senderName,
    spaceName: spaceName || (message.space && message.space.name),
    spaceDisplayName: message.space && message.space.displayName,
    permalink: ChatSource.buildPermalink(message.name)
  };

  for (var i = 0; i < parsed.events.length; i++) {
    var event = parsed.events[i];
    try {
      var created = CalendarSync.createEvent(event, ctx, cfg);
      if (created) {
        result.created.push({
          summary: created.summary || event.title,
          when: Parser.describe(event),
          link: created.htmlLink || null,
          space: ctx.spaceDisplayName || ctx.spaceName,
          sender: senderName
        });
      }
    } catch (err) {
      throw new Error('カレンダー登録に失敗 (' + Parser.describe(event) + '): ' + err);
    }
  }

  if (result.created.length && cfg.notifyInChat && !cfg.dryRun) {
    try {
      var lines = result.created.map(function (c) { return '・' + c.when; });
      ChatSource.postMessage(ctx.spaceName,
        '📅 カレンダーに登録しました\n' + lines.join('\n'),
        message.thread && message.thread.name);
    } catch (err) {
      Logger.log('Chat への通知に失敗: ' + err);
    }
  }
  return result;
}

// ---------------------------------------------------------------- Chat アプリ

/** Chat アプリがメンションされたときに呼ばれる。 */
function onMessage(event) {
  var cfg = getConfig();
  cfg.requireKeyword = false;     // 直接呼ばれているのでキーワード判定は不要
  cfg.explicit = true;

  var message = event.message || {};
  var text = message.argumentText || message.text || '';
  var space = (event.space && event.space.name) || (message.space && message.space.name);

  if (!text.trim() || /^(help|ヘルプ|使い方)$/i.test(text.trim())) {
    return { text: helpText_() };
  }

  var base = parseRfc3339_(message.createTime) || new Date();
  var parsed = Parser.parseMessage(text, base, cfg);
  if (!parsed.events.length) {
    return { text: '予定として読み取れませんでした。\n例) @' + appName_() + ' 明日10時から現場打合せ\n' + helpText_() };
  }

  var ctx = {
    messageName: message.name,
    messageText: truncate_(text, 900),
    senderName: (message.sender && message.sender.displayName) || (event.user && event.user.displayName) || '',
    spaceName: space,
    spaceDisplayName: (event.space && event.space.displayName) || '',
    permalink: ChatSource.buildPermalink(message.name)
  };

  var lines = [];
  for (var i = 0; i < parsed.events.length; i++) {
    var ev = parsed.events[i];
    try {
      var created = CalendarSync.createEvent(ev, ctx, cfg);
      if (created) {
        lines.push('・' + Parser.describe(ev) + (created.htmlLink ? '\n  ' + created.htmlLink : ''));
      } else {
        lines.push('・' + Parser.describe(ev) + '（登録済み）');
      }
    } catch (err) {
      lines.push('・' + Parser.describe(ev) + ' → 登録に失敗しました: ' + err);
    }
  }
  if (message.name) Store.markProcessed([message.name]);
  return { text: '📅 カレンダーに登録しました\n' + lines.join('\n') };
}

function onAddedToSpace(event) {
  return { text: 'こんにちは。予定を書いてメンションしてください。\n' + helpText_() };
}

function onRemovedFromSpace(event) {
  Logger.log('スペースから削除されました: ' + (event.space && event.space.name));
}

function helpText_() {
  return [
    '【書き方の例】',
    '  9/20 10:00~12:00 A様邸 定例打合せ',
    '  明日10時から現場打ち合わせ',
    '  来週火曜 13時半から 施主打合せ @事務所',
    '  10/1~10/3 出張',
    '  2026年9月20日 終日 現場清掃'
  ].join('\n');
}

function appName_() {
  return '予定登録';
}

// -------------------------------------------------------------- トリガー管理

/** 定期ポーリングのトリガーを作る（初回に 1 度だけ実行する）。 */
function installTriggers() {
  var cfg = getConfig();
  removeTriggers();
  var minutes = cfg.pollIntervalMinutes;
  var builder = ScriptApp.newTrigger('syncNow').timeBased();
  if (minutes >= 60) {
    builder.everyHours(Math.max(1, Math.round(minutes / 60))).create();
  } else {
    var allowed = [1, 5, 10, 15, 30];
    if (allowed.indexOf(minutes) === -1) {
      throw new Error('pollIntervalMinutes は 1 / 5 / 10 / 15 / 30 / 60 のいずれかにしてください（現在: ' + minutes + '）');
    }
    builder.everyMinutes(minutes).create();
  }
  Logger.log(minutes + ' 分ごとに syncNow() を実行するトリガーを作成しました。');
}

/** ポーリングのトリガーを全部削除する。 */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'syncNow') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  if (removed) Logger.log(removed + ' 件のトリガーを削除しました。');
  return removed;
}

/** 取り込み位置と処理済み記録を消す（最初から読み直したいとき）。 */
function resetState() {
  var n = Store.reset();
  Logger.log(n + ' 件の状態を削除しました。次回実行は initialLookbackMinutes 分前から読み直します。');
}

/** 監視できるスペースの一覧をログに出す（spaces 設定を書くとき用）。 */
function listMySpaces() {
  var cfg = getConfig();
  var spaces = ChatSource.listSpaces(cfg);
  spaces.forEach(function (s) {
    Logger.log(s.name + '\t' + (s.displayName || '(DM)') + '\t' + (s.spaceType || s.type || ''));
  });
  Logger.log('合計 ' + spaces.length + ' スペース');
  return spaces;
}

// ---------------------------------------------------------------- ユーティリティ

function rfc3339_(date, timeZone) {
  return Utilities.formatDate(date, timeZone || 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function parseRfc3339_(value) {
  if (!value) return null;
  // "2026-09-13T01:02:03.456789Z" のように秒の小数が 3 桁を超えることがあるので丸める
  var normalized = String(value).replace(/\.(\d{3})\d+/, '.$1');
  var d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d;
}

function truncate_(text, max) {
  var s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.substring(0, max) + '…' : s;
}

function formatReport_(report) {
  var lines = [];
  lines.push('スペース: ' + report.spaces + ' / 新着メッセージ: ' + report.messages +
    ' / 登録: ' + report.created.length);
  report.created.forEach(function (c) {
    lines.push('  ✅ ' + c.when + ' [' + (c.space || '') + ' / ' + (c.sender || '') + ']');
  });
  if (report.skipped.length) {
    lines.push('  -- 予定として拾わなかったメッセージ: ' + report.skipped.length + ' 件');
    report.skipped.slice(0, 20).forEach(function (s) { lines.push('     ・' + s); });
  }
  report.errors.forEach(function (e) { lines.push('  ⚠️ ' + e); });
  return lines.join('\n');
}
