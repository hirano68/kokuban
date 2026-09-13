/**
 * LineClient.gs
 * LINE Messaging API への送信をまとめる。
 */

var LINE_API = {
  REPLY: 'https://api.line.me/v2/bot/message/reply',
  PUSH: 'https://api.line.me/v2/bot/message/push'
};

/** 返信トークンを使って応答する（1 回のみ・約30秒間有効）。 */
function lineReply_(accessToken, replyToken, texts) {
  if (!replyToken || !texts || !texts.length) return;
  return linePost_(LINE_API.REPLY, accessToken, {
    replyToken: replyToken,
    messages: toTextMessages_(texts)
  });
}

/** 返信トークンが使えない場面（再送・エラー通知など）で使う。 */
function linePush_(accessToken, to, texts) {
  if (!to || !texts || !texts.length) return;
  return linePost_(LINE_API.PUSH, accessToken, {
    to: to,
    messages: toTextMessages_(texts)
  });
}

function toTextMessages_(texts) {
  var list = Array.isArray(texts) ? texts : [texts];
  return list.slice(0, 5).map(function (t) {
    var body = String(t);
    // テキストメッセージの上限は 5000 文字
    if (body.length > 4900) body = body.substring(0, 4900) + '…';
    return { type: 'text', text: body };
  });
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
