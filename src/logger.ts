export type LogFn = (
  msg: string,
  opts?: {level?: string; [k: string]: unknown}
) => void;

export type Logger = {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
};

const PREFIX = 'dsv4-anchored';

/**
 * 两级日志 + debug 短路（D9）：插件与 opencode 同进程，启动时解析一次
 * OPENCODE_LOG_LEVEL==="DEBUG"；非 DEBUG 时 debug() 直接 return——不序列化、
 * 不调 app.log（避免每轮 JSON.stringify 完整 system + HTTP roundtrip）。
 */
export function makeLogger(
  log: LogFn,
  opts?: {debugEnabled?: boolean}
): Logger {
  const debugEnabled =
    opts?.debugEnabled ?? process.env.OPENCODE_LOG_LEVEL === 'DEBUG';
  const emit = (
    msg: string,
    level: string,
    fields?: Record<string, unknown>
  ): void => {
    log(`${PREFIX}: ${msg}`, {level, ...fields});
  };
  return {
    info(msg, fields) {
      emit(msg, 'info', fields);
    },
    warn(msg, fields) {
      emit(msg, 'warn', fields);
    },
    debug(msg, fields) {
      if (!debugEnabled) return;
      emit(msg, 'debug', fields);
    },
  };
}
