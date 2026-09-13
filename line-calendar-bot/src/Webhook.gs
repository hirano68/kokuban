/**
 * Webhook.gs
 * LINE Messaging API の Webhook 受け口。
 *
 * 【署名検証について】
 * LINE は X-Line-Signature ヘッダで署名を送るが、Apps Script のウェブアプリは
 * doPost(e) にリクエストヘッダを渡さないため、GAS 単体では署名検証ができない。
 * 代わりに Webhook URL のクエリに合言葉（WEBHOOK_TOKEN）を付け、それを検証する。
 *   例）https://script.google.com/macros/s/xxxxx/exec?token=<WEBHOOK_TOKEN>
 * URL 自体が秘密になるので、公開リポジトリや外部には貼らないこと。
 */

function doPost(e) {
  try {
    var cfg = getConfig_();

    if (!cfg.webhookToken) {
      console.error(PROP.WEBHOOK_TOKEN + ' が未設定のため受信を拒否しました。');
      return jsonOutput_({ ok: false });
    }
    if (!e || !e.parameter || e.parameter.token !== cfg.webhookToken) {
      console.warn('合言葉が一致しないリクエストを破棄しました。');
      return jsonOutput_({ ok: false });
    }
    if (!e.postData || !e.postData.contents) {
      return jsonOutput_({ ok: true }); // Webhook 検証など本文なしのリクエスト
    }

    var body = JSON.parse(e.postData.contents);
    var events = body.events || [];
    for (var i = 0; i < events.length; i++) {
      try {
        handleWebhookEvent_(cfg, events[i]);
      } catch (err) {
        console.error('イベント処理でエラー: ' + (err && err.stack ? err.stack : err));
      }
    }
  } catch (err) {
    // LINE の再送を招かないよう、失敗してもログだけ残して 200 を返す
    console.error('Webhook 処理でエラー: ' + (err && err.stack ? err.stack : err));
  }
  return jsonOutput_({ ok: true });
}

/** 動作確認用。ブラウザで開くと状態だけ返す。 */
function doGet() {
  return jsonOutput_({ ok: true, service: 'line-calendar-bot' });
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ *
 * イベント処理
 * ------------------------------------------------------------------ */

function handleWebhookEvent_(cfg, event) {
  if (isDuplicateEvent_(event)) {
    console.log('再送イベントを無視しました: ' + event.webhookEventId);
    return;
  }

  var ctx = sourceContext_(event);

  if (event.type === 'join' || event.type === 'follow') {
    lineReply_(cfg.accessToken, event.replyToken, [helpText_(cfg, ctx)]);
    return;
  }
  if (event.type !== 'message' || !event.message || event.message.type !== 'text') {
    return; // スタンプ・画像などは対象外
  }
  if (!isAllowedSource_(cfg, ctx)) {
    console.warn('許可されていないトークからの受信: ' + ctx.sourceId);
    lineReply_(cfg.accessToken, event.replyToken,
      ['このトークからの登録は許可されていません。\n管理者に次の ID を伝えてください。\n' + ctx.sourceId]);
    return;
  }

  var replies = handleTextMessage_(cfg, ctx, event.message.text);
  if (replies.length) lineReply_(cfg.accessToken, event.replyToken, replies);
}

function sourceContext_(event) {
  var src = (event && event.source) || {};
  return {
    sourceId: src.groupId || src.roomId || src.userId || '',
    userId: src.userId || '',
    isGroup: !!(src.groupId || src.roomId)
  };
}

function isAllowedSource_(cfg, ctx) {
  if (!cfg.allowedSourceIds.length) return true;
  if (cfg.allowedSourceIds.indexOf(ctx.sourceId) >= 0) return true;
  // グループ内の個人 ID で許可されている場合も通す
  return !!ctx.userId && cfg.allowedSourceIds.indexOf(ctx.userId) >= 0;
}

/**
 * LINE は配信に失敗すると同じイベントを再送する。二重登録を防ぐため
 * webhookEventId を 6 時間キャッシュして重複を弾く。
 */
function isDuplicateEvent_(event) {
  var id = event && event.webhookEventId;
  if (!id) return false;
  var cache = CacheService.getScriptCache();
  var key = 'line_evt_' + id;
  if (cache.get(key)) return true;
  cache.put(key, '1', 21600); // CacheService の上限は 6 時間
  return false;
}
