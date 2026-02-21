"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Conversation } from '@elevenlabs/client';
import { Mic, Settings, Phone, MessageSquare, RefreshCw, Volume2, MicOff, Zap, PhoneOff } from 'lucide-react';

type Message = {
  id: number;
  sender: 'bot' | 'caller';
  text: string;
  timestamp: string;
};

type AppMode = 'twilio' | 'dev';

export default function Home() {
  // ── Shared state ──────────────────────────────────────────────────
  const [appMode, setAppMode] = useState<AppMode>('twilio');
  const [mode, setMode] = useState<'tts' | 'agent'>('tts');
  const [transcript, setTranscript] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const ws = useRef<WebSocket | null>(null);

  // ── Twilio mode state ──────────────────────────────────────────────
  const [callActive, setCallActive] = useState(false);
  const [isDialing, setIsDialing] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');

  // ── Dev mode state ─────────────────────────────────────────────────
  const [devSessionActive, setDevSessionActive] = useState(false);
  const [devStatus, setDevStatus] = useState<'idle' | 'connecting' | 'connected' | 'agent_speaking' | 'listening'>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const conversationRef = useRef<Awaited<ReturnType<typeof Conversation.startSession>> | null>(null);

  // ── Backend UI WebSocket (shared) ──────────────────────────────────
  useEffect(() => {
    if (typeof window !== 'undefined') {
      ws.current = new WebSocket('ws://localhost:8000/ui-stream');
      ws.current.onopen = () => console.log('Connected to backend UI stream');
      ws.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'transcript') {
          addMessage(data.sender, data.text);
        } else if (data.type === 'status') {
          if (data.status === 'call_started') { setCallActive(true); setIsDialing(false); }
          if (data.status === 'call_ended') { setCallActive(false); setIsDialing(false); }
        }
      };
      return () => { if (ws.current) ws.current.close(); };
    }
  }, []);

  const addMessage = useCallback((sender: 'bot' | 'caller', text: string) => {
    setTranscript(prev => [...prev, {
      id: Date.now() + Math.random(),
      sender,
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }]);
  }, []);

  // ── Twilio mode handlers ───────────────────────────────────────────
  const toggleCall = async () => {
    if (callActive) {
      setCallActive(false);
    } else {
      if (!phoneNumber) return;
      setIsDialing(true);
      try {
        const res = await fetch('http://localhost:8000/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
          body: JSON.stringify({ to_number: phoneNumber })
        });
        if (!res.ok) { console.error('Failed to initiate call'); setIsDialing(false); }
      } catch (err) {
        console.error('Error making call', err);
        setIsDialing(false);
      }
    }
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    if (appMode === 'dev' && devSessionActive && conversationRef.current) {
      // Inject text into ElevenLabs agent (agent will speak it)
      conversationRef.current.sendUserMessage(inputText.trim());
      addMessage('caller', `[You directed]: ${inputText.trim()}`);
      setInputText('');
    } else if (appMode === 'twilio' && callActive && ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action: mode === 'tts' ? 'direct_tts' : 'agent_prompt', text: inputText }));
      setInputText('');
    }
  };

  // ── Dev mode handlers ──────────────────────────────────────────────
  const startDevSession = async () => {
    setDevStatus('connecting');
    try {
      // Fetch signed URL from backend (keeps API key server-side)
      const res = await fetch('http://localhost:8000/dev-session');
      const { signed_url } = await res.json();

      const conversation = await Conversation.startSession({
        signedUrl: signed_url,

        onConnect: () => {
          setDevStatus('listening');
          setDevSessionActive(true);
          addMessage('bot', '🎙️ Dev mode active — microphone is live. Speak to test caller audio. Type below to control what ElevenLabs says.');
        },

        onDisconnect: () => {
          setDevStatus('idle');
          setDevSessionActive(false);
          addMessage('bot', 'Dev session ended.');
        },

        onError: (error: string) => {
          console.error('ElevenLabs error:', error);
          setDevStatus('idle');
          setDevSessionActive(false);
        },

        onModeChange: ({ mode }: { mode: 'speaking' | 'listening' }) => {
          setDevStatus(mode === 'speaking' ? 'agent_speaking' : 'listening');
        },

        onMessage: ({ message, source }: { message: string; source: 'ai' | 'user' }) => {
          addMessage(source === 'ai' ? 'bot' : 'caller', message);
        },
      });

      conversationRef.current = conversation;
    } catch (err) {
      console.error('Failed to start dev session:', err);
      setDevStatus('idle');
      addMessage('bot', `❌ Failed to connect: ${err}`);
    }
  };

  const endDevSession = async () => {
    if (conversationRef.current) {
      await conversationRef.current.endSession();
      conversationRef.current = null;
    }
    setDevStatus('idle');
    setDevSessionActive(false);
  };

  const toggleMute = async () => {
    if (conversationRef.current) {
      if (isMuted) {
        await conversationRef.current.setInputVolume(1);
      } else {
        await conversationRef.current.setInputVolume(0);
      }
      setIsMuted(!isMuted);
    }
  };

  // ── Derived ────────────────────────────────────────────────────────
  const isLive = appMode === 'twilio' ? callActive : devSessionActive;
  const canType = isLive;

  const devStatusLabel: Record<typeof devStatus, string> = {
    idle: 'Idle',
    connecting: 'Connecting...',
    connected: 'Connected',
    listening: '🎤 Listening',
    agent_speaking: '🔊 Agent Speaking',
  };

  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100 font-sans">
      {/* ── Sidebar ── */}
      <div className="w-80 border-r border-neutral-800 bg-neutral-900/50 p-6 flex flex-col gap-6">

        {/* Header */}
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white mb-1 flex items-center gap-2">
            <Mic className="text-blue-500" /> Voice Surrogate
          </h1>
          <p className="text-sm text-neutral-400">Manage your AI proxy calls in real-time.</p>
        </div>

        {/* App Mode Toggle */}
        <div className="space-y-2">
          <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider flex items-center gap-2">
            <Settings className="w-3 h-3" /> Mode
          </h2>
          <div className="grid grid-cols-2 gap-2 bg-neutral-900 p-1 rounded-xl border border-neutral-800">
            <button
              onClick={() => setAppMode('twilio')}
              disabled={devSessionActive}
              className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${appMode === 'twilio' ? 'bg-white text-black shadow-sm' : 'text-neutral-400 hover:text-white hover:bg-neutral-800'}`}
            >
              📞 Twilio
            </button>
            <button
              onClick={() => setAppMode('dev')}
              disabled={callActive}
              className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${appMode === 'dev' ? 'bg-amber-500 text-black shadow-sm' : 'text-neutral-400 hover:text-white hover:bg-neutral-800'}`}
            >
              ⚡ Dev Mode
            </button>
          </div>
          {appMode === 'dev' && (
            <p className="text-xs text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              Your mic = caller input. Type below to control what ElevenLabs says.
            </p>
          )}
        </div>

        {/* Operating Mode (TTS vs Agent) — only for Twilio mode */}
        {appMode === 'twilio' && (
          <div className="space-y-3">
            <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider flex items-center gap-2">
              <Settings className="w-3 h-3" /> Voice Mode
            </h2>
            <div className="grid grid-cols-2 gap-2 bg-neutral-900 p-1 rounded-xl border border-neutral-800">
              <button onClick={() => setMode('tts')} className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${mode === 'tts' ? 'bg-white text-black shadow-sm' : 'text-neutral-400 hover:text-white hover:bg-neutral-800'}`}>
                Direct TTS
              </button>
              <button onClick={() => setMode('agent')} className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${mode === 'agent' ? 'bg-blue-600 text-white shadow-sm' : 'text-neutral-400 hover:text-white hover:bg-neutral-800'}`}>
                Agent Mode
              </button>
            </div>
            <p className="text-xs text-neutral-500 min-h-[32px]">
              {mode === 'tts' ? 'The AI speaks exactly what you type.' : 'Type prompts; AI generates full responses.'}
            </p>
          </div>
        )}

        <div className="mt-auto space-y-3">
          {/* Twilio call controls */}
          {appMode === 'twilio' && (
            <>
              {!callActive && (
                <input
                  type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)}
                  placeholder="+1234567890"
                  className="w-full bg-neutral-900 border border-neutral-700 text-white placeholder-neutral-500 rounded-xl py-3 px-4 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                />
              )}
              <button
                onClick={toggleCall}
                disabled={(!callActive && !phoneNumber) || isDialing}
                className={`w-full py-4 rounded-xl flex items-center justify-center gap-2 font-medium transition-all ${callActive ? 'bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500/20' : isDialing ? 'bg-blue-600/50 text-white cursor-wait' : !phoneNumber ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed' : 'bg-white text-black hover:bg-neutral-200'}`}
              >
                {isDialing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Phone className="w-5 h-5" />}
                {isDialing ? 'Dialing...' : callActive ? 'End Call' : 'Call Number'}
              </button>
            </>
          )}

          {/* Dev mode controls */}
          {appMode === 'dev' && (
            <>
              {devSessionActive && (
                <div className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm ${devStatus === 'agent_speaking' ? 'bg-blue-500/10 border-blue-500/30 text-blue-300' : 'bg-green-500/10 border-green-500/30 text-green-300'}`}>
                  <span>{devStatusLabel[devStatus]}</span>
                  <span className="relative flex h-2 w-2">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${devStatus === 'agent_speaking' ? 'bg-blue-400' : 'bg-green-400'}`}></span>
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${devStatus === 'agent_speaking' ? 'bg-blue-500' : 'bg-green-500'}`}></span>
                  </span>
                </div>
              )}
              {devSessionActive && (
                <button onClick={toggleMute} className={`w-full py-2 rounded-xl flex items-center justify-center gap-2 text-sm font-medium border transition-all ${isMuted ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-neutral-800 text-neutral-300 border-neutral-700 hover:bg-neutral-700'}`}>
                  {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  {isMuted ? 'Unmute Mic' : 'Mute Mic'}
                </button>
              )}
              <button
                onClick={devSessionActive ? endDevSession : startDevSession}
                disabled={devStatus === 'connecting'}
                className={`w-full py-4 rounded-xl flex items-center justify-center gap-2 font-medium transition-all ${devSessionActive ? 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20' : devStatus === 'connecting' ? 'bg-amber-500/30 text-amber-300 cursor-wait' : 'bg-amber-500 text-black hover:bg-amber-400'}`}
              >
                {devStatus === 'connecting' ? <RefreshCw className="w-5 h-5 animate-spin" /> : devSessionActive ? <PhoneOff className="w-5 h-5" /> : <Zap className="w-5 h-5" />}
                {devStatus === 'connecting' ? 'Connecting...' : devSessionActive ? 'End Dev Session' : 'Start Dev Session'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Main Transcript Area ── */}
      <div className="flex-1 flex flex-col relative">
        {/* Live banner */}
        {isLive && (
          <div className={`absolute top-0 left-0 right-0 z-10 backdrop-blur-md border-b py-3 px-6 flex justify-between items-center ${appMode === 'dev' ? 'bg-amber-600/10 border-amber-500/20 text-amber-400' : 'bg-blue-600/10 border-blue-500/20 text-blue-400'}`}>
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${appMode === 'dev' ? 'bg-amber-400' : 'bg-blue-400'}`}></span>
                <span className={`relative inline-flex rounded-full h-3 w-3 ${appMode === 'dev' ? 'bg-amber-500' : 'bg-blue-500'}`}></span>
              </span>
              <span className="text-sm font-medium">
                {appMode === 'dev' ? `⚡ Dev Mode — ${devStatusLabel[devStatus]}` : 'You are live on a call'}
              </span>
            </div>
            {appMode === 'dev' && devSessionActive && (
              <div className="flex items-center gap-2 text-xs text-amber-300/70">
                <Volume2 className="w-3 h-3" />
                <span>ElevenLabs audio playing through speaker</span>
              </div>
            )}
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 p-8 overflow-y-auto pt-24 pb-32 flex flex-col justify-end">
          <div className="space-y-6">
            {transcript.length === 0 && (
              <div className="text-center text-neutral-600 flex flex-col items-center justify-center h-full gap-4 mt-32">
                {appMode === 'dev'
                  ? <><Zap className="w-8 h-8 opacity-20" /><p>Click <strong>Start Dev Session</strong> to begin. Your mic = caller. Type to control AI voice.</p></>
                  : <><RefreshCw className="w-8 h-8 opacity-20" /><p>No messages yet. Start a call or type below.</p></>
                }
              </div>
            )}
            {transcript.map((msg) => (
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
              type="text"
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              disabled={!canType}
              placeholder={
                !canType
                  ? appMode === 'dev' ? 'Start a dev session to type...' : 'Start a call to begin typing...'
                  : appMode === 'dev' ? 'Type what ElevenLabs should say...'
                    : mode === 'tts' ? 'Type to speak immediately...' : 'Prompt the AI to respond...'
              }
              className={`w-full bg-neutral-900 border ${canType ? 'border-neutral-700 focus:border-blue-500 focus:ring-blue-500/50' : 'border-neutral-800 opacity-50 cursor-not-allowed'} text-white placeholder-neutral-500 rounded-2xl py-4 pl-6 pr-16 focus:outline-none focus:ring-2 transition-all shadow-2xl`}
            />
            <button
              type="submit"
              disabled={!canType || !inputText.trim()}
              className={`absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-xl transition-all ${canType && inputText.trim() ? 'bg-blue-600 text-white hover:bg-blue-500 shadow-md' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'}`}
            >
              <MessageSquare className="w-4 h-4" />
            </button>
          </form>
          <div className="max-w-4xl mx-auto mt-3 flex justify-end px-2">
            <span className="text-[11px] text-neutral-500 flex items-center gap-1">
              Press <kbd className="bg-neutral-800 px-1.5 py-0.5 rounded font-mono mx-1 border border-neutral-700">Enter</kbd>
              to {appMode === 'dev' ? 'direct agent' : mode === 'tts' ? 'speak' : 'generate'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
