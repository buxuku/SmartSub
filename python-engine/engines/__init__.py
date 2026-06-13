"""引擎注册表。"""

import logging

log = logging.getLogger(__name__)


class EngineError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.engine_error_code = code


def get_engine(name):
    if name == "faster_whisper":
        from engines import faster_whisper_engine

        return faster_whisper_engine
    raise EngineError("engine_not_found", "unknown engine: %s" % name)


def list_engines():
    available = {"faster_whisper": False}
    try:
        import faster_whisper  # noqa: F401

        available["faster_whisper"] = True
    except ImportError:
        pass
    return available
