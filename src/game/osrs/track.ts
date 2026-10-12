import { CLIENT_CYCLE_MS, copyPose, densify, mixPose, type Pose } from "./animation";
import type { ActorData, SequenceSource } from "./format";

/** A baked sequence ready to sample: one dense pose and duration per frame. */
export interface SequenceClip {
  id: number;
  poses: Pose[];
  /** Milliseconds per frame. */
  durations: Float32Array;
  frameStep: number;
  maxLoops: number;
  /** Client defaults applied: 0 stall movement, 1 pause while moving, 2 interleave. */
  precedenceAnimating: number;
  /** 1: a new movement step cancels the sequence. */
  priority: number;
}

export function buildClips(data: ActorData): Map<number, SequenceClip> {
  const framePoses = data.frames.map((f) => densify(f, data.bases[f.base]!));
  const clips = new Map<number, SequenceClip>();
  for (const s of data.sequences) clips.set(s.id, buildClip(s, framePoses));
  return clips;
}

function buildClip(s: SequenceSource, framePoses: Pose[]): SequenceClip {
  const durations = new Float32Array(s.lengths.length);
  for (let i = 0; i < durations.length; i++) durations[i] = Math.max(1, s.lengths[i]!) * CLIENT_CYCLE_MS;
  return {
    id: s.id,
    poses: Array.from(s.frames, (f) => framePoses[f]!),
    durations,
    frameStep: s.frameStep,
    maxLoops: s.maxLoops,
    // SequenceDefinition.postDecode: -1 becomes 0 (no interleave masks are baked).
    precedenceAnimating: s.precedenceAnimating === -1 ? 0 : s.precedenceAnimating,
    priority: s.priority === -1 ? 0 : s.priority,
  };
}

/**
 * Playback state of one sequence. Looping tracks (locomotion) wrap to frame
 * 0; one-shot tracks follow the client: past the last frame the frame index
 * steps back by `frameStep` and the sequence ends when that lands outside
 * the frames or `maxLoops` is reached (frameStep -1 plays once).
 */
export class Track {
  frame = 0;
  /** Milliseconds spent in the current frame. */
  elapsed = 0;
  loops = 0;
  finished = false;

  constructor(
    readonly clip: SequenceClip,
    readonly looping: boolean,
  ) {}

  advance(ms: number): void {
    if (this.finished) return;
    const { durations } = this.clip;
    const n = durations.length;
    this.elapsed += ms;
    // Guard against a long stall (tab in background) spinning through thousands of frames.
    if (this.looping) {
      let total = 0;
      for (let i = 0; i < n; i++) total += durations[i]!;
      if (this.elapsed > total) this.elapsed %= total;
    }
    while (this.elapsed >= durations[this.frame]!) {
      this.elapsed -= durations[this.frame]!;
      this.frame++;
      if (this.frame < n) continue;
      if (this.looping) {
        this.frame = 0;
        continue;
      }
      this.frame -= this.clip.frameStep;
      this.loops++;
      if (this.loops >= this.clip.maxLoops || this.frame < 0 || this.frame >= n) {
        this.frame = n - 1;
        this.elapsed = durations[n - 1]!;
        this.finished = true;
        return;
      }
    }
  }

  private nextFrame(): number {
    const n = this.clip.poses.length;
    if (this.frame + 1 < n) return this.frame + 1;
    if (this.looping) return 0;
    const back = n - this.clip.frameStep;
    if (this.loops + 1 < this.clip.maxLoops && back >= 0 && back < n) return back;
    return -1;
  }

  /** Writes the current pose, tweened toward the next frame when `smooth`. */
  sample(out: Pose, smooth: boolean, types: Uint8Array): void {
    const cur = this.clip.poses[this.frame]!;
    const next = this.finished || !smooth ? -1 : this.nextFrame();
    if (next < 0) {
      copyPose(out, cur);
      return;
    }
    const t = Math.min(1, this.elapsed / this.clip.durations[this.frame]!);
    mixPose(out, cur, this.clip.poses[next]!, t, types);
  }
}
