import { Osr6Engine } from "./engine";
import type { FunscriptPlayer } from "./player";
import type { TCodeAxis } from "./tcode";
import type { SerialPortLike } from "./transport";
import type { NativeSerialApi } from "./native-serial";

export interface ActivePlayback {
  axis: TCodeAxis;
  player: FunscriptPlayer;
  label: string;
}

/** 预览和游戏按 SDK 的运行周期隔离，旧预览的取消不会停止新预览。 */
export class RuntimeState {
  readonly engine = new Osr6Engine(() => { this.stopPlaybacks(); this.clearTestTimers(); });
  readonly strengthRanges = new Map<TCodeAxis, { min: number; max: number }>();
  activePlaybacks: ActivePlayback[] = [];
  playbackSpeed = 1;
  deviceWatch: ReturnType<typeof setInterval> | null = null;
  playbackHeartbeat: ReturnType<typeof setInterval> | null = null;
  readonly testTimers = new Set<ReturnType<typeof setTimeout>>();
  selectedPort?: SerialPortLike;
  nativeSerial?: NativeSerialApi;
  started = false;
  connectionKey = "";
  private playbackRequest?: AbortController;

  constructor(readonly signal: AbortSignal) {
    signal.addEventListener("abort", () => {
      this.stopPlaybacks();
      this.clearTestTimers();
      if (this.deviceWatch !== null) clearInterval(this.deviceWatch);
      this.deviceWatch = null;
      this.engine.stop();
      void this.engine.disconnect().finally(() => this.nativeSerial?.dispose());
      this.selectedPort = undefined;
    }, { once: true });
  }

  clearTestTimers(): void {
    for (const timer of this.testTimers) clearTimeout(timer);
    this.testTimers.clear();
  }

  beginPlaybackRequest(): AbortSignal {
    this.playbackRequest?.abort();
    this.playbackRequest = new AbortController();
    if (this.signal.aborted) this.playbackRequest.abort();
    return this.playbackRequest.signal;
  }

  finishPlaybackRequest(signal: AbortSignal): void {
    if (this.playbackRequest?.signal === signal) this.playbackRequest = undefined;
  }

  // Natural completion of the previous group must not cancel a replacement
  // that is still loading. Explicit stop/disconnect always cancels it.
  stopPlaybacks(cancelPending = true): void {
    if (cancelPending) {
      this.playbackRequest?.abort();
      this.playbackRequest = undefined;
    }
    for (const item of this.activePlaybacks) item.player.stop();
    this.activePlaybacks = [];
    if (this.playbackHeartbeat !== null) clearInterval(this.playbackHeartbeat);
    this.playbackHeartbeat = null;
  }
}

const runtimes = new WeakMap<AbortSignal, RuntimeState>();
export function runtimeForSignal(signal: AbortSignal): RuntimeState {
  let runtime = runtimes.get(signal);
  if (!runtime) {
    runtime = new RuntimeState(signal);
    runtimes.set(signal, runtime);
  }
  return runtime;
}
