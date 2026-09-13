# Google チャット → Google カレンダー 自動登録

Google Chat のメッセージから日時・件名・場所を読み取り、Google カレンダーに予定を自動登録する
Google Apps Script（GAS）です。

例えばスペースにこう書くだけで、

```
9/20 10:00~12:00 A様邸 定例打合せ
明日10時から現場打ち合わせ
来週火曜 13時半から 施主打合せ @事務所
10/1~10/3 出張
```

カレンダーに予定が入ります。予定の説明欄には元のメッセージ・投稿者・Chat へのリンクが残ります。

---

## 1. 動かし方は 2 通り（併用可）

| | ① 自動ポーリング | ② Bot にメンション |
|---|---|---|
| 動き | 15 分ごとにスペースの新着を読み、予定らしいものを自動登録 | `@予定登録 明日10時から打合せ` と書いたときだけ登録 |
| 手間 | 書いた本人は何もしなくてよい | 毎回メンションが必要 |
| 誤登録 | 起こりうる（キーワード条件で絞る） | ほぼ起きない |
| 登録先 | **実行した人自身**のカレンダー（`calendarId: 'primary'`） | **Bot を作った人**のカレンダー。全員で見るなら共有カレンダー ID を指定する |
| 準備 | Apps Script のみ | Apps Script + Google Chat API のアプリ構成 |

**まずは ①（自動ポーリング）を `dryRun` で試すのがおすすめです。** 何が拾われるかログで確認してから本番に切り替えられます。

---

## 2. セットアップ（① 自動ポーリング）

### 2-1. Apps Script プロジェクトを作る

1. <https://script.google.com/> で「新しいプロジェクト」を作成。
2. `src/` の中身をエディタに貼り付ける（ファイル名は拡張子なしで同じ名前にする）。
   - `Parser` / `Config` / `Store` / `ChatSource` / `CalendarSync` / `Main` / `Tests`
3. 「プロジェクトの設定」→「`appsscript.json` マニフェスト ファイルをエディタで表示する」にチェックを入れ、
   `src/appsscript.json` の内容で上書きする。

> clasp を使う場合は `src/` をそのまま `clasp push` できます（`.gs` と `appsscript.json` がそろっています）。

### 2-2. Google Cloud プロジェクトを紐付けて Chat API を有効化する

Chat API は Apps Script の既定プロジェクトでは使えないことがあるため、標準の Cloud プロジェクトを紐付けます。

1. <https://console.cloud.google.com/> でプロジェクトを 1 つ用意（既存のものでも可）し、**プロジェクト番号**を控える。
2. そのプロジェクトで **Google Chat API** と **Google Calendar API** を有効化する。
3. Apps Script の「プロジェクトの設定」→「Google Cloud Platform プロジェクト」→「プロジェクトを変更」に
   プロジェクト番号を入力する。
4. OAuth 同意画面を「内部」で構成しておく（社内利用の場合）。

### 2-3. サービスを追加する

エディタ左の「サービス」＋ から追加します（`appsscript.json` を貼っていれば自動で入ります）。

- Google Calendar API（識別子 `Calendar`, v3）
- Google Chat API（識別子 `Chat`, v1）

### 2-4. 対象スペースを確認する

1. 監視したいスペースに、**スクリプトを実行するアカウント自身が参加している**ことを確認する。
2. エディタで `listMySpaces` を実行 → 初回は権限の承認を求められるので許可する。
3. 実行ログにスペース名（`spaces/XXXX`）と表示名が出るので、必要ならメモする。

### 2-5. 設定する

`Config.gs` の `CONFIG_BASE` を編集します（よく触るものだけ抜粋）。

```js
calendarId: 'primary',              // 共有カレンダーに入れるならそのカレンダー ID
spaces: ['spaces/XXXX'],            // 空配列なら参加中の全スペース
requireKeyword: true,               // キーワードを含むメッセージだけ対象にする
pollIntervalMinutes: 15,
dryRun: true                        // ← まずは true で試運転
```

コードを触らずに設定したい場合は、「プロジェクトの設定」→「スクリプト プロパティ」に
`CONFIG_OVERRIDES` というキーで JSON を入れると上書きできます。

```json
{"calendarId":"genba@example.com","spaces":["spaces/XXXX"],"dryRun":true}
```

### 2-6. 試運転する

`previewOnly` を実行します。カレンダーには一切書き込まず、取り込み位置も進めずに、
「いま何が予定として拾われるか」だけがログに出ます。

```
スペース: 2 / 新着メッセージ: 37 / 登録: 3
  ✅ 2026-09-20 10:00-12:00 A様邸 定例打合せ [現場A / 山田]
  -- 予定として拾わなかったメッセージ: 34 件
```

意図しないものが拾われていたら `requireKeyword` や `keywords` / `ignoreKeywords`、`spaces` を調整します。

### 2-7. 本番稼働

1. `dryRun` を `false` に戻す。
2. `installTriggers` を 1 度実行する（`pollIntervalMinutes` ごとに `syncNow` が動くようになる）。
3. 止めたいときは `removeTriggers` を実行する。

---

## 3. セットアップ（② Bot にメンション）

①のセットアップに加えて、Google Chat のアプリとして構成します。

1. Apps Script で「デプロイ」→「新しいデプロイ」→ 種類に **Chat アプリ** を選んでデプロイし、
   **デプロイ ID（Head 展開 ID）** を控える。
2. Cloud Console の **Google Chat API →「構成」** で以下を設定する。
   - アプリ名（例: `予定登録`）、アバター URL、説明
   - 機能: 「1 対 1 のメッセージを受信する」「スペースとグループの会話に参加する」を有効化
   - 接続設定: **Apps Script プロジェクト** を選び、控えたデプロイ ID を貼る
   - 公開範囲: 社内ドメイン、または特定のユーザー／グループ
3. Chat のスペースで `+` →「アプリを追加」からアプリを追加する。
4. スペースで `@予定登録 明日10時から現場打合せ` と投稿すると、その場で予定が作られ、結果がスレッドに返ります。

> **注意**: Chat アプリのスクリプトは「アプリを作った人」の権限で動きます。
> 全員の予定を 1 か所にまとめたい場合は `calendarId` に**共有カレンダーの ID** を指定してください。
> 投稿者ごとのカレンダーに入れることはできません（①のポーリングを各自がセットアップすれば各自のカレンダーに入ります）。

---

## 4. 読み取れる書き方

| 種類 | 例 |
|---|---|
| 日付 | `9/20` `9月20日` `2026/9/20` `2026年9月20日` `20日` |
| 相対日付 | `今日` `本日` `明日` `あさって` `明後日` |
| 曜日 | `月曜` `来週火曜` `今週の金曜` `再来週水曜日` |
| 時刻 | `10:00` `10時` `10時半` `10時30分` `午前9時` `午後3時` `正午` |
| 時間帯 | `10:00~12:00` `10:00-12:00` `10時から12時まで` |
| 複数日 | `10/1~10/3`（終日の連続予定になる） |
| 終日 | `終日` `一日中`、または時刻を書かない場合 |
| 場所 | `@事務所` `場所:現場事務所` |

- **午前/午後が無い 1〜5 時は午後**として解釈します（`3時から会議` → 15:00）。現場の早朝開始を誤変換しないよう
  6 時以降はそのまま朝として扱います。`pmAssumeFrom` / `pmAssumeTo` で変更できます。
- 時刻を書かなかった場合は**終日予定**になります（`allDayWhenNoTime: false` で無効化）。
- 時刻だけの場合はメッセージ投稿日の予定になります。
- 1 通のメッセージから最大 `maxEventsPerMessage`（既定 5）件まで、**行ごと・文ごと**に予定を作ります。
- `中止` `キャンセル` `延期` `リスケ` `欠席` `見送り` を含むメッセージは登録しません（`ignoreKeywords`）。
- すでに終わった予定（既定では 2 時間以上前）は登録しません。

## 5. 二重登録の防止

- 作成した予定には `extendedProperties.private.chatMessage` として元メッセージ ID を埋め込み、
  登録前に同じ ID の予定が無いかカレンダーを検索します。
- あわせてスクリプトプロパティに処理済みメッセージ ID を保持します（30 日 / 最大 1500 件）。
- スペースごとに「どこまで読んだか」を `createTime` で記録しているため、再実行しても読み直しません。
- 最初から読み直したい場合は `resetState` を実行します。

## 6. 設定一覧（`Config.gs`）

| キー | 既定値 | 説明 |
|---|---|---|
| `calendarId` | `'primary'` | 登録先カレンダー。共有カレンダーの ID も可 |
| `timeZone` | `'Asia/Tokyo'` | タイムゾーン |
| `eventTitlePrefix` | `''` | 件名の接頭辞（例 `'[Chat] '`） |
| `addSourceToDescription` | `true` | 説明欄に元メッセージ・投稿者・リンクを残す |
| `reminderMinutes` | `null` | 予定の何分前に通知するか |
| `colorId` | `null` | 予定の色（1〜11） |
| `spaces` | `[]` | 監視するスペース。空なら参加中の全スペース |
| `excludeSpaces` | `[]` | 除外するスペース |
| `includeDirectMessages` | `false` | DM も対象にするか |
| `ignoreSenders` | `[]` | 無視する投稿者の表示名 |
| `pollIntervalMinutes` | `15` | ポーリング間隔（1/5/10/15/30/60） |
| `initialLookbackMinutes` | `1440` | 初回に遡る範囲 |
| `maxMessagesPerSpace` | `200` | 1 回の実行で読む上限 |
| `requireKeyword` | `true` | キーワードを含むメッセージだけ対象にする |
| `keywords` / `extraKeywords` | 既定リスト | 予定とみなすキーワード |
| `ignoreKeywords` | `中止` ほか | 含まれていたら登録しない語 |
| `defaultDurationMinutes` | `60` | 終了時刻が無いときの長さ |
| `allDayWhenNoTime` | `true` | 時刻が無いとき終日予定にする |
| `pmAssumeFrom` / `pmAssumeTo` | `1` / `5` | 午後とみなす時刻の範囲 |
| `maxEventsPerMessage` | `5` | 1 通から作る予定の上限 |
| `skipPastMinutes` | `120` | これより前に終わる予定は登録しない |
| `dryRun` | `false` | 書き込まずログだけ出す |
| `notifyInChat` | `false` | 登録したらスレッドに返信して知らせる |
| `notifyEmail` | `null` | 登録結果をメールで通知する宛先 |

## 7. テスト

パーサーは Apps Script の API を使っていないので、ローカルでテストできます。

```
node chat-to-calendar/test/run.js
```

Apps Script 上では `runParserTests` を実行するとログに結果が出ます。
読み取りルールを変えたときは、`src/Tests.gs` の `CASES` にケースを足してから直してください。

## 8. うまくいかないときは

| 症状 | 確認すること |
|---|---|
| `Chat API エラー (403)` | Cloud プロジェクトで Chat API が有効か／Apps Script に紐付いているか |
| `拡張サービス「Calendar API」が有効になっていません` | エディタの「サービス」で Calendar API (v3) を追加 |
| スペースが 1 つも出てこない | 実行アカウントがそのスペースに参加しているか。DM を見るなら `includeDirectMessages: true` |
| 予定が拾われない | `previewOnly` のログで理由を確認（`noKeyword` = キーワード無し、`noSchedule` = 日時が読めない、`ignoreKeyword` = 中止等を検出） |
| 余計な予定が入る | `requireKeyword: true` のまま `keywords` を絞る、`spaces` を限定する、`ignoreSenders` を使う |
| 入れた予定をまとめて消したい | `CalendarSync.deleteCreatedEvents(getConfig(), 開始日, 終了日)` |

## 9. 制限事項

- 繰り返し予定（`毎週月曜` など）は登録しません。
- 参加者の自動招待は行いません（説明欄に投稿者を残すだけです）。
- 添付ファイルやカード形式のメッセージ本文は読み取り対象外です。
- Chat アプリ（②）は、スペースではメンションされたメッセージだけを受け取ります。
