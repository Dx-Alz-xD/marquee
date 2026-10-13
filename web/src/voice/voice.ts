// Push-to-talk voice chat — a WebRTC audio mesh (≤ ~12 people is comfortable).
//
//  • Signalling (offer/answer/ICE) rides the room WebSocket; audio flows
//    peer-to-peer and never touches the server.
//  • The member with the smaller id initiates each pair, so there's no glare.
//  • One audio transceiver per peer; the mic is attached with replaceTrack and
//    gated with track.enabled, so push-to-talk never renegotiates.
//  • A level meter decides when you're actually speaking; everyone else's movie
//    audio ducks to 25 % while anyone talks.
//  • getUserMedia needs a secure origin (https or localhost). On a plain-http
//    LAN link you can still *listen*; talking needs the https "Anywhere" link.
import type { RtcData, ServerMsg } from '@shared/protocol';
import type { RoomClient } from '../net/client';
import { useRoom } from '../store';
import type { SyncEngine } from '../sync/engine';

interface Peer {
  pc: RTCPeerConnection;
  tx: RTCRtpTransceiver | null;
  audio: HTMLAudioElement;
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const SPEAK_THRESHOLD = 0.035; // RMS
const SPEAK_HANGOVER_MS = 400;

export class VoiceManager {
  private peers = new Map<string, Peer>();
  private mic: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private ctx: AudioContext | null = null;
  private meterTimer: number | null = null;
  private on = false;
  private speaking = false;
  private lastLoud = 0;
  private lastAnnounce = 0;
  private unsub: () => void;
  private retryTimers = new Map<string, number>();

  constructor(
    private readonly client: RoomClient,
    private readonly engine: SyncEngine,
  ) {
    client.onMessage(this.onMsg);
    this.unsub = useRoom.subscribe((s, prev) => {
      if (s.members !== prev.members || s.conn !== prev.conn) this.reconcile();
      if (s.speaking !== prev.speaking) this.updateDuck();
    });
  }

  get active() {
    return this.on;
  }

  async join() {
    if (this.on) return;
    const store = useRoom.getState();
    store.setVoice({ state: 'connecting', error: null });
    let mic = false;
    if (window.isSecureContext && navigator.mediaDevices?.getUserMedia) {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        this.micTrack = this.mic.getAudioTracks()[0] ?? null;
        if (this.micTrack) this.micTrack.enabled = false;
        mic = !!this.micTrack;
        this.startMeter();
      } catch {
        const error = 'Microphone blocked — you can still listen. Allow mic access in the address bar to talk.';
        store.setVoice({ error });
        store.toast(error, 'warn', '🎙');
      }
    } else {
      const error = 'Talking needs the https “Anywhere” link (or localhost) — browsers only allow mics on secure pages. You can still listen.';
      store.setVoice({ error });
      store.toast(error, 'warn', '🎙');
    }
    this.on = true;
    this.client.send({ t: 'voice', on: true, mic });
    useRoom.getState().setVoice({ state: mic ? 'talk' : 'listen' });
    this.reconcile();
  }

  leave() {
    if (!this.on) return;
    this.on = false;
    this.client.send({ t: 'voice', on: false, mic: false });
    for (const id of [...this.peers.keys()]) this.closePeer(id, true);
    this.setTransmit(false);
    this.stopMeter();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.micTrack = null;
    this.engine.setDucked(false);
    useRoom.getState().setVoice({ state: 'off', transmitting: false, handsFree: false, peers: {}, error: null });
  }

  /** Push-to-talk (or hands-free latch). */
  setTransmit(on: boolean) {
    if (!this.micTrack) return;
    this.micTrack.enabled = on;
    useRoom.getState().setVoice({ transmitting: on });
    if (!on) this.setSpeaking(false);
  }

  setHandsFree(on: boolean) {
    useRoom.getState().setVoice({ handsFree: on });
    this.setTransmit(on);
  }

  // ─── Mesh maintenance ──────────────────────────────────────────────────────

  private reconcile() {
    if (!this.on) return;
    const st = useRoom.getState();
    const me = st.you;
    if (!me || st.conn !== 'connected') return;
    const self = st.members[me];
    // After a reconnect the server marks us out of voice — tear down and re-announce.
    if (self && self.voice === 'off') {
      for (const id of [...this.peers.keys()]) this.closePeer(id, false);
      if (performance.now() - this.lastAnnounce > 2000) {
        this.lastAnnounce = performance.now();
        this.client.send({ t: 'voice', on: true, mic: !!this.micTrack });
      }
      return;
    }
    const want = new Set(
      Object.values(st.members)
        .filter((m) => m.id !== me && m.online && m.voice !== 'off')
        .map((m) => m.id),
    );
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.closePeer(id, false);
    for (const id of want) if (!this.peers.has(id) && me < id && !this.retryTimers.has(id)) void this.connect(id);
  }

  private createPeer(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const audio = new Audio();
    audio.autoplay = true;
    const peer: Peer = { pc, tx: null, audio, pendingIce: [], remoteSet: false };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audio.play().catch(() => {});
    };
    pc.onicecandidate = (e) => {
      const c = e.candidate;
      if (c) this.signal(id, { type: 'ice', candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment } });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.setPeerState(id, s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : 'connecting');
      if (s === 'failed') {
        this.closePeer(id, false);
        // Back off, then let reconcile() rebuild the link.
        this.retryTimers.set(
          id,
          window.setTimeout(() => {
            this.retryTimers.delete(id);
            this.reconcile();
          }, 3000),
        );
      }
    };
    this.peers.set(id, peer);
    this.setPeerState(id, 'connecting');
    return peer;
  }

  private async connect(id: string) {
    const peer = this.createPeer(id);
    peer.tx = peer.pc.addTransceiver('audio', { direction: 'sendrecv', streams: this.mic ? [this.mic] : [] });
    if (this.micTrack) await peer.tx.sender.replaceTrack(this.micTrack);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.signal(id, { type: 'offer', sdp: offer.sdp ?? '' });
  }

  private onMsg = async (msg: ServerMsg) => {
    if (msg.t !== 'rtc' || !this.on) return;
    const { from, data } = msg;
    try {
      if (data.type === 'offer') {
        if (this.peers.has(from)) this.closePeer(from, false);
        const peer = this.createPeer(from);
        await peer.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        peer.remoteSet = true;
        const tx = peer.pc.getTransceivers()[0];
        if (tx) {
          tx.direction = 'sendrecv';
          if (this.micTrack) await tx.sender.replaceTrack(this.micTrack);
          peer.tx = tx;
        }
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.signal(from, { type: 'answer', sdp: answer.sdp ?? '' });
        await this.flushIce(peer);
      } else if (data.type === 'answer') {
        const peer = this.peers.get(from);
        if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        peer.remoteSet = true;
        await this.flushIce(peer);
      } else if (data.type === 'ice') {
        const peer = this.peers.get(from);
        if (!peer) return;
        if (peer.remoteSet) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pendingIce.push(data.candidate);
      } else if (data.type === 'bye') {
        this.closePeer(from, false);
      }
    } catch (e) {
      console.warn('[voice] signalling error', e);
    }
  };

  private async flushIce(peer: Peer) {
    for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  private signal(to: string, data: RtcData) {
    this.client.send({ t: 'rtc', to, data });
  }

  private closePeer(id: string, sayBye: boolean) {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (sayBye) this.signal(id, { type: 'bye' });
    peer.pc.close();
    peer.audio.srcObject = null;
    this.peers.delete(id);
    const peers = { ...useRoom.getState().voice.peers };
    delete peers[id];
    useRoom.getState().setVoice({ peers });
  }

  private setPeerState(id: string, s: 'connecting' | 'connected' | 'failed') {
    useRoom.getState().setVoice({ peers: { ...useRoom.getState().voice.peers, [id]: s } });
  }

  // ─── Speaking detection & ducking ──────────────────────────────────────────

  private startMeter() {
    if (!this.mic) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    const src = this.ctx.createMediaStreamSource(this.mic);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    this.meterTimer = window.setInterval(() => {
      if (!this.micTrack?.enabled) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (rms > SPEAK_THRESHOLD) this.lastLoud = now;
      this.setSpeaking(now - this.lastLoud < SPEAK_HANGOVER_MS);
    }, 60);
  }

  private stopMeter() {
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  private setSpeaking(on: boolean) {
    if (this.speaking === on) return;
    this.speaking = on;
    this.client.send({ t: 'speaking', on });
    const me = useRoom.getState().you;
    if (me) useRoom.setState((s) => ({ speaking: { ...s.speaking, [me]: on } }));
  }

  private updateDuck() {
    if (!this.on) return this.engine.setDucked(false);
    const st = useRoom.getState();
    const others = Object.entries(st.speaking).some(([id, on]) => on && id !== st.you);
    this.engine.setDucked(others);
  }

  destroy() {
    this.leave();
    this.unsub();
    this.client.offMessage(this.onMsg);
    this.retryTimers.forEach((t) => clearTimeout(t));
  }
}
