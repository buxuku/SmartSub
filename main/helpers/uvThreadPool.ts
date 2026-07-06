/**
 * 尽早放大 libuv 线程池（副作用模块，必须是主进程入口的第一个 import）。
 *
 * whisper.cpp 内置引擎的转写是 Napi::AsyncWorker，跑在 libuv 线程池上；
 * 该池默认仅 4 线程且被 fs.promises / dns / zlib 等共享，导致：
 *   ① 最大并发任务数 >4 时，多出的内置引擎转写被悄悄卡在池队列（设了不生效）；
 *   ② 转写占满 4 线程的几分钟内，主进程所有异步文件 I/O 被饿死。
 *
 * 线程池在首个异步池任务提交时定型，之后修改无效——所以只能在进程最早期
 * 设一个静态上限：12 ≈ 常见并发上限(8) + fs/dns 余量(4)。空闲线程只占栈
 * 空间（约 1MB 虚拟内存/线程），不耗 CPU。用户已显式设置时不覆盖。
 */
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '12';
}

export {};
