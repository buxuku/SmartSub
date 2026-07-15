## MODIFIED Requirements

### Requirement: 独立常驻 TTS worker

系统 SHALL 以**独立常驻子进程池**（Electron `utilityProcess`，池上限 3、默认 1、按需求扩展）运行本地 TTS 推理(复用内置 sherpa-onnx v1.13.2 的 TTS C API,不改动 native 构建链),消息协议至少包含 `load / synthesize / cancel / dispose`;TTS worker MUST 与 ASR worker 分进程,任一方崩溃不影响另一方。合成请求 SHALL 派发到在途最少的池成员,`cancel` MUST 路由到请求所属进程;**native 层崩溃（onnxruntime abort/段错误等）MUST NOT 影响主进程与池内其余进程**：主进程收 exit 后仅该进程在途请求以可读错误 reject、该成员移出池,下次请求自动补员;批量合成结束后 SHALL 回收多余空闲进程（避免多份模型常驻内存）。worker 的 stderr SHALL 进应用日志（崩溃前输出是关键诊断线索）。worker 通信 SHALL 兼容纯 node `worker_threads` 运行（PoC/单测脚本无 Electron 依赖）。模型配置构建 MUST 收敛到单一纯函数模块,由 worker 直接 require,不得在 worker 内维护第二份内联配置。

#### Scenario: worker 崩溃隔离

- **WHEN** 池中某个 TTS worker 进程因 native 层错误异常退出
- **THEN** 主进程、渲染窗口与池内其余 worker 不受影响,仅该进程在途合成请求返回可行动错误,下次合成请求自动补员恢复执行

#### Scenario: 模型实例缓存

- **WHEN** 连续多次以相同模型参数调用 synthesize
- **THEN** 每个池成员内模型只加载一次(实例按参数缓存),后续调用不重复初始化

#### Scenario: 并行合成提速

- **WHEN** 用户把本地并行合成设为 2 并批量合成多行
- **THEN** 两个 worker 进程同时推理,总耗时显著低于串行;批量结束后池收缩回 1,内存占用回落

#### Scenario: 脚本运行时兼容

- **WHEN** PoC/冒烟脚本以纯 node `worker_threads` 加载同一 worker 文件
- **THEN** 消息协议行为与应用内 utilityProcess 一致,脚本无需 Electron 环境
