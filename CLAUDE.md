# このリポジトリについて

## 発注者

**株式会社千田工務店**（せんだこうむてん）

- 表記は必ず「千田」。**「仙田」「仙台」は誤り**。
- 略記する場合は `㈱千田工務店`（`index.html` の黒板表示で使用している形）。
- メールアドレスのドメインが `senda-koumuten.co.jp` のため「仙田」と誤変換しやすい。
  社名を書く場面では必ずこのファイルを確認すること。

## 中身

| 場所 | 内容 |
| --- | --- |
| `index.html` | 工事黒板カメラ。単一 HTML で完結するスマホ向けアプリ |
| `line-calendar-bot/` | LINE の投稿から予定を読み取り Google カレンダーへ登録する Bot（Google Apps Script） |

## 作業上の約束

- 社名・拠点名・担当者名などの固有名詞は**推測で書かない**。
  資料に無ければ、一般的な言い方（「本社」「現場事務所」など）にするか、確認する。
- `line-calendar-bot/` を直したら、テストを通してから 1 ファイル版を作り直す。

  ```bash
  cd line-calendar-bot
  node test/run.js                   # 日本語の日付・時刻の解析
  node test/integration.js           # Webhook 受信〜登録〜返信の通し確認
  node tools/build-single.js         # dist/Code.gs を再生成
  BUNDLE=1 node test/integration.js  # 結合版が src と同じ動きか確認
  ```
