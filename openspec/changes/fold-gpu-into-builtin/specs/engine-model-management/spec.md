## ADDED Requirements

### Requirement: GPU 加速管理归属 builtin 引擎面板

系统 SHALL 将 GPU 加速管理（whisper.cpp 的 CUDA / Vulkan addon 选择、下载、切换、诊断）归属 builtin（whisper.cpp）引擎面板，而非独立的全局「加速」入口，以使加速作用域诚实（GPU 加速作用于 builtin 引擎；faster-whisper 有其自身 device 设置，sherpa 系引擎为 CPU）。该面板 MUST 以渐进式披露内联呈现：紧凑状态摘要常驻，模式 / 后端 / 已装列表 / 自定义 / 诊断置于默认收起的「管理 / 高级」折叠区。CUDA 下载选择器 MUST 由页面内打开（抽屉/Sheet），MUST NOT 出现「弹窗内再开抽屉」的嵌套。顶栏加速指示器 SHALL 指向 builtin 引擎面板。

#### Scenario: GPU 加速在 builtin 面板内管理

- **WHEN** 用户在引擎面选中 builtin（whisper.cpp）
- **THEN** 面板内呈现 GPU 加速：紧凑状态摘要常驻，详细管理（模式/后端/已装/自定义/诊断）在默认收起的折叠区
- **AND** 不存在独立于引擎之外、暗示「加速所有引擎」的全局加速入口

#### Scenario: CUDA 下载为页面内抽屉，无嵌套

- **WHEN** 用户在 builtin 面板展开「管理 / 高级」并触发 CUDA 下载
- **THEN** CUDA 下载选择器以页面内抽屉（Sheet）打开
- **AND** 该抽屉不从任何弹窗（Dialog）内部打开（无弹窗↔抽屉嵌套）

#### Scenario: macOS 退化为状态行

- **WHEN** 用户在 macOS 上查看 builtin 面板
- **THEN** 仅显示 Metal / CoreML 加速状态，无下载流程
- **AND** 面板保持轻量

#### Scenario: 顶栏加速指示器指向 builtin 面板

- **WHEN** 用户点击顶栏的加速状态指示器
- **THEN** 系统导航到 builtin 引擎面板（并选中 builtin）
- **AND** 旧的 `?tab=acceleration` 深链接被重定向到该面板
