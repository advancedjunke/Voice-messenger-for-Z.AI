// Audio synthesizer using Web Audio API for call rings and sounds

class AudioToneManager {
  private ctx: AudioContext | null = null;
  private currentInterval: number | null = null;
  private activeNodes: (OscillatorNode | GainNode)[] = [];

  private getContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  stopAll() {
    if (this.currentInterval !== null) {
      clearInterval(this.currentInterval);
      this.currentInterval = null;
    }
    this.activeNodes.forEach(node => {
      try {
        if ('stop' in node) (node as OscillatorNode).stop();
        node.disconnect();
      } catch (e) {
        // ignore already stopped
      }
    });
    this.activeNodes = [];
  }

  // Outgoing ring sound (Beeeep ... Beeeep ...)
  playOutgoingRing() {
    this.stopAll();
    const ctx = this.getContext();

    const ring = () => {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(425, ctx.currentTime);
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(450, ctx.currentTime);

      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start();
      osc2.start();
      osc1.stop(ctx.currentTime + 1.2);
      osc2.stop(ctx.currentTime + 1.2);

      this.activeNodes.push(osc1, osc2, gain);
    };

    ring();
    this.currentInterval = window.setInterval(ring, 3000);
  }

  // Incoming call ringtone (melodic chime)
  playIncomingRing() {
    this.stopAll();
    const ctx = this.getContext();

    const chime = () => {
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
      notes.forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + index * 0.15);

        const startTime = ctx.currentTime + index * 0.15;
        gain.gain.setValueAtTime(0.12, startTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.35);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(startTime);
        osc.stop(startTime + 0.35);

        this.activeNodes.push(osc, gain);
      });
    };

    chime();
    this.currentInterval = window.setInterval(chime, 2000);
  }

  // Hangup tone (short disconnect beep)
  playHangupTone() {
    this.stopAll();
    const ctx = this.getContext();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, ctx.currentTime);

    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  }
}

export const audioTone = new AudioToneManager();
