/**
 * LineClient.gs
 * LINE Messaging API への送信をまとめる。
 */

var LINE_API = {
  REPLY: 'https://api.line.me/v2/bot/message/reply',
  PUSH: 'https://api.line.me/v2/bot/message/push'
};

/** 返信トークンを使って応答する（1 回のみ・約30秒間有効）。 */
function lineReply_(accessToken, replyToken, messages) {
  if (!replyToken || !messages || !messages.length) return;
  return linePost_(LINE_API.REPLY, accessToken, {
    replyToken: replyToken,
    messages: toMessages_(messages)
  });
}

/** 返信トークンが使えない場面（再送・エラー通知など）で使う。 */
function linePush_(accessToken, to, messages) {
  if (!to || !messages || !messages.length) return;
  return linePost_(LINE_API.PUSH, accessToken, {
    to: to,
    messages: toMessages_(messages)
  });
}

/** 文字列はテキストメッセージに、オブジェクトはそのまま送る。1 回の送信は 5 件まで。 */
function toMessages_(messages) {
  var list = Array.isArray(messages) ? messages : [messages];
  return list.slice(0, 5).map(function (m) {
    return (m && typeof m === 'object') ? m : textMessage_(m);
  });
}

function textMessage_(text) {
  var body = String(text);
  // テキストメッセージの上限は 5000 文字
  if (body.length > 4900) body = body.substring(0, 4900) + '…';
  return { type: 'text', text: body };
}

/**
 * 「登録 / やめる」の 2 択を出す確認メッセージ。
 * confirm テンプレートの text は 240 文字まで、postback の data は 300 バイトまで。
 */
function confirmMessage_(altText, text, yesLabel, yesData, noLabel, noData) {
  var body = String(text);
  if (body.length > 240) body = body.substring(0, 239) + '…';
  return {
    type: 'template',
    altText: String(altText).substring(0, 400),
    template: {
      type: 'confirm',
      text: body,
      actions: [
        { type: 'postback', label: yesLabel, data: yesData, displayText: yesLabel },
        { type: 'postback', label: noLabel, data: noData, displayText: noLabel }
      ]
    }
  };
}

function linePost_(url, accessToken, payload) {
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error('LINE API エラー ' + code + ': ' + res.getContentText());
  }
  return code;
}
