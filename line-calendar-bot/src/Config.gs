/**
 * Config.gs
 * スクリプトプロパティから設定を読み出す。
 * 値はすべて「プロジェクトの設定 > スクリプト プロパティ」で登録する（コードに直接書かない）。
 */

var PROP = {
  ACCESS_TOKEN: 'LINE_CHANNEL_ACCESS_TOKEN', // 必須: Messaging API のチャネルアクセストークン
  WEBHOOK_TOKEN: 'WEBHOOK_TOKEN',            // 必須: Webhook URL に付ける合言葉
  CALENDAR_ID: 'CALENDAR_ID',                // 既定の登録先カレンダー（省略時は primary）
  SOURCE_CALENDAR_MAP: 'SOURCE_CALENDAR_MAP',// {"<LINEのID>":"<カレンダーID>"} の JSON
  ALLOWED_SOURCE_IDS: 'ALLOWED_SOURCE_IDS',  // 許可する LINE の ID（カンマ区切り、空なら全許可）
  GROUP_TRIGGER: 'GROUP_TRIGGER',            // 付けると確認なしで即登録するキーワード（既定: 予定）
  CONFIRM_BEFORE_CREATE: 'CONFIRM_BEFORE_CREATE', // group（既定） / always / never
  GROUP_MIN_CONFIDENCE: 'GROUP_MIN_CONFIDENCE',   // グループで拾い始める確からしさ high（既定）/ medium / low
  DEFAULT_DURATION: 'DEFAULT_DURATION_MINUTES',
  LAST_EVENTS: 'LAST_EVENTS'                 // 「取消」用に直前の登録内容を保持する内部キー
};

function getProps_() {
  return PropertiesService.getScriptProperties();
}

function getConfig_() {
  var p = getProps_();
  var duration = parseInt(p.getProperty(PROP.DEFAULT_DURATION), 10);
  return {
    accessToken: p.getProperty(PROP.ACCESS_TOKEN) || '',
    webhookToken: p.getProperty(PROP.WEBHOOK_TOKEN) || '',
    calendarId: p.getProperty(PROP.CALENDAR_ID) || 'primary',
    sourceCalendarMap: parseJsonProperty_(p.getProperty(PROP.SOURCE_CALENDAR_MAP)),
    allowedSourceIds: (p.getProperty(PROP.ALLOWED_SOURCE_IDS) || '')
      .split(',').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; }),
    groupTrigger: p.getProperty(PROP.GROUP_TRIGGER) || '予定',
    confirmBeforeCreate: p.getProperty(PROP.CONFIRM_BEFORE_CREATE) || 'group',
    groupMinConfidence: p.getProperty(PROP.GROUP_MIN_CONFIDENCE) || 'high',
    defaultDurationMinutes: isNaN(duration) ? PARSER_CONFIG.defaultDurationMinutes : duration,
    timeZone: Session.getScriptTimeZone() || 'Asia/Tokyo'
  };
}

function parseJsonProperty_(value) {
  if (!value) return {};
  try {
    var parsed = JSON.parse(value);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (err) {
    console.warn('スクリプトプロパティの JSON を解釈できませんでした: ' + err);
    return {};
  }
}

/**
 * LINE Developers に貼り付ける Webhook URL を組み立てて返す。
 * GAS エディタから実行すると、ウェブアプリの URL に合言葉を付けたものがログに出る。
 */
function showWebhookUrl() {
  var cfg = getConfig_();
  if (!cfg.webhookToken) {
    var missing = PROP.WEBHOOK_TOKEN + ' が未設定です。先にスクリプトプロパティを登録してください。';
    console.log(missing);
    return missing;
  }
  var base = ScriptApp.getService().getUrl();
  if (!base) {
    var notDeployed = 'まだウェブアプリとしてデプロイされていません。'
      + '「デプロイ > 新しいデプロイ > ウェブアプリ」を先に行ってください。';
    console.log(notDeployed);
    return notDeployed;
  }
  // getUrl() は開発用の /dev を返すことがあるが、LINE に登録するのは公開版の /exec
  var exec = base.replace(/\/dev$/, '/exec');
  var query = '?token=' + encodeURIComponent(cfg.webhookToken);
  var url = exec + query;

  // Google Workspace のアカウントでは /a/<ドメイン>/ 付きの URL が返る。
  // この形は外部から匿名で呼ばれたときにログイン画面へ飛ばされることがあるため、
  // ドメインを外した形も併せて出し、届かない場合に試せるようにしておく。
  var plain = exec.replace(/^https:\/\/script\.google\.com\/a\/[^/]+\//,
    'https://script.google.com/') + query;

  var lines = ['LINE Developers の「Webhook URL」にこれを貼り付けてください:', url];
  if (plain !== url) {
    lines.push('', 'これで反応がないときは、こちら（ドメインなしの形）を試してください:', plain);
  }
  console.log(lines.join('\n'));
  return url;
}

/** 設定が揃っているか確認する。GAS エディタから直接実行して確認できる。 */
function checkConfiguration() {
  var cfg = getConfig_();
  var problems = [];
  if (!cfg.accessToken) problems.push(PROP.ACCESS_TOKEN + ' が未設定です。');
  if (!cfg.webhookToken) problems.push(PROP.WEBHOOK_TOKEN + ' が未設定です。');
  try {
    resolveCalendar_(cfg.calendarId);
  } catch (err) {
    problems.push('カレンダー "' + cfg.calendarId + '" を開けません: ' + err.message);
  }
  if (cfg.timeZone !== 'Asia/Tokyo') {
    problems.push('タイムゾーンが ' + cfg.timeZone + ' です。'
      + '「プロジェクトの設定」で「(GMT+09:00) 日本標準時」に変更してください。');
  }
  if (CONFIDENCE_RANK[cfg.groupMinConfidence] === undefined) {
    problems.push(PROP.GROUP_MIN_CONFIDENCE + ' は high / medium / low のいずれかにしてください'
      + '（現在: ' + cfg.groupMinConfidence + '）。');
  }
  if (['group', 'always', 'never'].indexOf(cfg.confirmBeforeCreate) < 0) {
    problems.push(PROP.CONFIRM_BEFORE_CREATE + ' は group / always / never のいずれかにしてください'
      + '（現在: ' + cfg.confirmBeforeCreate + '）。');
  }

  var message = problems.length
    ? '設定に問題があります:\n - ' + problems.join('\n - ')
    : [
      '設定は正常です。',
      '  タイムゾーン      : ' + cfg.timeZone,
      '  既定カレンダー    : ' + cfg.calendarId,
      '  確認を挟む範囲    : ' + cfg.confirmBeforeCreate,
      '  グループの閾値    : ' + cfg.groupMinConfidence,
      '  即登録キーワード  : ' + cfg.groupTrigger,
      '  許可リスト        : ' + (cfg.allowedSourceIds.length
        ? cfg.allowedSourceIds.join(', ') : '（未設定＝全許可）')
    ].join('\n');
  console.log(message);
  return message;
}
