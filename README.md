# LLM Router 示範

左邊與 `auto` 模型對話，右邊即時呈現 SystemOne 路由大腦如何判斷問題，以及問題沿著哪條路線抵達地端或雲端模型。

## 啟動

```bash
cp .env.example .env   # 第一次使用時
# 編輯 .env，填入 LITELLM_API_KEY
npm start              # http://localhost:5180
```

不需要安裝任何套件（Node 18 以上）。金鑰只存在伺服器端，瀏覽器透過 `/api/*` 代理呼叫 LiteLLM。路線圖使用的 React 與 React Flow 已打包在 `public/vendor/`，執行時不需要 `npm install`，也不經過 CDN。

沒有金鑰時，聊天會提示設定金鑰，路由面板則以本機規則模擬 SystemOne 的回答，仍可完整展示。設定面板也能手動切換「使用模擬訊號」，適合離線展示。

## 運作方式

每送出一個問題會同時發出兩個請求：

1. `POST {LITELLM_BASE_URL}/systemone`，模型為 `BRAIN_MODEL`（預設 `Microsoft-Decision-1`），一次問 13 個路由訊號：難度、領域、語言、時效、敏感度、是否含個資、是否需要推理或即時資訊、錯誤代價、各層模型可否勝任等。

2. 聊天：介面上固定是 `auto`。`.env` 設定了 `LITELLM_CHAT_MODEL_LOW / MID / HIGH` 時，auto 會等 SystemOne 判斷完，依**送出當下選定的策略**挑一層，送往 `LITELLM_CHAT_BASE_URL` 的對應模型並串流回覆；沒設定三層時則直接用 `CHAT_MODEL`。

路線圖上的「地端小模型／地端大模型／雲端模型」三站就是 LOW／MID／HIGH 三個實際模型。其他專家站點（程式、推理、醫療、繁中等）只用於示意路由，實際由所屬層級回答，介面會標示「示意」：地端邊緣類交給 LOW，地端機房與專家類交給 MID，雲端類與多模型共識交給 HIGH。

推理模型會先串流思考過程，左側以可收合的「思考中」區塊即時顯示，開始回答後自動收合，並在回覆下方記錄思考時間。

右側的 12 種策略共用同一份訊號，各自決定去向並播放路線動畫：

| 分類 | 策略 |
| --- | --- |
| 能力分層 | 階層式 Cascade、強弱二分 RouteLLM、成本最佳化 |
| 內容理解 | 語意路由、語言路由、規則路由（不呼叫大腦） |
| 限制條件 | 隱私合規、延遲預算 SLA |
| 可靠與規模 | 多模型共識 Ensemble、容錯備援 Fallback、負載平衡 |
| 組合 | 綜合策略（決策樹） |

下方檢視器可查看決策軌跡、全部大腦訊號、12 種策略的比較表，以及送往 SystemOne 的原始 JSON。

SystemOne 不太能分辨繁體與簡體中文，所以文字中有明確的繁體或簡體字形時，會在本機修正語言判斷，並在決策軌跡與大腦訊號中標示「字形修正」。原始資料分頁顯示的仍是 SystemOne 的原始回應。

聊天請求會附上一段系統提示，要求以使用者的語言回答、中文一律用繁體與台灣用語。可在 `.env` 用 `CHAT_SYSTEM_PROMPT=` 改寫，留空則不送出。

## 介面（newUI 分支）

桌面版是三欄的調度台：左側欄放策略清單與 SystemOne 狀態，中間整面是路線圖與抵達牌，右側是對話。「路由細節」按鈕開合決策軌跡等四個分頁；寬度 1500px 以上時細節與對話並排，以下則疊在對話欄的位置。860px 以下維持「對話／路由」兩個分頁切換。

## 路線圖

路線圖以 [React Flow](https://reactflow.dev)（`@xyflow/react`）繪製：模型是有路線色條的站牌，抵達時整塊亮起；沿路線移動的紅點帶著問題開頭的文字。

- 桌面版可以拖曳平移、用滾輪或右上角的按鈕縮放，「回到完整路線圖」會還原檢視。重播同一個問題時保留目前的縮放位置，切換策略才會還原。
- 寬度 860px 以下時路線圖位於可捲動的頁面中，所以停用平移縮放，改成左右捲動，播放時畫面會跟著問題移動。
- 網址加上 `?map=classic` 會改用內建的 SVG 路線圖（`public/js/map.js`）；React Flow 模組無法載入時也會自動退回這個版本。兩者共用同一份路線資料與播放邏輯。

`public/vendor/flow-kit.js` 是 React、React DOM 與 React Flow 打包成的單一 ES module，只有升級版本時才需要重新產生：

```bash
cd tools/flow-kit
npm install
npm run build
```

## 自訂

- 路由目標的模型名稱、延遲、單價：`public/js/catalog.js`（單價與延遲為示意值）
- 送給 SystemOne 的訊號問題：`public/js/brain.js` 的 `SIGNALS`
- 各策略的路線圖與決策邏輯：`public/js/modes.js`
- 路線圖的站點、站牌與軌道元件：`public/js/flow.js`；外觀與色票：`public/css/app.css`
