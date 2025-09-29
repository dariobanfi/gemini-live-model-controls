/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() isSpeaking = false;
  @state() status = '';
  @state() error = '';

  private client: GoogleGenAI;
  private session: Session;
  private inputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({sampleRate: 16000});
  private outputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({sampleRate: 24000});
  private inputNode = this.inputAudioContext.createGain();
  private outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    }

    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 48px;
      padding: 32px;
    }

    .status-area {
      min-height: 80px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .speaking-indicator {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 16px 24px;
      background: rgba(255, 255, 255, 0.15);
      backdrop-filter: blur(10px);
      border-radius: 50px;
      animation: fadeIn 0.3s ease-in-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .speaking-dot {
      width: 8px;
      height: 8px;
      background: white;
      border-radius: 50%;
      animation: pulse 1.4s ease-in-out infinite;
    }

    .speaking-dot:nth-child(2) {
      animation-delay: 0.2s;
    }

    .speaking-dot:nth-child(3) {
      animation-delay: 0.4s;
    }

    @keyframes pulse {
      0%, 60%, 100% {
        transform: scale(1);
        opacity: 1;
      }
      30% {
        transform: scale(1.5);
        opacity: 0.8;
      }
    }

    .speaking-text {
      color: white;
      font-size: 14px;
      font-weight: 500;
      margin-left: 8px;
    }

    .record-button {
      position: relative;
      width: 80px;
      height: 80px;
      border: none;
      border-radius: 50%;
      background: white;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .record-button:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 30px rgba(0, 0, 0, 0.2);
    }

    .record-button:active {
      transform: scale(0.95);
    }

    .record-button.recording {
      background: #ef4444;
      animation: recordPulse 1.5s ease-in-out infinite;
    }

    @keyframes recordPulse {
      0% {
        box-shadow: 0 4px 20px rgba(239, 68, 68, 0.4);
      }
      50% {
        box-shadow: 0 4px 40px rgba(239, 68, 68, 0.6);
      }
      100% {
        box-shadow: 0 4px 20px rgba(239, 68, 68, 0.4);
      }
    }

    .record-icon {
      width: 24px;
      height: 24px;
      fill: #667eea;
      transition: fill 0.3s ease;
    }

    .record-button.recording .record-icon {
      fill: white;
    }

    .stop-icon {
      width: 20px;
      height: 20px;
      fill: white;
    }

    .status-text {
      color: rgba(255, 255, 255, 0.9);
      font-size: 14px;
      text-align: center;
      min-height: 20px;
    }

    .error {
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.1);
      padding: 12px 20px;
      border-radius: 8px;
      backdrop-filter: blur(10px);
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Opened');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              this.isSpeaking = true;
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () =>{
                this.sources.delete(source);
                if (this.sources.size === 0) {
                  this.isSpeaking = false;
                }
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if(interrupted) {
              for(const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
              this.isSpeaking = false;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(e.message);
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus('Close:' + e.reason);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
            // languageCode: 'en-GB'
          },
        },
      });
    } catch (e) {
      console.error(e);
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    this.inputAudioContext.resume();

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        this.session.sendRealtimeInput({media: createBlob(pcmData)});
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus('Stopping recording...');

    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.updateStatus('');
  }

  private toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  render() {
    return html`
      <div class="container">
        <div class="status-area">
          ${this.isSpeaking ? html`
            <div class="speaking-indicator">
              <div class="speaking-dot"></div>
              <div class="speaking-dot"></div>
              <div class="speaking-dot"></div>
              <span class="speaking-text">AI is speaking...</span>
            </div>
          ` : html`
            <div class="status-text">
              ${this.isRecording ? 'Listening...' : 'Click to start conversation'}
            </div>
          `}
        </div>

        <button
          class="record-button ${this.isRecording ? 'recording' : ''}"
          @click=${this.toggleRecording}
          aria-label=${this.isRecording ? 'Stop recording' : 'Start recording'}>
          ${this.isRecording ? html`
            <svg class="stop-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          ` : html`
            <svg class="record-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
          `}
        </button>

        ${this.error ? html`
          <div class="error">${this.error}</div>
        ` : ''}
      </div>
    `;
  }
}
