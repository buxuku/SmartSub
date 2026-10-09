/*
 * 崩溃诊断烟测用的「真实原生崩溃」样本：被 process.dlopen 加载后立即崩溃。
 * 只用于验证（scripts/crash/smoke.mjs），不被应用引用。
 *
 * 触发时机（-D 选择）：
 *   默认            在导出的 napi_register_module_v1 里触发。Node 加载 N-API 模块时在 JS 调用栈内
 *                   调用它，崩溃发生在加载库之后，最接近「addon 在推理时崩溃」
 *   -DBOOM_ON_LOAD  在库加载过程中触发（Linux/macOS 构造函数、Windows DllMain）。
 *                   实测 Windows 加载器会吞掉 DllMain 里的异常，只返回
 *                   「DLL initialization routine failed」，进程不会崩
 *
 * 崩溃方式（-D 选择）：
 *   -DBOOM_ILL      非法指令。x86_64 用 ud2（Linux SIGILL / Windows 0xC000001D / macOS EXC_BAD_INSTRUCTION），
 *                   arm64 用永久未定义的编码 0x00000000（udf #0）。
 *                   从进程视角看与「addon 用了 CPU 不支持的指令」完全一致
 *   -DBOOM_ABORT    C 运行时的 abort()（ggml 的 GGML_ABORT / GGML_ASSERT 最终走这里）
 *   (默认)          写空指针：Linux/macOS SIGSEGV / Windows 0xC0000005
 *
 * 构建见 build.sh（cc）与 build.ps1（MSVC，缺省退回 MinGW）。
 */
#include <stdlib.h>

#if defined(_WIN32)
#include <windows.h>
#if defined(_MSC_VER)
#include <intrin.h>
#endif
#define BOOM_EXPORT __declspec(dllexport)
#else
#define BOOM_EXPORT __attribute__((visibility("default")))
#endif

static void boom(void) {
#if defined(BOOM_ILL)
#if defined(_MSC_VER)
  __ud2();
#elif defined(__aarch64__)
  /* __builtin_trap() 在 arm64 上是 brk（SIGTRAP），不是非法指令；这里直接发 udf #0 */
  __asm__ volatile(".inst 0x00000000");
#else
  __builtin_trap(); /* gcc/clang：x86_64 编译成 ud2 */
#endif
#elif defined(BOOM_ABORT)
  abort();
#else
  *(volatile int *)0 = 1;
#endif
}

#if defined(BOOM_ON_LOAD)
#if defined(_WIN32)
BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved) {
  (void)h;
  (void)reserved;
  if (reason == DLL_PROCESS_ATTACH) boom();
  return TRUE;
}
#else
__attribute__((constructor)) static void boom_on_load(void) { boom(); }
#endif
#else
/* 与 N-API 模块的入口同名同签名（不依赖 node_api.h，用 void* 代替 napi_env / napi_value） */
BOOM_EXPORT void *napi_register_module_v1(void *env, void *exports) {
  (void)env;
  boom();
  return exports;
}
#endif
