# Alan的存股筆記 — Vercel 部署指南

本專案已整合前端互動網頁（`public/index.html`）與 Vercel Serverless API（`api/prices.js`），部署後即可自動抓取 **台灣證券交易所（TWSE）** 與 **櫃買中心（TPEx）** 的最新收盤價。

## 資料來源端點
- 上市股票／ETF：`https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL`
- 上櫃股票／ETF：`https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes`
- 免申請 API Key，並透過 `s-maxage=300` 設定 Vercel Edge 快取 5 分鐘。

## 部署步驟

### 方法一：透過 GitHub + Vercel 網頁部署（推薦）
1. 解壓縮本專案並上傳至您的 GitHub Repository。
2. 登入 [Vercel](https://vercel.com/)，點擊 **Add New... -> Project**。
3. 匯入該 GitHub Repository，Framework Preset 選擇 **Other**，直接點擊 **Deploy**。
4. 部署完成後開啟網址，網頁載入或點擊右上角「更新股價」時即會自動呼叫 `/api/prices` 同步最新收盤價。

### 方法二：使用 Vercel CLI 本機部署
```bash
npm i -g vercel
vercel --prod
```
