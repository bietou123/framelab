import { useEffect, useRef } from 'react';
import type { Clip, Media } from '../shared/types';
export function Waveform({ media, clip, color = '#81c7a3' }: { media: Media; clip?: Clip; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const draw = () => {
      const rect = canvas.getBoundingClientRect(), ratio = Math.min(2, devicePixelRatio);
      const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
      canvas.width = width * ratio; canvas.height = height * ratio;
      const ctx = canvas.getContext('2d')!; ctx.scale(ratio, ratio); ctx.clearRect(0, 0, width, height);
      const peaks = media.waveform; if (!peaks?.length) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < width; x += 2) {
        let time = clip ? clip.sourceStart + x / width * clip.duration * clip.rate : x / width * media.duration;
        if (clip?.reverse) time = clip.sourceStart + clip.duration * clip.rate - x / width * clip.duration * clip.rate;
        if (clip?.loop) time = time % media.duration;
        const index = Math.floor(time / media.duration * peaks.length);
        const value = Math.min(1, Math.max(0, peaks[index] || 0));
        ctx.moveTo(x, height / 2 - value * height * 0.46); ctx.lineTo(x, height / 2 + value * height * 0.46);
      }
      ctx.stroke();
    };
    const observer = new ResizeObserver(draw); observer.observe(canvas); draw(); return () => observer.disconnect();
  }, [media, clip, color]);
  return <canvas className="waveform" ref={ref} aria-label="音频波形" />;
}
