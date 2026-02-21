"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Settings, Phone, MessageSquare, RefreshCw, MicOff, Zap, PhoneOff } from 'lucide-react';

type Message = {
  id: number;
  sender: 'bot' | 'caller';
  text: string;
  timestamp: string;
};

type AppMode = 'twilio' | 'dev';
type DevStatus = 'idle' | 'connecting' | 'listening' | 'agent_speaking';

export default function Home() {
  // ── Shared state ──────────────────────────────────────────────────
  const [appMode, setAppMode] = useState<AppMode>('twilio');
  const [mode, setMode] = useState<'agent' | 'tts' | 'standard'>('agent');
  const [transcript, setTranscript] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const ws = useRef<WebSocket | null>(null);

  // ── Twilio state ───────────────────────────────────────────────────
  const [callActive, setCallActive] = useState(false);
  const [isDialing, setIsDialing] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');

  // ── Dev mode state ─────────────────────────────────────────────────
  const [devStatus, setDevStatus] = useState<DevStatus>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const devWs = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

  const addMessage = useCallback((sender: 'bot' | 'caller', text: string) => {
    setTranscript(prev => [...prev, {
      id: Date.now() + Math.random(),
      sender,
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }]);
  }, []);

  // ── Backend UI WebSocket (Twilio mode UI updates) ─────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return;
    ws.current = new WebSocket('ws://localhost:8000/ui-stream');
    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'transcript') addMessage(data.sender, data.text);
      else if (data.type === 'status') {
        if (data.status === 'call_started') { setCallActive(true); setIsDialing(false); }
        if (data.status === 'call_ended') { setCallActive(false); setIsDialing(false); }
      }
    };
    return () => ws.current?.close();
  }, [addMessage]);

  // ── Twilio handlers ────────────────────────────────────────────────
  const toggleCall = async () => {
    if (callActive) { setCallActive(false); return; }
    if (!phoneNumber) return;
    setIsDialing(true);
    try {
      const res = await fetch('http://localhost:8000/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_number: phoneNumber })
      });
      if (!res.ok) { setIsDialing(false); }
    } catch { setIsDialing(false); }
  };

  // ── Dev mode handlers ──────────────────────────────────────────────

  /** Play PCM16 16kHz audio received from the backend (ElevenLabs agent output) */
  const playPcm16 = useCallback((pcmBytes: ArrayBuffer) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const samples = new Int16Array(pcmBytes);
    const float32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      float32[i] = samples[i] / 32768;
    }
    const buffer = ctx.createBuffer(1, float32.length, 16000);
    buffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
  }, []);

  const startDevSession = async () => {
    setDevStatus('connecting');
    setTranscript([]);

    try {
      // Set up AudioContext for playback
      audioCtxRef.current = new AudioContext({ sampleRate: 48000 });

      // Request microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStreamRef.current = stream;

      // Open WebSocket to backend dev-stream bridge
      const socket = new WebSocket('ws://localhost:8000/dev-stream');
      devWs.current = socket;

      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const msg = JSON.parse(event.data);
          if (msg.type === 'status') {
            if (msg.status === 'connected') setDevStatus('listening');
          } else if (msg.type === 'transcript') {
            addMessage(msg.sender, msg.text);
          } else if (msg.type === 'error') {
            addMessage('bot', `❌ Error: ${msg.message}`);
            endDevSession();
          }
        } else if (event.data instanceof Blob) {
          // Agent audio: PCM16 16kHz binary
          event.data.arrayBuffer().then(buf => playPcm16(buf));
        }
      };

      socket.onclose = () => {
        setDevStatus('idle');
        addMessage('bot', 'Dev session ended.');
      };

      socket.onerror = () => {
        setDevStatus('idle');
        addMessage('bot', '❌ Connection to backend failed. Is the backend running?');
      };

      // Wait for socket to open, then attach AudioWorklet for mic streaming
      socket.onopen = async () => {
        const ctx = audioCtxRef.current!;
        await ctx.audioWorklet.addModule('/audioProcessor.js');

        const source = ctx.createMediaStreamSource(stream);
        const worklet = new AudioWorkletNode(ctx, 'audio-processor');
        workletNodeRef.current = worklet;

        // Each message from worklet = PCM16 chunk → send as binary to backend
        worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          if (!isMuted && socket.readyState === WebSocket.OPEN) {
            socket.send(e.data); // Send raw PCM16 binary
          }
        };

        source.connect(worklet); // mic → worklet (no output connection = don't echo mic to speakers)
        addMessage('bot', '🎙️ Dev mode active — speak into your mic to simulate a caller. Type below to give the agent instructions.');
      };

    } catch (err) {
      console.error('Dev session error:', err);
      setDevStatus('idle');
      addMessage('bot', `❌ Failed to start dev session: ${err}`);
    }
  };

  const endDevSession = useCallback(() => {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;
    devWs.current?.close();
    devWs.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    setDevStatus('idle');
    setIsMuted(false);
  }, []);

  // ── Unified send message ───────────────────────────────────────────
  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    const text = inputText.trim();
    setInputText('');

    if (appMode === 'dev' && devWs.current?.readyState === WebSocket.OPEN) {
      // Send director instruction to backend → forwarded to ElevenLabs agent
      devWs.current.send(JSON.stringify({ type: 'inject', text }));
      addMessage('caller', `[Director]: ${text}`);
    } else if (appMode === 'twilio' && callActive && ws.current?.readyState === WebSocket.OPEN) {
      const actionMap = { tts: 'direct_tts', agent: 'agent_prompt', standard: 'standard' } as const;
      ws.current.send(JSON.stringify({ action: actionMap[mode], text }));
    }
  };

  const devActive = devStatus !== 'idle' && devStatus !== 'connecting';
  const isLive = appMode === 'twilio' ? callActive : devActive;
  const canType = isLive;

  const devStatusLabel: Record<DevStatus, string> = {
    idle: 'Idle',
    connecting: 'Connecting...',
    listening: '🎤 Listening (mic active)',
    agent_speaking: '🔊 Agent Speaking',
  };

  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100 font-sans">
      {/* ── Main content ── */}
      <div className="flex-1 flex flex-col relative">
        {/* Live banner */}
        {isLive && (
          <div className={`absolute top-0 left-0 right-0 z-10 backdrop-blur-md border-b py-3 px-6 flex items-center gap-3 ${appMode === 'dev' ? 'bg-amber-600/10 border-amber-500/20 text-amber-400' : 'bg-blue-600/10 border-blue-500/20 text-blue-400'}`}>
            <span className="relative flex h-3 w-3">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${appMode === 'dev' ? 'bg-amber-400' : 'bg-blue-400'}`}></span>
              <span className={`relative inline-flex rounded-full h-3 w-3 ${appMode === 'dev' ? 'bg-amber-500' : 'bg-blue-500'}`}></span>
            </span>
            <span className="text-sm font-medium">
              {appMode === 'dev' ? `⚡ Dev Mode — ${devStatusLabel[devStatus]}` : 'Live call active'}
            </span>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 p-8 overflow-y-auto pt-24 pb-32 flex flex-col justify-end">
          <div className="space-y-6">
            {transcript.length === 0 && (
              <div className="text-center text-neutral-600 flex flex-col items-center gap-4 mt-32">
                {appMode === 'dev'
                  ? <><Zap className="w-8 h-8 opacity-20" /><p>Click <strong>Start Dev Session</strong>.<br />Speak into your mic to simulate being a caller.<br />Type below to send the agent instructions.</p></>
                  : <><RefreshCw className="w-8 h-8 opacity-20" /><p>No messages yet. Start a call or type below.</p></>
                }
              </div>
            )}
            {transcript.map(msg => (
              <div key={msg.id} className={`flex ${msg.sender === 'bot' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[70%] p-4 shadow-xl ${msg.sender === 'bot'
                  ? 'bg-blue-600/20 border border-blue-500/30 text-blue-50 rounded-2xl rounded-tr-sm'
                  : 'bg-neutral-800/80 border border-neutral-700/50 text-neutral-200 rounded-2xl rounded-tl-sm'}`}>
                  <p className="text-[15px] leading-relaxed">{msg.text}</p>
                  <span className="text-[11px] text-neutral-500 mt-2 block font-medium uppercase tracking-wider">{msg.sender} • {msg.timestamp}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Text input */}
        <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-neutral-950 via-neutral-950/95 to-transparent pt-12">
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto relative">
            <input
              type="text" value={inputText} onChange={e => setInputText(e.target.value)}
              disabled={!canType}
              placeholder={
                !canType
                  ? appMode === 'dev' ? 'Start a dev session first...' : 'Start a call to begin typing...'
                  : appMode === 'dev' ? 'Give the agent instructions (e.g. "Ask for their name")'
                    : mode === 'tts' ? 'Type to speak immediately (interrupts ongoing speech)...'
                    : mode === 'agent' ? 'Prompt the AI to respond...'
                    : 'Standard mode — speak with your own voice'
              }
              className={`w-full bg-neutral-900 border ${canType ? 'border-neutral-700 focus:border-blue-500 focus:ring-blue-500/50' : 'border-neutral-800 opacity-50 cursor-not-allowed'} text-white placeholder-neutral-500 rounded-2xl py-4 pl-6 pr-16 focus:outline-none focus:ring-2 transition-all shadow-2xl`}
            />
            <button type="submit" disabled={!canType || !inputText.trim()}
              className={`absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-xl transition-all ${canType && inputText.trim() ? 'bg-blue-600 text-white hover:bg-blue-500 shadow-md' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'}`}>
              <MessageSquare className="w-4 h-4" />
            </button>
          </form>
          <div className="max-w-4xl mx-auto mt-3 flex justify-between items-center px-2">
            <span className="text-[11px] text-neutral-500">
              {mode === 'tts' && inputText.length > 0 && "Submitting this will explicitly interrupt any ongoing bot speech."}
              {mode === 'standard' && "Your microphone audio passes through directly — no AI processing."}
            </span>
            <span className="text-[11px] text-neutral-500 flex items-center gap-1">
              {mode !== 'standard' && <>Press <kbd className="bg-neutral-800 px-1.5 py-0.5 rounded font-mono mx-1 border border-neutral-700">Enter</kbd>
              to {appMode === 'dev' ? 'instruct agent' : mode === 'tts' ? 'speak' : 'generate'}</>}
            </span>
          </div>
        </div>
      </div>

      {/* ── Sidebar (right side) ── */}
      <div className="w-80 border-l border-neutral-800 bg-neutral-900/50 p-6 flex flex-col gap-6">

        {/* Header */}
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white mb-1 flex items-center gap-2">
            <Mic className="text-blue-500" /> Voice Surrogate
          </h1>
          <p className="text-sm text-neutral-400">Manage your AI proxy calls in real-time.</p>
        </div>

        {/* App mode toggle (Twilio / Dev) */}
        <div className="space-y-2">
          <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider flex items-center gap-2">
            <Settings className="w-3 h-3" /> Mode
          </h2>
          <div className="grid grid-cols-2 gap-2 bg-neutral-900 p-1 rounded-xl border border-neutral-800">
            <button
              onClick={() => setAppMode('twilio')}
              disabled={devActive}
              className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${appMode === 'twilio' ? 'bg-white text-black shadow-sm' : 'text-neutral-400 hover:text-white hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed'}`}
            >
              📞 Twilio
            </button>
            <button
              onClick={() => setAppMode('dev')}
              disabled={callActive}
              className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${appMode === 'dev' ? 'bg-amber-500 text-black shadow-sm' : 'text-neutral-400 hover:text-white hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed'}`}
            >
              ⚡ Dev Mode
            </button>
          </div>
          {appMode === 'dev' && (
            <p className="text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              Your mic = simulated caller. The agent handles the call autonomously. Type to give the agent director instructions.
            </p>
          )}
        </div>

        {/* Operating Mode (Agent / Direct TTS / Standard) — Twilio only */}
        {appMode === 'twilio' && (
          <div className="space-y-3">
            <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider flex items-center gap-2">
              <Settings className="w-3 h-3" /> Operating Mode
            </h2>
            <div className="flex gap-4">
              {/* Description on the left */}
              <div className="flex-1 flex items-center">
                <p className="text-xs text-neutral-500 leading-relaxed">
                  {mode === 'agent'
                    ? "Act as a director. Type prompts mid-call, and the AI generates full conversational responses."
                    : mode === 'tts'
                      ? "The AI speaks exactly what you type. Includes real-time spellcheck."
                      : "Speak with your own voice directly on the call. No AI voice processing."}
                </p>
              </div>
              {/* Vertical toggle on the right */}
              <div className="flex flex-col gap-2 bg-neutral-900 p-1.5 rounded-xl border border-neutral-800">
                {([
                  { key: 'agent' as const, label: 'Agent', color: 'bg-blue-600 text-white' },
                  { key: 'tts' as const, label: 'Direct TTS', color: 'bg-white text-black' },
                  { key: 'standard' as const, label: 'Standard', color: 'bg-emerald-600 text-white' },
                ]).map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => setMode(opt.key)}
                    className={`py-2 px-4 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${mode === opt.key ? `${opt.color} shadow-sm` : 'text-neutral-400 hover:text-white hover:bg-neutral-800'}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="mt-auto space-y-3">
          {appMode === 'twilio' ? (
            <>
              {!callActive && (
                <input type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)}
                  placeholder="+1234567890"
                  className="w-full bg-neutral-900 border border-neutral-700 text-white placeholder-neutral-500 rounded-xl py-3 px-4 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                />
              )}
              <button onClick={toggleCall} disabled={(!callActive && !phoneNumber) || isDialing}
                className={`w-full py-4 rounded-xl flex items-center justify-center gap-2 font-medium transition-all ${callActive ? 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20' : isDialing ? 'bg-blue-600/50 text-white cursor-wait' : !phoneNumber ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed' : 'bg-white text-black hover:bg-neutral-200'}`}>
                {isDialing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Phone className="w-5 h-5" />}
                {isDialing ? 'Dialing...' : callActive ? 'End Call' : 'Call Number'}
              </button>
            </>
          ) : (
            <>
              {devActive && (
                <div className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm ${devStatus === 'agent_speaking' ? 'bg-blue-500/10 border-blue-500/30 text-blue-300' : 'bg-green-500/10 border-green-500/30 text-green-300'}`}>
                  <span>{devStatusLabel[devStatus]}</span>
                  <span className="relative flex h-2 w-2">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${devStatus === 'agent_speaking' ? 'bg-blue-400' : 'bg-green-400'}`}></span>
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${devStatus === 'agent_speaking' ? 'bg-blue-500' : 'bg-green-500'}`}></span>
                  </span>
                </div>
              )}
              {devActive && (
                <button onClick={() => { setIsMuted(m => !m); }}
                  className={`w-full py-2 rounded-xl flex items-center justify-center gap-2 text-sm font-medium border transition-all ${isMuted ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-neutral-800 text-neutral-300 border-neutral-700 hover:bg-neutral-700'}`}>
                  {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  {isMuted ? 'Unmute Mic' : 'Mute Mic'}
                </button>
              )}
              <button
                onClick={devActive ? endDevSession : startDevSession}
                disabled={devStatus === 'connecting'}
                className={`w-full py-4 rounded-xl flex items-center justify-center gap-2 font-medium transition-all ${devActive ? 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20' : devStatus === 'connecting' ? 'bg-amber-500/30 text-amber-300 cursor-wait' : 'bg-amber-500 text-black hover:bg-amber-400'}`}>
                {devStatus === 'connecting' ? <RefreshCw className="w-5 h-5 animate-spin" /> : devActive ? <PhoneOff className="w-5 h-5" /> : <Zap className="w-5 h-5" />}
                {devStatus === 'connecting' ? 'Connecting...' : devActive ? 'End Dev Session' : 'Start Dev Session'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
