# 市场收录草稿（dsh-motor-ai 完整版）

本目录内容**不随 npm 包发布**（`package.json.files` 白名单不含 `market-listing/`）。

## 背景

DSH 插件市场（`dsh-market` / dsh-market.com）**不是**按 npm 全量搜索，而是读一份
策展目录：

- 目录包：`dsh-plugin-catalog`（npm），当前 `2026.1010.4974`，含 4471 条
- 生成源：GitHub 仓库 `awesome-dsh-plugin/awesome-dsh-plugin` 的 `data/plugins/*.yml`
- 市场代码：`dshmarket@1.65.1` → `src/regions.ts` 的 `CATALOG_PACKAGE = 'dsh-plugin-catalog'`
  → `src/catalog-npm.ts` 解 tarball 取 `package/plugins.json`

`dsh-motor-ai-l0` 已在目录内（`added: 2026-09-24`，条目 version 停在 0.2.10）；
`dsh-motor-ai`（完整版）**不在** —— 因为从未提交收录 PR，且其 GitHub 仓库不存在。

## 提交步骤

1. 先让仓库真实存在（否则 `url:` 字段指向 404，PR 无意义）：
   ```sh
   cd /d/dsh-motor-ai
   git remote add origin https://github.com/wangxuewangxue98/dsh-motor-ai.git
   git push -u origin main
   ```
   仓库设为 **public**。

2. 给仓库打 topic：`dsh-plugin`（目录站明确要求），可另加 `electric-motor`、
   `motor-design`、`rmxprt`、`motor-cad` 等，与 l0 保持一致。

3. Fork `awesome-dsh-plugin/awesome-dsh-plugin`，把本目录的
   `wangxuewangxue98__dsh-motor-ai.yml` 放到 `data/plugins/` 下（文件名格式
   `<owner>__<repo>.yml`，`/` 不出现），提 PR。

4. 参考 l0 的已收录条目（同目录同格式）：
   `data/plugins/wangxuewangxue98__dsh-motor-ai-l0.yml`

## 注意

- 完整版是 PolyForm Noncommercial + L1/L2 激活码收费轨。公开 GitHub 仓库 =
  源码（含激活验签逻辑）公开可见。**私钥不泄露**（`.secrets/` 已 gitignore 且不在
  files 白名单），但公开前请确认这是想要的许可策略。
- l0 条目里的 `version: 0.2.10` 已落后于 npm 的 0.3.1。若目录 version 字段不自动
  跟随 npm，需要在同一 PR 里顺带更新。
