# 安裝「履歷契約工作台 · Resume Contract Studio」

這是 Edge／Chrome Manifest V3 擴充功能，不需要 Tampermonkey。它可在 LinkedIn 個人檔案頁執行，但只接受 MCP session plan 指定的個人檔案與可見表單操作；每次使用者由 Agent 提供自己的個人檔案網址。

## 安裝

1. 保持此 `linkedin-profile-audit-extension-2.1.1` 資料夾在固定位置；不要再复制成版本 ZIP。
2. 在 Edge 開啟 `edge://extensions/`。
3. 開啟「開發人員模式」。
4. 按「載入解壓縮」，選擇此內含 `manifest.json` 的固定資料夾。
5. 程式更新後只需在擴充功能卡片按「重新載入」，再重新整理 LinkedIn 個人檔案頁面。

右下角出現「履歷契約工作台」及「探索 → 契約 → 套用 → 驗證」即代表載入成功。v4.7 由 Agent 先以唯讀方式探索可見頁面與表單，再將當次使用者履歷的映射傳入外掛。欄位映射不唯一時外掛會停止；儲存按鈕找不到時會回報失敗而不建立假修改紀錄。不會自動登入或呼叫私有 API。

Codex Plugin 原始碼位於 `codex-plugin/linkedin-profile-resume-sync/`。安裝後，MCP Server 會在本機 `127.0.0.1:37841` 建立橋接。**須先完成配對**，LinkedIn 分頁上的擴充功能才會領取並執行命令：

1. 從 MCP Client 呼叫 `begin_bridge_pairing`，取得 120 秒有效的一次性代碼。
2. 按下瀏覽器工具列的「履歷契約工作台」擴充功能圖示，開啟 **Bridge 配對** 視窗。
3. 貼上代碼，按「配對 Bridge」，再從 MCP Client 呼叫 `bridge_status` 檢查 `paired: true`。
4. MCP Server 重啟、瀏覽器工作階段結束後，都需要重新配對。不要把配對代碼貼到公開討論串或 Repository。

若需限制為特定擴充功能，先將 `edge://extensions/` 顯示的 32 位 Extension ID 設為 MCP 環境變數 `LINKEDIN_RESUME_EXTENSION_ID` 再啟動 MCP 服務。這個設定並不取代 Token 認證。

## 權限與限制

- `storage` 用於將 Bridge Token 存入 `chrome.storage.session`（不注入 LinkedIn 頁面、不保存至檔案）。

- 擴充功能只接受 session plan 指定的 LinkedIn 個人檔案；任何跨個人檔案的連結、儲存、刪除或送出操作均會拒絕。
- `clipboardWrite` 只供使用者主動按下「複製」按鈕；`downloads` 只供使用者主動按下「匯出 Logger」。
- 只操作目前頁面上可見的 LinkedIn 表單；不刪除資料、不呼叫 LinkedIn 內部 API。
- 每次套用都把修改前後欄位及是否要求儲存寫入 `change_history`，並隨 Logger 匯出。
- 頁面掃描與修改紀錄只放在該個人檔案的瀏覽器本機儲存；應在完成後立即匯出 Logger。
- 此擴充功能不處理登入。若 LinkedIn 要求登入、驗證或 CAPTCHA，請由使用者接手。

## Playwright 驗證順序

安裝後先確認面板出現。更新由外掛與 MCP 橋接執行，不需要 Computer Use。必要時 Playwright 只用於讀取已發布頁面與建立驗證 snapshot，不用於填寫或提交表單。


## v4.13 唯讀驗收與逐項核准

登入自己的 LinkedIn、完成配對、設定 `set_resume_plan`（`operations: []`）後，使用 MCP 的 `read_only_smoke` 檢查連線與頁面資料是否可讀。此命令不會向 LinkedIn 寫入履歷。

真正修改時，核准清單預設為空；請在畫面逐項勾選，確認對應欄位後才執行套用。契約內容改變時，舊核准自動失效。
