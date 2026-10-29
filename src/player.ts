/**
 * funscript 播放时钟。
 *
 * 只做一件事：按墙钟时间推进脚本时间轴，把采样出的位置交给回调用。
 * 它不认识设备也不认识 Studio，因此可以在 Node 里单独跑测试。
 */

import { sampleFunscript, type Funscript, type InterpolationMode } from "./funscript";
import type { TCodeAxis } from "./tcode";

export interface PlaybackOptions {
  axis: TCodeAxis;
  loop: boolean;
  /** 1 = 原速；2 = 两倍速；0.5 = 半速。 */
  speed: number;
  /** 从脚本的第几毫秒开始。 */
  startMs: number;
  /** 输出反相（0 ↔ 1），用于安装方向相反的机器。 */
  invert: boolean;
  /** 动作点之间的插值方式，默认与 MultiFunPlayer 一样用 pchip。 */
  interpolation: InterpolationMode;
}

export type PositionSink = (axis: TCodeAxis, value: number) => void;

export interface PlaybackState {
  active: boolean;
  paused: boolean;
  scriptMs: number;
  durationMs: number;
  axis: TCodeAxis | null;
  loop: boolean;
  speed: number;
  invert: boolean;
  interpolation: InterpolationMode;
  actionCount: number;
  framesSent: number;
}

const DEFAULT_OPTIONS: PlaybackOptions = {
  axis: "L0",
  loop: false,
  speed: 1,
  startMs: 0,
  invert: false,
  interpolation: "pchip",
};

export class FunscriptPlayer {
  private script: Funscript | null = null;
  private options: PlaybackOptions = { ...DEFAULT_OPTIONS };
  private sink: PositionSink | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private anchorWallMs = 0;
  private anchorScriptMs = 0;
  private paused = false;
  private active = false;
  private framesSent = 0;
  private lastEmitted = -1;

  get isActive(): boolean {
    return this.active;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * 开始播放。
   *
   * @param hz 采样和下发频率，建议与设备发送频率一致（40-60）。
   */
  play(
    script: Funscript,
    options: Partial<PlaybackOptions>,
    sink: PositionSink,
    hz = 50,
  ): void {
    this.stopTimer();
    const merged: PlaybackOptions = { ...DEFAULT_OPTIONS, ...options };
    const speed = Number.isFinite(merged.speed) && merged.speed > 0 ? merged.speed : 1;
    this.script = script;
    this.options = {
      ...merged,
      speed,
      startMs: Math.min(Math.max(0, merged.startMs), script.durationMs),
    };
    this.sink = sink;
    this.active = true;
    this.paused = false;
    this.framesSent = 0;
    this.lastEmitted = -1;
    this.anchorWallMs = Date.now();
    this.anchorScriptMs = this.options.startMs;

    this.emit();
    const interval = Math.max(5, Math.round(1000 / Math.min(120, Math.max(1, hz))));
    this.timer = setInterval(() => this.tick(), interval);
  }

  pause(): void {
    if (!this.active || this.paused) return;
    // 先取当前进度再置 paused：currentScriptMs() 在 paused 状态下返回锚点值，
    // 顺序反了会把位置打回起点。
    const now = this.currentScriptMs();
    this.paused = true;
    this.anchorScriptMs = now;
    this.stopTimer();
  }

  resume(hz = 50): void {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this.anchorWallMs = Date.now();
    const interval = Math.max(5, Math.round(1000 / Math.min(120, Math.max(1, hz))));
    this.timer = setInterval(() => this.tick(), interval);
  }

  /** 跳到脚本的指定毫秒；播放中会继续播，暂停中只更新位置。 */
  seek(timeMs: number): number {
    if (!this.script) return 0;
    const target = Math.min(Math.max(0, timeMs), this.script.durationMs);
    this.anchorScriptMs = target;
    this.anchorWallMs = Date.now();
    if (!this.paused) this.emit();
    return target;
  }

  /**
   * 改播放倍速：以当前进度为新锚点，所以不会跳。
   *
   * 播放中立刻生效；暂停中只记录，继续播放时按新倍速推进。
   */
  setSpeed(speed: number): number {
    const next = Number.isFinite(speed) && speed > 0 ? speed : 1;
    if (!this.active || !this.script) {
      this.options = { ...this.options, speed: next };
      return next;
    }
    const now = this.currentScriptMs();
    this.anchorScriptMs = now;
    this.anchorWallMs = Date.now();
    this.options = { ...this.options, speed: next };
    return next;
  }

  /** Reapply a changed output mapping without changing the playback clock.
   * Paused players defer the new output until resume. */
  refreshOutput(): void {
    if (!this.active) return;
    this.lastEmitted = -1;
    if (!this.paused) this.tick();
  }

  stop(): void {
    this.stopTimer();
    this.active = false;
    this.paused = false;
    this.script = null;
    this.sink = null;
    this.anchorScriptMs = 0;
    this.lastEmitted = -1;
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private currentScriptMs(): number {
    if (!this.active) return 0;
    if (this.paused) return this.anchorScriptMs;
    const elapsed = (Date.now() - this.anchorWallMs) * this.options.speed;
    return this.anchorScriptMs + elapsed;
  }

  private tick(): void {
    if (!this.active || !this.script || this.paused || !this.sink) return;

    let scriptMs = this.currentScriptMs();
    const duration = this.script.durationMs;

    if (scriptMs > duration) {
      if (this.options.loop && duration > 0) {
        // 取模回卷，避免长时间播放后时间轴漂移。
        const wrapped = scriptMs % duration;
        this.anchorScriptMs = wrapped;
        this.anchorWallMs = Date.now();
        scriptMs = wrapped;
      } else {
        this.emitAt(duration);
        this.stopTimer();
        this.active = false;
        return;
      }
    }

    this.emitAt(scriptMs);
  }

  private emit(): void {
    if (!this.script) return;
    this.emitAt(this.currentScriptMs());
  }

  private emitAt(scriptMs: number): void {
    const script = this.script;
    const sink = this.sink;
    if (!script || !sink) return;

    let value = sampleFunscript(script, scriptMs, this.options.interpolation);
    const clamped = Math.min(1, Math.max(0, value));
    value = this.options.invert ? 1 - clamped : clamped;

    // 位置量化到 1/9999，去掉重复帧，避免无意义的下发。
    const quantized = Math.round(value * 9999);
    if (quantized === this.lastEmitted) return;
    this.lastEmitted = quantized;
    this.framesSent += 1;
    sink(this.options.axis, value);
  }

  state(): PlaybackState {
    return {
      active: this.active,
      paused: this.paused,
      scriptMs: Math.round(this.currentScriptMs()),
      durationMs: this.script?.durationMs ?? 0,
      axis: this.active ? this.options.axis : null,
      loop: this.options.loop,
      speed: this.options.speed,
      invert: this.options.invert,
      interpolation: this.options.interpolation,
      actionCount: this.script?.actions.length ?? 0,
      framesSent: this.framesSent,
    };
  }
}
