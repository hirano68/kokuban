/**
 * Config.gs — 設定。
 *
 * ここを直接書き換えても良いし、スクリプトプロパティ `CONFIG_OVERRIDES` に
 * JSON を入れて上書きすることもできる（コードを触らずに運用で調整したい場合）。
 * 例: {"calendarId":"genba@example.com","requireKeyword":false,"dryRun":true}
 */
var CONFIG_BASE = {
  // ---- 登録先カレンダー -----------------------------------------------------
  /** 'primary' = 実行ユーザーの自分のカレンダー。共有カレンダーの ID も指定可。 */
  calendarId: 'primary',
  timeZone: 'Asia/Tokyo',
  /** 予定のタイトルにつける接頭辞。空文字なら付けない。例: '[Chat] ' */
  eventTitlePrefix: '',
  /** 予定の説明欄に元メッセージと投稿者・リンクを残す */
  addSourceToDescription: true,
  /** 分単位のポップアップ通知。null なら既定のまま */
  reminderMinutes: null,
  /** 予定の色（1〜11、Google Calendar の colorId）。null なら既定色 */
  colorId: null,

  // ---- 取得対象の Google Chat スペース ---------------------------------------
  /**
   * 監視するスペース名の配列。空配列なら「自分が参加している全スペース」。
   * 例: ['spaces/AAAA1111', 'spaces/BBBB2222']
   */
  spaces: [],
  /** 除外するスペース名 */
  excludeSpaces: [],
  /** ダイレクトメッセージも対象にするか */
  includeDirectMessages: false,

  // ---- ポーリング -----------------------------------------------------------
  /** 時間主導トリガーの間隔（分）。1, 5, 10, 15, 30, 60 のいずれか */
  pollIntervalMinutes: 15,
  /** 初回実行時、何分前まで遡って読むか */
  initialLookbackMinutes: 24 * 60,
  /** 1 回の実行で 1 スペースあたり読むメッセージ数の上限 */
  maxMessagesPerSpace: 200,
  /** この表示名の投稿は無視する。例: ['通知Bot', '田中 太郎'] */
  ignoreSenders: [],

  // ---- 予定とみなす条件 -----------------------------------------------------
  /** true: キーワード（下記 keywords）を含むメッセージだけを対象にする */
  requireKeyword: true,
  /** Parser.DEFAULTS.keywords を置き換えたい場合に指定（null なら既定リスト） */
  keywords: null,
  /** 追加キーワード（既定リストに足す） */
  extraKeywords: [],
  /** この語を含む行は無視する */
  ignoreKeywords: null,
  defaultDurationMinutes: 60,
  allDayWhenNoTime: true,
  pmAssumeFrom: 1,
  pmAssumeTo: 5,
  maxEventsPerMessage: 5,
  skipPastMinutes: 120,
  defaultTitle: '打合せ',
  /** 「毎週月曜」などの繰り返し予定を作る。false なら初回の 1 件だけ登録する */
  allowRecurring: true,
  /** 繰り返しを何回分作るか */
  recurrenceCounts: { DAILY: 60, WEEKLY: 26, MONTHLY: 12, YEARLY: 5 },
  /** 同じ時間帯に同名の予定があれば登録しない（別メッセージで同じ予定が流れたとき用） */
  skipIfSimilarEventExists: true,

  // ---- 動作モード -----------------------------------------------------------
  /** true の場合はカレンダーに書き込まず、ログ出力だけ行う */
  dryRun: false,
  /** 予定を登録したら Chat のスレッドに返信して知らせる（ポーリング時） */
  notifyInChat: false,
  /** 登録結果をこのアドレスにメールで通知する。null なら通知しない */
  notifyEmail: null
};

/** スクリプトプロパティの上書きを反映した設定を返す。 */
function getConfig() {
  var cfg = {};
  var k;
  for (k in CONFIG_BASE) if (Object.prototype.hasOwnProperty.call(CONFIG_BASE, k)) cfg[k] = CONFIG_BASE[k];

  var raw = null;
  try {
    raw = PropertiesService.getScriptProperties().getProperty('CONFIG_OVERRIDES');
  } catch (err) {
    raw = null;
  }
  if (raw) {
    var override;
    try {
      override = JSON.parse(raw);
    } catch (err2) {
      throw new Error('スクリプトプロパティ CONFIG_OVERRIDES の JSON が壊れています: ' + err2);
    }
    for (k in override) if (Object.prototype.hasOwnProperty.call(override, k)) cfg[k] = override[k];
  }

  // Parser に渡すキーワード設定を組み立てる
  var keywords = cfg.keywords || Parser.DEFAULTS.keywords;
  if (cfg.extraKeywords && cfg.extraKeywords.length) {
    keywords = keywords.concat(cfg.extraKeywords);
  }
  cfg.keywords = keywords;
  if (!cfg.ignoreKeywords) cfg.ignoreKeywords = Parser.DEFAULTS.ignoreKeywords;
  return cfg;
}
