"use client";

import { useState, useEffect, useRef } from 'react';
import { Mic, Search, Settings, Phone, MessageSquare, Play, RefreshCw, Accessibility, Volume2, Ear } from 'lucide-react';

type Message = {
  id: number;
  sender: 'bot' | 'caller';
  text: string;
  timestamp: string;
};

export default function Home() {
  const [mode, setMode] = useState<'tts' | 'agent'>('tts');
  const [callActive, setCallActive] = useState(false);
  const [isDialing, setIsDialing] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isBotPreparing, setIsBotPreparing] = useState(false);
  const [accessibilityMode, setAccessibilityMode] = useState(false);
  const [audioStreamActive, setAudioStreamActive] = useState(false);
  const [transcript, setTranscript] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Attempt to connect to local FastAPI websocket for UI interaction
    if (typeof window !== 'undefined') {
      // Connect to the UI management websocket using ngrok URL
      ws.current = new WebSocket('wss://beverlee-unlikable-unglamourously.ngrok-free.dev/ui-stream');

      ws.current.onopen = () => {
        console.log('Connected to backend UI stream');
      };

      ws.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'transcript') {
          setTranscript(prev => [...prev, {
            id: Date.now(),
            sender: data.sender,
            text: data.text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }]);
          setIsBotPreparing(false);
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

    ws.current.send(JSON.stringify({
      action: mode === 'tts' ? 'direct_tts' : 'agent_prompt',
      text: inputText
    }));

    setInputText('');
    setIsBotPreparing(true);
  };

  const toggleCall = async () => {
    if (callActive) {
      // In a real scenario, this might hit an API to end the outbound call via Twilio
      setCallActive(false);
    } else {
      if (!phoneNumber) return;
      setIsDialing(true);
      try {
        const res = await fetch(`https://beverlee-unlikable-unglamourously.ngrok-free.dev/call`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "true"
          },
          body: JSON.stringify({ to_number: phoneNumber })
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
    <div className="flex h-screen bg-neutral-950 text-neutral-100 font-sans">
      {/* Sidebar / Settings */}
      <div className="w-80 border-r border-neutral-800 bg-neutral-900/50 p-6 flex flex-col gap-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white mb-2 flex items-center gap-2">
            <Mic className="text-blue-500" /> Voice Surrogate
          </h1>
          <p className="text-sm text-neutral-400">Manage your AI proxy calls in real-time.</p>
        </div>

        <div className="space-y-4">
          <h2 className="text-sm font-medium text-neutral-500 uppercase tracking-wider flex items-center gap-2">
            <Settings className="w-4 h-4" /> Operating Mode
          </h2>
          <div className="grid grid-cols-2 gap-2 bg-neutral-900 p-1 rounded-xl border border-neutral-800">
            <button
              onClick={() => setMode('tts')}
              className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${mode === 'tts' ? 'bg-white text-black shadow-sm' : 'text-neutral-400 hover:text-white hover:bg-neutral-800'}`}
            >
              Direct TTS
            </button>
            <button
              onClick={() => setMode('agent')}
              className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${mode === 'agent' ? 'bg-blue-600 text-white shadow-sm' : 'text-neutral-400 hover:text-white hover:bg-neutral-800'}`}
            >
              Agent Mode
            </button>
          </div>
          <p className="text-xs text-neutral-500 mt-2 min-h-[40px]">
            {mode === 'tts'
              ? "The AI speaks exactly what you type. Includes real-time spellcheck."
              : "Act as a director. Type prompts mid-call, and the AI generates full conversational responses."}
          </p>
        </div>

        <div className="space-y-4 mt-auto">
          {!callActive && (
            <input
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+1234567890"
              className="w-full bg-neutral-900 border border-neutral-700 text-white placeholder-neutral-500 rounded-xl py-3 px-4 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            />
          )}
          <button
            onClick={toggleCall}
            disabled={(!callActive && !phoneNumber) || isDialing}
            className={`w-full py-4 rounded-xl flex items-center justify-center gap-2 font-medium transition-all ${callActive
              ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20'
              : (isDialing ? 'bg-blue-600/50 text-white cursor-wait' : (!phoneNumber ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed' : 'bg-white text-black hover:bg-neutral-200'))
              }`}
          >
            {isDialing ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Phone className="w-5 h-5" />}
            {isDialing ? 'Dialing...' : (callActive ? 'End Call' : 'Call Number')}
          </button>
        </div>
      </div>

      {/* Main Transcript Window */}
      <div className="flex-1 flex flex-col relative">
        {callActive && (
          <div className="absolute top-0 left-0 right-0 bg-blue-600/10 border-b border-blue-500/20 text-blue-400 py-3 px-6 flex justify-between items-center z-10 backdrop-blur-md shadow-sm">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500"></span>
              </span>
              <span className="text-sm font-medium">You are live on a call</span>
            </div>

            <div className="flex items-center gap-4">
              {/* Accessibility Toggle */}
              <button
                onClick={() => setAccessibilityMode(!accessibilityMode)}
                className={`text-sm font-medium flex items-center gap-2 px-3 py-1.5 rounded-full border transition-colors ${accessibilityMode ? 'bg-indigo-500 text-white border-indigo-500' : 'bg-neutral-800/50 text-neutral-400 border-neutral-700/50 hover:text-white'
                  }`}
                title="Voice-Activated Screen Reader Mode"
              >
                <Accessibility className="w-4 h-4" />
                <span className="hidden sm:inline">A11y Mode</span>
              </button>

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

        <div className="flex-1 p-8 overflow-y-auto pt-24 pb-32 flex flex-col justify-end">
          <div className="space-y-6">
            {transcript.length === 0 && !isBotPreparing && (
              <div className="text-center text-neutral-600 flex flex-col items-center justify-center h-full gap-4 mt-32">
                <RefreshCw className="w-8 h-8 opacity-20" />
                <p>No messages yet. Start a call or type below.</p>
              </div>
            )}

            {transcript.map((msg) => (
              <div key={msg.id} className={`flex ${msg.sender === 'bot' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[70%] p-4 shadow-xl ${msg.sender === 'bot'
                  ? 'bg-blue-600/20 border border-blue-500/30 text-blue-50 rounded-2xl rounded-tr-sm'
                  : 'bg-neutral-800/80 border border-neutral-700/50 text-neutral-200 rounded-2xl rounded-tl-sm'
                  }`}>
                  <p className="text-[15px] leading-relaxed">{msg.text}</p>
                  <span className="text-[11px] text-neutral-500 mt-2 block font-medium uppercase tracking-wider">{msg.sender} • {msg.timestamp}</span>
                </div>
              </div>
            ))}

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
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-neutral-950 via-neutral-950/95 to-transparent pt-12">
          {accessibilityMode && (
            <div className="max-w-4xl mx-auto mb-4 bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 px-4 py-2 rounded-xl text-xs flex justify-between items-center">
              <span>🎤 <strong>Voice Activation is Active.</strong> Say "Send Message" to submit your text. Say "Interrogate Mode" to switch styles.</span>
            </div>
          )}
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto relative group">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={!callActive}
              placeholder={callActive ? (mode === 'tts' ? "Type to speak immediately (interrupts ongoing speech)..." : "Prompt the AI to respond...") : "Start a call to begin typing"}
              className={`w-full bg-neutral-900 border ${callActive ? 'border-neutral-700 focus:border-blue-500 focus:ring-blue-500/50' : 'border-neutral-800 opacity-50 cursor-not-allowed'} text-white placeholder-neutral-500 rounded-2xl py-4 pl-6 pr-16 focus:outline-none focus:ring-2 transition-all shadow-2xl`}
            />
            <button
              type="submit"
              disabled={!callActive || !inputText.trim()}
              className={`absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-xl transition-all ${callActive && inputText.trim()
                ? 'bg-blue-600 text-white hover:bg-blue-500 shadow-md'
                : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
                }`}
            >
              <MessageSquare className="w-4 h-4" />
            </button>
          </form>
          <div className="max-w-4xl mx-auto mt-3 flex justify-between items-center px-2">
            <span className="text-[11px] text-neutral-500">
              {mode === 'tts' && inputText.length > 0 && "Submitting this will explicitly interrupt any ongoing bot speech."}
            </span>
            <span className="text-[11px] text-neutral-500 flex items-center gap-1">
              Press <kbd className="bg-neutral-800 px-1.5 py-0.5 rounded font-mono mx-1 border border-neutral-700">Enter</kbd> to {mode === 'tts' ? 'speak' : 'generate'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
