## ADDED Requirements

### Requirement: 引擎与模型、翻译服务拆为独立顶级导航

系统 SHALL 将资源管理拆分为两个独立的顶级侧边导航——「引擎与模型」与「翻译服务」，不再以统一资源中心 + Tab 的形式承载，并 MUST 移除「全景 / overview」Tab（首启就绪引导由既有 onboarding 承担）。系统 MUST 为旧入口提供薄重定向：`/resources`（含任意 `?tab=*`）、`/modelsControl`、`/translateControl` 均 SHALL 重定向到对应新页，使既有深链接 / 书签不失效。各页内部功能（引擎 / 模型 / 翻译服务的增删改与下载）MUST 与拆分前一致。

#### Scenario: 两个顶级菜单直达

- **WHEN** 用户打开侧边栏
- **THEN** 「引擎与模型」与「翻译服务」作为两个独立顶级菜单出现（不再有统一「资源中心」入口）
- **AND** 点击各菜单直达对应页面，无需再切 Tab

#### Scenario: 移除全景 Tab，首启引导不丢

- **WHEN** 用户首次安装并启动应用且尚无任何引擎模型
- **THEN** 系统通过既有 onboarding 引导其完成首个模型准备
- **AND** 不再存在独立的「全景 / overview」Tab

#### Scenario: 旧路由与深链接重定向

- **WHEN** 用户访问 `/resources`、`/resources?tab=providers`、`/resources?tab=acceleration`、`/modelsControl` 或 `/translateControl`
- **THEN** 系统分别重定向到 `/engines`、`/translation`、`/engines`（选中 builtin）、`/engines`、`/translation`
- **AND** 不出现失效链接或空白页

#### Scenario: 拆分后功能不减

- **WHEN** 用户在「引擎与模型」或「翻译服务」页操作
- **THEN** 引擎 / 模型的下载 / 导入 / 删除 / 更换路径、翻译服务的增删改 / 测试均与拆分前一致
- **AND** 顶栏加速指示器与下载提示均落到正确的新页
