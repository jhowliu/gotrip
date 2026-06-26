# 旅遊規劃 Agent — 設計決策文件

> 本文件是原始設計草案經過一輪 grilling 後的**決策定稿**。
> 真正產出是 **agent 開發能力**;旅遊規劃只是載體。

---

## 核心設計原則

1. **模型想辦法,程式碼把關,資料來自真實 API。**
2. **硬約束用程式驗,不靠 prompt 拜託。**
3. **Tool 輸出乾淨結構化 JSON,用 `placeId` 串接。**
4. **能抽成可獨立測試的模組就抽出來,prompt 只留薄薄一層。**
5. **先在 mock 上把 agent 能力(含 Phase 3)練滿,真 API / DB / UI 是最後才接的外殼。**
6. **緩衝放在「天」這層,不逐項加;硬約束分流回報,軟約束只當警告(無評分)。**

---

## 1. 範圍與終點

- **終點線 = Phase 3(對話式修改)。**
- **整個 Phase 3 在純 mock 上先做完**——agent 的智慧不依賴資料真實,只依賴資料**形狀對**。
- 原 Phase 4(即時資料 / 時刻表)**砍掉**;要做只做「天氣 / 票務提醒」,且當遙遠可選延伸。

---

## 2. 系統架構(B:胖 agent + 瘦工具)

| 角色 | 誰做 |
|---|---|
| 規劃主體(決定哪些點、什麼順序、如何重排) | **LLM** |
| 跨天分群草稿、交通計算、花費加總 | 確定性程式 / API |
| 守門(硬約束驗證) | **確定性 Validator** |
| 資料 | 真實 API(mock 階段用 fixture) |

> 演算法是「給建議的工具」,不是「做決定的管線」。流程圖那條固定管線 → 改成「agent 可選擇呼叫的能力」。

---

## 3. 資料模型

### 3.1 輸入 `TripRequest`(`mustVisit` 已升級)

```typescript
type TripRequest = {
  days: number;
  destination: string;
  accommodation: Location;          // 沒座標 → 冷啟動第 0 步 geocode
  mustVisit?: MustVisit[];          // ★ 由 string[] 升級
  arrival?: FlightInfo;
  departure?: FlightInfo;
  budgetLevel?: "economy" | "moderate" | "luxury";
  pace?: "relaxed" | "packed";
};

type MustVisit = {
  name: string;        // 必填,人看的
  placeId?: string;    // 選填:autocomplete 選定時帶上 → 零歧義、省一次 API
  location?: Location; // 選填:有地址/座標就帶上
};

type Location = { name: string; lat?: number; lng?: number };
type FlightInfo = { airport: string; datetime: string };
```

### 3.2 產出 `Itinerary`(系統主角,會被反覆 mutate)

```typescript
type Itinerary = {
  request: TripRequest;        // 原始錨點塞進來,改行程時回查
  days: ItineraryDay[];
  totalCost?: number;
};

type ItineraryDay = {
  dayIndex: number;            // 1-based
  items: ItineraryItem[];      // 按 startTime 排序
};

type ItineraryItem = {
  itemId: string;              // ★ 穩定 ID,對話修改靠它指涉(不可用陣列 index)
  kind: "visit" | "meal" | "transit";   // transit 是一等公民
  placeId?: string;
  name: string;                // transit 放 "搭電車 約25分"
  startTime: string;           // 只存開始;endTime = start + duration 動態算
  durationMinutes: number;
  mode?: string;               // transit 專屬
  mealWindow?: [string, string];  // meal 專屬,如 ["11:30","13:30"]
  pinned?: boolean;            // 必去 / 使用者釘死,重排不可動
  estimatedCost?: number;
};
```

**單一時間真相**:只存 `startTime + durationMinutes`,不存 `endTime`(避免兩欄 drift)。
**一天的合法性** = 每個 item 的 `startTime ≥ 前一個 item 的 endTime`。

---

## 4. Tools 層

四個 tool(`searchPlaces` / `getPlaceDetails` / `getTravelTime` / `estimateCost`)靠 `placeId` 串接,輸出乾淨 JSON。詳細簽章見原草案;以下記**決策修正**。

### 4.1 三種搜尋、三種範圍(重要)

| 情境 | 範圍 | 機制 |
|---|---|---|
| **① mustVisit 名稱解析** | **全城,不設小半徑** | Text Search:`"{name} {destination}"`,住宿當 location bias 僅供歧義排序 |
| **② 遠 must-visit 的同日同伴補搜** | ~1.5–2.5km | 以釘好的 must-visit 座標為中心 |
| **③ 住宿附近一般探索** | ~3–5km(預設 5000) | 以住宿為中心 nearby search |

> must-visit 是硬約束,距離不影響「該不該找到它」。用住宿半徑去框它 = bug。流程:**全城解析 → 釘真實座標 → 圍著它建當天行程**。

### 4.2 mustVisit 名稱解析優先序

1. 有 `placeId` → 直接用,不搜尋。
2. 有 `location` → 座標 nearby 定位。
3. 只有 `name` → Text Search;**模糊** → 取最佳並對話確認;**找不到** → 回可行動錯誤,**不靜默 drop 硬約束**。

> name-only 路徑必須保留(Phase 0 手寫 fixture / 早期 demo 都靠它)。

### 4.3 成本上限(每次冷啟動 session;撞上限回可讀錯誤,不 crash)

| Tool | 上限 | 重點 |
|---|---|---|
| `searchPlaces` | ≤ 6,maxResults ≤ 10 | |
| `getPlaceDetails` | ≤ 20 | **triage**:先用便宜的 search 摘要(rating/priceLevel)篩前幾名,只對那些付費要 detail |
| `getTravelTime` | ≤ 30 | 只驗同日相鄰 leg,不是 N² |

---

## 5. Skills 層(可獨立測試)

- **`clusterByDay`** — 跨天分配。用**座標 haversine(免費,不打交通 API)**出草稿;只對「最後落同一天的相鄰點」呼叫 `getTravelTime` 驗真實交通。
- **同日排序** — 由 **LLM** 做(每天 3–5 點,組合空間小,要權衡營業/用餐/步調等語意)。
- **Validator** — 見 §8。可靠性核心,確定性、可單獨測試。
- **`estimateCost` / formatter** — 花費加總對照預算;`Itinerary → text / json / map`。

### 時間估計

- **交通** = `getTravelTime` 估計 + **逐段小緩衝**(隨 pace 調);**不建模時刻表/班距**。趕班機的 leg 走**保守大緩衝**且為硬約束。
- **停留** = `estimatedVisitMinutes` → 分類預設表 → 保底 60 分。**不逐項加 padding**。
- **緩衝住「天」這層**:pace 控當天填充率(relaxed ~70% / packed ~90%),其餘留白。停留時間使用者只能**透過對話**改(改後重驗當天)。

### 用餐

- 預設**每天午 + 晚兩餐**(早餐假設在住宿,預設跳過、可設定)。
- 排進 `mealWindow`(午 11:30–13:30 / 晚 18:00–20:00);餐廳候選取自當天 cluster。
- **用餐時段是軟約束**(沒排/落窗外只軟警告)。

---

## 6. Agent Runtime(通用、可重用 → 服務 meta-goal)

### 6.1 `AgentSpec<TState>`

```typescript
interface AgentSpec<TState> {
  instruction: string;
  model: ModelId;
  constraints: { maxIterations: number; maxTokens: number; runtimeMs: number };
  tools: ToolDef<TState>[];                       // tool 讀寫共享 state,各自做合法性檢查
  initialState: TState;
  validate: (state: TState) => ValidationResult;  // 注入的「完成閘門」;runtime 不懂內容
}
```

旅遊 = `TState = Itinerary`。換領域只換 state + validate,runtime 不動。

### 6.2 手寫 self-loop(~40 行,通用)

```typescript
let state = spec.initialState;
while (withinBudget(spec.constraints)) {
  const resp = await callModel(spec.model, spec.instruction, history); // Claude 原生 tool use
  if (resp.toolUse) {
    const result = executeTool(resp.tool, state);  // 可 reject + 回可讀錯誤 → agent 自然重試
    appendToolResult(history, result);
    continue;
  }
  if (resp.wantsFinalize) {
    const v = spec.validate(state);
    if (v.hardViolations.length === 0) return { state, status: "ok" };
    appendFeedback(history, v.hardViolations);     // 回灌 → agent 自我修正
    continue;
  }
}
return { state, status: "budget_exhausted", validation: spec.validate(state) };  // 優雅退出
```

- **兩層驗證**:tool 邊界檢查(逐操作,早修少燒 token)+ 完成閘門(整份合法才 finalize)。
- **兩個出口**:乾淨(validate 過)/ 預算耗盡(回部分結果 + 具名說明未滿足的硬約束 + 邀請放寬,**不硬吐假合法、不 crash**)。
- **不另開 reviewer node 抓硬約束**(planner 自己 self-loop 修);獨立 reviewer 只用於跨 model 交棒或純主觀 LLM 評審(且不准驅動重排)。

### 6.3 兩種模式(程式層路由,非 LLM 判斷)

| | 冷啟動:初次規劃 | 熱啟動:對話修改 |
|---|---|---|
| 觸發 | `load()` 回 null | 回既存 Itinerary |
| 起始 context | TripRequest | 當前 Itinerary JSON + 新指令(**不重播整段歷史**) |
| loop | 長 | 短(資料多已快取) |

### 6.4 Model 分層(`AgentSpec.model` 讓分層免費,第一天就分)

- **Sonnet 4.6** — 冷啟動規劃(預設 workhorse)。
- **Haiku 4.5** — 熱啟動簡單編輯。
- **Opus 4.8** — 只在卡關時升級重試一輪,再決定是否優雅退出。

---

## 7. Guardrails(數字為「量過再調」的起始值)

> **iterations = LLM 回合數,不是 tool 呼叫數。** 鼓勵 agent 批次發 tool;tool 總量由 §4.3 的 per-tool cap 獨立兜住。

| 約束 | 冷啟動 | 熱啟動 |
|---|---|---|
| maxIterations(LLM 回合) | 25 | 8 |
| token 上限 / session | ~150k | ~40k |
| runtime 上限 | 60s | 20s |
| per-tool cap | §4.3 | applyEdits ≤ 10 |
| 跨 node 總預算 | session 級總和另計 | |

**無進展偵測**(維護 `progressSignal = (itinerary hash, 已抓資料計數, 最近 tool 呼叫集合)`),任一觸發 → 優雅退出:

1. 連續 **3** 回合 `progressSignal` 沒變。
2. 同一 `(tool, args)` 連續 **3** 次重複。
3. 重排後 `validate()` 回**相同 hardViolations 達 3 次**(修不動)。

---

## 8. Validator 設計(無評分)

```typescript
type ValidationResult = {
  hardViolations: Violation[];   // 非空 = 不合法,擋 finalize
  softWarnings: Violation[];     // 具名警告,純資訊,不擋、不驅動迴圈
};
type Violation = {
  code: string;                  // "CLOSED_HOURS" / "MUST_VISIT_MISSING" / "FLIGHT_BUFFER"...
  dayIndex?: number;
  itemId?: string;
  message: string;               // 人話,給 agent 修正線索
  source: "user_instruction" | "constraint";   // Q3 分級用
};
```

- **停止規則**:硬約束全過 → finalize。**沒有 softScore、沒有門檻、沒有無限微調。**
- 軟約束 = 「生成時的引導(寫 prompt)+ 事後警告」,**不是目標函數**。改不改由人決定(對話)。
- **硬約束**:必去有排、天數 = `days`、不排在非營業時間、最後一天在班機前留 buffer、總花費不超硬上限。
- **使用者指令 vs 物理硬約束衝突**:指令蓋過軟約束;撞物理硬約束 → **停下回報 + 提最接近的可行替代**,讓使用者裁決(`source` 標明來源)。

---

## 9. 對話式修改(Phase 3)

- **狀態**:Itinerary JSON = 持久記憶;transcript 短命。
- **修改機制 = 結構化 edit operations**(非重吐整份):

```typescript
applyEdits(input: {
  operations: (
    | { op: "move"; itemId: string; toDay: number; atTime?: string }
    | { op: "add"; placeId: string; day: number }
    | { op: "remove"; itemId: string }
    | { op: "setDuration"; itemId: string; minutes: number }
    | { op: "pin"; itemId: string }
  )[];
}): { itinerary: Itinerary; validation: ValidationResult };
```

- 改完 → 重驗 + **只重算受影響 leg**,不整份重排。
- **直接操作(拖拉 UI)= 同一套 op、同一個 Validator**;差別只在「誰產生 op + 衝突怎麼處理」。**直接編輯照字面做,不自動重排**;要重排讓使用者明講。UI 擺最後做。

---

## 10. 持久化

- **JSON 檔起步**(`FileSessionStore`),藏在 repository 介面後,**agent 不知道儲存層存在**。

```typescript
interface TripRepository {
  load(sessionId: string): Promise<Itinerary | null>;
  save(sessionId: string, itinerary: Itinerary): Promise<void>;
  listTopTrips?(): Promise<TripSummary[]>;   // 之後加
}
```

- **升級 SQLite 的 trigger**:要 top trips / 列表搜尋 / undo 歷史 / 多 session。
- **混合儲存**:metadata 當欄位(destination、view_count、created_at…)供查詢排名;**Itinerary 整棵當 JSON blob,不正規化**。Postgres 只在部署多人併發才上。

---

## 11. Mock 策略(do both)

| | 真實 fixture | 對抗 fixture |
|---|---|---|
| 用途 | demo / 煙霧測試 / 看像不像樣 | **驗證重排邏輯 + 回歸測試** |
| 證明 | 看起來合理 | 實際上正確 |

- 對抗 fixture **刻意有刺**,每筆對應一條約束(窄營業時間、遠距必去、卡班機 buffer、缺 `estimatedVisitMinutes`),寫成 assertion。
- 真實 fixture **「錄一次真 API 回應 → 存 JSON → 重播」**,順便摸到真 API 形狀,鋪路 M4。
- **別被漂亮 demo 騙**:真實資料證明「好看」,只有對抗資料證明「正確」。

---

## 12. 實作路線圖

> 最大重排:**真 API 從原 Phase 1(很早)挪到 M4(倒數第二)。** M0–M3 全在 mock 上把 Phase 3 證完。

| 里程碑 | 目標 | 驗收 |
|---|---|---|
| **M0 骨架 loop** | `AgentSpec` + `runAgent` + 3 最小 guardrail;mock 四 tool + `clusterByDay`;Validator 只驗天數/必去 | 給 TripRequest → 吐一份行程,親眼看 loop 跑完 |
| **M1 自我修正 ★80% 學習** | 對抗 fixture + 完整 Validator + 違規回灌 + tool 邊界檢查 + 無進展偵測 + 其餘 guardrail | agent 自己發現太趕/打烊/超 buffer 並重排,仍全 mock |
| **M2 編輯 + 持久化** | `applyEdits` + `FileSessionStore` + 冷/熱兩模式 | 程式碼載入 → apply 編輯 → 重驗 → 存檔 |
| **M3 對話式修改(終點)** | 熱啟動模式 + 衝突處理 + mustVisit 確認 + model 分層 | 打「把廟移到第二天早上」可運作且維持合理,**純 mock 證完 Phase 3** |
| **M4 接真 API** | 真 Google Places/Routes 塞同一介面;用 M0 錄的 fixture 過渡;geocode | 真東京資料跑出行程(多為工程) |
| **M5 產品化(可選)** | SQLite + top trips + 拖拉 UI + 地圖 | 像個真 app(前端工,非 agent 學習) |

---

## 附:決策速記

- 終點 Phase 3;架構 B;真 API 延到 M4。
- transit 一等公民;`startTime + durationMinutes`;緩衝住「天」這層。
- mustVisit:`MustVisit[]`、全城 text search 解析、找不到不靜默 drop。
- 修改走結構化 edit ops;拖拉 UI 共用同一套 op。
- Validator 無評分:硬約束擋 finalize、軟約束只警告。
- runtime 通用 `AgentSpec<TState>`、self-loop、兩出口;reviewer = 確定性 Validator。
- 持久化 JSON → SQLite(混合儲存)、藏在 repository 後。
- mock = 對抗(測正確)+ 真實(測好看)。
