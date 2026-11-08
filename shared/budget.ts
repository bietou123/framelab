import type { BitrateBudget } from './types';
export function bitrateBudget(duration: number, limit: number | null, audioKbps: number, requestedKbps: number | null): BitrateBudget {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('时间线没有可导出的画面');
  if (!Number.isFinite(audioKbps) || audioKbps < 0) throw new Error('音频码率无效');
  const audioBits = audioKbps * 1000 * duration;
  const overheadBytes = limit ? Math.max(512_000, limit * 0.003) : 512_000;
  const safetyBytes = limit ? Math.max(512_000, limit * 0.022) : 0;
  let videoKbps = requestedKbps || 16_000;
  if (limit !== null) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('目标体积必须是正整数字节数');
    const available = (limit - overheadBytes - safetyBytes) * 8 - audioBits;
    const budget = Math.floor(available / duration / 1000);
    if (budget < 100) throw new Error('目标体积不足以容纳所选音频和有效视频，请增大体积或降低音频码率');
    videoKbps = requestedKbps ? Math.min(requestedKbps, budget) : budget;
  }
  return { duration, limit, audioBits, overheadBytes, safetyBytes, videoKbps,
    estimatedBytes: Math.ceil((videoKbps * 1000 * duration + audioBits) / 8 + overheadBytes) };
}
