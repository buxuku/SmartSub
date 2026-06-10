"""引擎注册表:按名称惰性加载,避免 import 期就拉起重依赖(torch / ctranslate2)。"""

import importlib.util


class EngineError(Exception):
    """带协议错误码的引擎异常。"""

    def __init__(self, code, message):
        super().__init__(message)
        self.engine_error_code = code


_ENGINE_CACHE = {}


def get_engine(name):
    if name in _ENGINE_CACHE:
        return _ENGINE_CACHE[name]

    if name == "fake":
        from engines import fake as module
    elif name == "faster_whisper":
        from engines import faster_whisper_engine as module
    else:
        raise EngineError("engine_not_found", "unknown engine: %s" % name)

    _ENGINE_CACHE[name] = module
    return module


def list_engines():
    """报告各引擎可用性(只探测依赖是否存在,不实际 import 重依赖)。"""
    return {
        "fake": True,
        "faster_whisper": importlib.util.find_spec("faster_whisper") is not None,
    }
