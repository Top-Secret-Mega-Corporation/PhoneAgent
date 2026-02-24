"use client";

import { useState, useEffect, useRef } from 'react';
import { Mic, Search, Settings, Phone, MessageSquare, Play, RefreshCw, Accessibility, Volume2, Ear, Download } from 'lucide-react';
import { authClient } from "../lib/auth-client"

const { data: session, error } = await authClient.getSession()
// Mu-law decoding table
const muLawToLinear = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let mu = ~i;
  let sign = (mu & 0x80) ? -1 : 1;
  let exponent = (mu & 0x70) >> 4;
  let mantissa = mu & 0x0f;
  let sample = sign * (((mantissa << 3) + 132) << exponent) - 132;
  muLawToLinear[i] = sample;
}

function decodeMuLaw(base64: string): Float32Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const float32Array = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const uint8 = binaryString.charCodeAt(i);
    float32Array[i] = muLawToLinear[uint8] / 32768.0;
  }
  return float32Array;
}

type Message = {
  id: number;
  sender: 'bot' | 'caller' | 'user';
  text: string;
  timestamp: string;
};

export default function Home() {
  const [mode, setMode] = useState<'tts' /* | 'agent' */>('tts');
  const [callActive, setCallActive] = useState(false);
  const [isDialing, setIsDialing] = useState(false);
  const [countryCode, setCountryCode] = useState('+1');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isBotPreparing, setIsBotPreparing] = useState(false);
  const [accessibilityMode, setAccessibilityMode] = useState(false);
  const [audioStreamActive, setAudioStreamActive] = useState(false);
  const [transcript, setTranscript] = useState<Message[]>([]);
  const [partialTranscript, setPartialTranscript] = useState('');
  const [inputText, setInputText] = useState('');
  const ws = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const audioStreamActiveRef = useRef(audioStreamActive);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    audioStreamActiveRef.current = audioStreamActive;
    if (audioStreamActive && !audioContextRef.current) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContextClass({ sampleRate: 8000 });
      nextPlayTimeRef.current = audioContextRef.current.currentTime;
    }
  }, [audioStreamActive]);

  const downloadTranscript = () => {
    if (transcript.length === 0) return;
    const text = transcript.map(m => {
      const isRight = m.sender === 'bot' || m.sender === 'user';
      const senderLabel = isRight ? 'YOU' : (m.sender === 'caller' ? `${countryCode}${phoneNumber}` : m.sender.toUpperCase());
      return `[${m.timestamp}] ${senderLabel}: ${m.text}`;
    }).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    const timeout = setTimeout(() => {
      scrollToBottom();
    }, 100);
    return () => clearTimeout(timeout);
  }, [transcript, partialTranscript, isBotPreparing]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const isSecure = window.location.protocol === 'https:';
      const defaultWsBase = isSecure ? `wss://${window.location.host}` : `ws://${window.location.host}`;

      // Use env variable if provided, fallback to relative path on same host
      const wsUrl = process.env.NEXT_PUBLIC_WS_URL
        || (process.env.NODE_ENV === 'development' ? 'ws://localhost:8000/ui-stream' : `wss://phone-agent-api.lucaswebber.dev/ui-stream`);

      ws.current = new WebSocket(wsUrl);

      ws.current.onopen = () => {
        console.log(`Connected to backend UI stream at ${wsUrl}`);
      };

      ws.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'transcript') {
          setTranscript(prev => [...prev, {
            id: Date.now() + Math.random(),
            sender: data.sender,
            text: data.text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }]);
          setPartialTranscript(''); // Clear the partial transcript
          setIsBotPreparing(false);
        } else if (data.type === 'partial_transcript') {
          setPartialTranscript(data.text);
        } else if (data.type === 'audio') {
          if (audioStreamActiveRef.current && audioContextRef.current) {
            const actx = audioContextRef.current;
            const floatData = decodeMuLaw(data.payload);
            const buffer = actx.createBuffer(1, floatData.length, 8000);
            buffer.getChannelData(0).set(floatData);
            const source = actx.createBufferSource();
            source.buffer = buffer;
            source.connect(actx.destination);

            const currentTime = actx.currentTime;
            if (nextPlayTimeRef.current < currentTime) {
              nextPlayTimeRef.current = currentTime + 0.02; // Small buffer for smoothness
            }
            source.start(nextPlayTimeRef.current);
            nextPlayTimeRef.current += buffer.duration;
          }
        } else if (data.type === 'status') {
          if (data.status === 'call_started') {
            setCallActive(true);
            setIsDialing(false);
          }
          if (data.status === 'call_ended') {
            setCallActive(false);
            setIsDialing(false);
          }
          if (data.status === 'bot_preparing') setIsBotPreparing(true);
        }
      };

      return () => {
        if (ws.current) ws.current.close();
      };
    }
  }, []);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || !ws.current || ws.current.readyState !== WebSocket.OPEN) return;

    // Save text before clearing
    const textToSend = inputText;

    // Clear typing timeout and input BEFORE sending generation command
    // to prevent race conditions with the server cancelling the generation
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    ws.current.send(JSON.stringify({ action: 'typing_stopped' }));

    setInputText('');
    setIsBotPreparing(true);

    ws.current.send(JSON.stringify({
      action: 'direct_tts',
      text: textToSend
    }));
  };

  const handleTypingChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(e.target.value);

    if (callActive && ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action: 'typing' }));

      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      typingTimeoutRef.current = setTimeout(() => {
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ action: 'typing_stopped' }));
        }
      }, 1500);
    }
  };

  const toggleCall = async () => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL
      || (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : 'https://phone-agent-api.lucaswebber.dev');
    console.log(apiUrl);

    if (callActive) {
      try {
        await fetch(`${apiUrl}/hangup`, {
          method: "POST"
        });
      } catch (err) {
        console.error("Hangup fetch failed", err);
      }
      setCallActive(false);
    } else {
      if (!phoneNumber) return;
      setIsDialing(true);
      try {
        const res = await fetch(`${apiUrl}/call`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true"
          },
          body: JSON.stringify({ to_number: `${countryCode}${phoneNumber}` })
        });
        if (!res.ok) {
          console.error("Failed to initiate call");
          setIsDialing(false);
        }
      } catch (err) {
        console.error("Error making call", err);
        setIsDialing(false);
      }
    }
  };

  return (
    <div className="flex flex-col md:flex-row h-screen bg-neutral-950 text-neutral-100 font-sans">
      {/* Mobile Menu */}
      <div className="flex fixed z-50 top-0 w-full md:hidden items-center justify-center gap-3 px-4 py-3 bg-neutral-800/80 rounded-b-md backdrop-blur-md shadow-sm">
        {/* Phone number input */}
        {!callActive && (
          <div className="flex-1 w-2xl min-w-0 flex items-center bg-neutral-900 border border-neutral-700 rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/50">
            <select
              value={countryCode}
              onChange={e => setCountryCode(e.target.value)}
              className="bg-transparent text-white border-r border-neutral-700 py-2 pl-3 pr-2 text-sm focus:outline-none appearance-none font-medium cursor-pointer hover:bg-neutral-800 transition-colors"
            >
              <option value="+1">🇺🇸 +1</option>
              <option value="+44">🇬🇧 +44</option>
              <option value="+61">🇦🇺 +61</option>
              {/* Add more as needed */}
            </select>
            <input
              type="tel"
              value={phoneNumber}
              onChange={e => setPhoneNumber(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="1234567890"
              className="flex-1 w-full bg-transparent text-white placeholder-neutral-500 py-2 px-3 text-sm focus:outline-none"
            />
          </div>
        )}
        {callActive && (
          <span className="flex-1 text-sm text-emerald-400 font-medium flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block" />
            Live call
          </span>
        )}

        {/* Mode toggle — compact pills */}
        <div className="bg-neutral-900 rounded-lg p-1 shrink-0 inline-flex">
          <button
            onClick={() => setMode('tts')}
            className="py-1.5 px-3 rounded-md text-xs font-medium bg-white text-black"
          >TTS</button>
          {/* <button
              onClick={() => setMode('agent')}
              className={`py-1.5 px-3 rounded-md text-xs font-medium transition-all ${mode === 'agent' ? 'bg-blue-600 text-white' : 'text-neutral-400'}`}
            >Agent</button> */}
        </div>

        {/* Call button */}
        <button
          onClick={toggleCall}
          disabled={isDialing || (!callActive && !phoneNumber)}
          className={`shrink-0 flex items-center gap-1.5 py-2 px-3 rounded-xl text-sm font-medium transition-all disabled:opacity-40 ${callActive ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600/50 hover:bg-blue-600'
            }`}
        >
          {isDialing ? <RefreshCw size={14} className="animate-spin" /> : <Phone size={14} />}
          {isDialing ? 'Dialing' : callActive ? 'End' : 'Call'}
        </button>

        {/* Clear & Download */}
        <div className="flex gap-1 shrink-0">
          <button
            onClick={() => { setTranscript([]); setPartialTranscript(''); }}
            className="p-2 border border-neutral-700 hover:bg-neutral-800 rounded-lg transition-colors text-neutral-400"
            title="Clear transcript"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={downloadTranscript}
            disabled={transcript.length === 0}
            className="p-2 border border-neutral-700 hover:bg-neutral-800 rounded-lg transition-colors text-neutral-400 disabled:opacity-50"
            title="Download transcript"
          >
            <Download size={14} />
          </button>
        </div>
      </div>
      {/* Sidebar / Settings */}

      <div className="hidden md:flex w-full md:w-72 md:min-w-72 md:h-full border-r border-neutral-800 bg-neutral-800/50 p-6 flex-col gap-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white mb-2 flex items-center gap-2">
            <Mic className="text-blue-500" /> Phogent
          </h1>
          <p className="text-sm text-neutral-400">Manage your AI proxy calls in real-time.</p>
          <h3 className='text-xl font-semibold tracking-tight text-white mb-2 flex items-center gap-2'>Hello, {session?.user.name}</h3>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => { setTranscript([]); setPartialTranscript(''); }}
            className="flex-1 flex items-center gap-2 justify-center py-2 px-4 border border-neutral-700 hover:bg-neutral-800 rounded-xl transition-colors text-sm font-medium text-neutral-300"
          >
            <RefreshCw className="w-4 h-4" /> Clear
          </button>
          <button
            onClick={downloadTranscript}
            disabled={transcript.length === 0}
            className="flex-1 flex items-center gap-2 justify-center py-2 px-4 border border-neutral-700 hover:bg-neutral-800 rounded-xl transition-colors text-sm font-medium text-neutral-300 disabled:opacity-50"
          >
            <Download className="w-4 h-4" /> Download
          </button>
        </div>

        <div className="space-y-4">
          <h2 className="text-sm font-medium text-neutral-500 uppercase tracking-wider flex items-center gap-2">
            <Settings className="w-4 h-4" /> Operating Mode
          </h2>
          <div className="bg-neutral-900 p-1 rounded-xl border border-neutral-800 inline-flex">
            <button
              onClick={() => setMode('tts')}
              className="py-2 px-4 rounded-lg text-sm font-medium bg-white text-black shadow-sm"
            >
              Direct TTS
            </button>

            {/* <button
              onClick={() => setMode('agent')}
              className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${mode === 'agent' ? 'bg-blue-600 text-white shadow-sm' : 'text-neutral-400 hover:text-white hover:bg-neutral-800'}`}
            >
              Agent Mode
            </button> */}
          </div>
          <p className="text-xs text-neutral-500 mt-2 min-h-[40px]">
            {/* mode === 'tts'
              ? */ "The AI speaks exactly what you type. Includes real-time spellcheck."
              /* : "Act as a director. Type prompts mid-call, and the AI generates full conversational responses." */}
          </p>
        </div>

        <div className="space-y-4 mt-auto">
          {!callActive && (
            <div className="flex items-center w-full bg-neutral-900 border border-neutral-700 rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/50">
              <select
                value={countryCode}
                onChange={e => setCountryCode(e.target.value)}
                className="bg-transparent text-white border-r border-neutral-700 py-3 pl-4 pr-3 text-base focus:outline-none appearance-none font-medium cursor-pointer hover:bg-neutral-800 transition-colors"
              >
                <option value="+1">🇺🇸 +1</option>
                <option value="+44">🇬🇧 +44</option>
                <option value="+61">🇦🇺 +61</option>
                {/* Add more as needed */}
              </select>
              <input
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="1234567890"
                className="flex-1 w-full bg-transparent text-white placeholder-neutral-500 py-3 px-4 focus:outline-none"
              />
            </div>
          )}
          <button
            onClick={toggleCall}
            disabled={(!callActive && !phoneNumber) || isDialing}
            className={`w-full py-4 disabled:opacity-50 rounded-xl flex items-center justify-center gap-2 font-medium transition-all ${callActive
              ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20'
              : (isDialing ? 'bg-blue-600/50 text-white cursor-wait' : (!phoneNumber ? 'bg-blue-600/50 cursor-not-allowed' : 'bg-blue-600/50 text-white hover:bg-blue-600'))
              }`}
          >
            {isDialing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Phone className="w-5 h-5" />}
            {isDialing ? 'Dialing...' : (callActive ? 'End Call' : 'Call Number')}
          </button>
        </div>
      </div>

      {/* Main Transcript Window */}
      <div className="flex-1 flex flex-col relative mt-15 md:mt-0">

        <div className="flex-1 overflow-y-auto pb-32 flex flex-col relative">
          {callActive && (
            <div className="sticky bg-blue-600/10 border-b border-blue-500/20 text-blue-400 py-3 px-6 flex justify-between items-center z-10 backdrop-blur-md shadow-sm">
              <div className="flex items-center gap-3">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
                </span>
                <span className="text-sm font-medium">You are live on a call</span>
              </div>

              <div className="flex items-center gap-4 z-50">
                {/* Accessibility Toggle */}
                {/* <button
                onClick={() => setAccessibilityMode(!accessibilityMode)}
                className={`text-sm font-medium flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors ${accessibilityMode ? 'bg-indigo-500 text-white border-indigo-500' : 'bg-neutral-800/50 text-neutral-400 border-neutral-700/50 hover:text-white'
                  }`}
                title="Voice-Activated Screen Reader Mode"
              >
                <Accessibility className="w-4 h-4" />
                <span className="hidden sm:inline">A11y Mode</span>
              </button> */}

                {/* Audio Playback Toggle */}
                <button
                  onClick={() => setAudioStreamActive(!audioStreamActive)}
                  className={`text-sm font-medium flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors ${audioStreamActive ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-blue-500/10 hover:bg-blue-500/20 hover:text-blue-300 border-blue-500/20'
                    }`}
                >
                  {audioStreamActive ? <Volume2 className="w-4 h-4" /> : <Ear className="w-4 h-4" />}
                  <span className="hidden sm:inline">{audioStreamActive ? "Mute Feed" : "Listen to Audio Feed"}</span>
                </button>
              </div>
            </div>
          )}
          <div className="flex-1  pt-24 w-full mt-auto">
            <div className="space-y-6">
              {transcript.length === 0 && !isBotPreparing && !partialTranscript && (
                <div className="text-center text-neutral-00 flex flex-col items-center justify-center h-full gap-4 mt-32">
                  <RefreshCw className="w-8 h-8 opacity-50" />
                  <p>No messages yet. Start a call or type below.</p>
                </div>
              )}

              {transcript.map((msg) => {
                const isRight = msg.sender === 'bot' || msg.sender === 'user';
                const senderLabel = isRight ? 'YOU' : (msg.sender === 'caller' ? `${countryCode}${phoneNumber}` : msg.sender.toUpperCase());
                return (
                  <div key={msg.id} className={`flex ${isRight ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%] p-4 shadow-xl ${isRight
                      ? 'bg-blue-600/20 border border-blue-500/30 text-blue-50 rounded-2xl rounded-tr-sm'
                      : 'bg-neutral-800/80 border border-neutral-700/50 text-neutral-200 rounded-2xl rounded-tl-sm'
                      }`}>
                      <p className="text-[15px] leading-relaxed">{msg.text}</p>
                      <span className="text-[11px] text-neutral-500 mt-2 block font-medium uppercase tracking-wider">{senderLabel} • {msg.timestamp}</span>
                    </div>
                  </div>
                );
              })}

              {partialTranscript && (
                <div className="flex justify-start opacity-70">
                  <div className="max-w-[70%] p-4 shadow-xl bg-neutral-800/80 border border-neutral-700/50 text-neutral-200 rounded-2xl rounded-tl-sm border-dashed">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="flex h-2 w-2 relative">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neutral-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-neutral-500"></span>
                      </span>
                      <span className="text-[11px] text-neutral-400 uppercase tracking-wider font-medium">Listening...</span>
                    </div>
                    <p className="text-[15px] leading-relaxed animate-pulse">{partialTranscript}</p>
                  </div>
                </div>
              )}

              {isBotPreparing && (
                <div className="flex justify-end opacity-70">
                  <div className="bg-neutral-900 border border-neutral-800 text-neutral-400 text-sm px-4 py-3 rounded-2xl rounded-tr-sm flex items-center gap-3 shadow-lg">
                    <div className="flex gap-1.5">
                      <span className="w-1.5 h-1.5 bg-neutral-500 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                      <span className="w-1.5 h-1.5 bg-neutral-500 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                      <span className="w-1.5 h-1.5 bg-neutral-500 rounded-full animate-bounce"></span>
                    </div>
                    Bot is preparing to speak...
                  </div>
                </div>
              )}
              <div ref={bottomRef} className="h-4 w-full mt-4" />
            </div>
          </div>
        </div>

        <div className="absolute bottom-0 mt-15 left-0 right-0 p-6 bg-gradient-to-t from-neutral-950 via-neutral-950/95 to-transparent pt-12">
          {accessibilityMode && (
            <div className="max-w-4xl mx-auto mb-4 bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 px-4 py-2 rounded-xl text-xs flex justify-between items-center">
              <span>🎤 <strong>Voice Activation is Active.</strong> Say "Send Message" to submit your text. Say "Interrogate Mode" to switch styles.</span>
            </div>
          )}
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto relative group">
            <input
              type="text"
              value={inputText}
              onChange={handleTypingChange}
              disabled={!callActive}
              placeholder={callActive ? "Type to speak immediately (interrupts ongoing speech)..." /* mode === 'tts' ? ... : "Prompt the AI to respond..." */ : "Start a call to begin typing"}
              className={`w-full bg-neutral-700 border ${callActive ? 'border-neutral-700 focus:border-blue-500 focus:ring-blue-500/50' : 'border-neutral-800 opacity-50 cursor-not-allowed'} text-white placeholder-neutral-100 rounded-2xl py-4 pl-6 pr-16 focus:outline-none focus:ring-2 transition-all shadow-2xl`}
            />
            <button
              type="submit"
              disabled={!callActive || !inputText.trim()}
              className={`absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-xl transition-all ${callActive && inputText.trim()
                ? 'bg-blue-600 text-white hover:bg-blue-500 shadow-md'
                : 'bg-neutral-500 text-neutral-600 cursor-not-allowed'
                }`}
            >
              <MessageSquare className="w-4 h-4" />
            </button>
          </form>
          <div className="max-w-4xl mx-auto mt-3 flex justify-between items-center px-2">
            <span className="text-[11px] text-neutral-500">
              {mode === 'tts' && inputText.length > 0 && "Submitting this will explicitly interrupt any ongoing bot speech."}
            </span>
            <span className="text-[11px] text-neutral-300 flex items-center gap-1">
              Press <kbd className="bg-neutral-700 px-1.5 py-0.5 rounded font-mono mx-1 border border-neutral-700">Enter</kbd> to {mode === 'tts' ? 'speak' : 'generate'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}