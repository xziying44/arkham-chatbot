import dayjs from "dayjs";

/** 格式化时间戳为可读时间。 */
export function fmtTime(ts: number): string {
  return dayjs(ts).format("YYYY-MM-DD HH:mm:ss");
}

/** 格式化毫秒时长为「x分y秒」。 */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return "0秒";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  const h = Math.floor(m / 60);
  return `${h}时${m % 60}分`;
}

/** 截断长文本。 */
export function truncate(s: string | null | undefined, max = 60): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}
