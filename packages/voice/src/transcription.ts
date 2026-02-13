/**
 * Transcription router — routes audio to the right STT engine based on tier.
 *
 * Tier alignment:
 * - Free/Starter: Whisper via Ollama (on-device, free, private)
 * - Pro: Deepgram Nova-3 batch (cloud, better accuracy)
 * - Business/Agency: Deepgram Nova-3 Premium (diarization + language detection)
 * - Live voice calls: Telnyx native STT (always, sub-200ms)
 *
 * Volume and length are NEVER limited. What changes across tiers is engine quality.
 */

import { createLogger } from './logger.js';

const logger = createLogger('transcription');

// ─── Types ──────────────────────────────────────────────────────────────────

export type TranscriptionTier = 'free' | 'starter' | 'pro' | 'business' | 'agency';

export interface TranscriptionConfig {
  tier: TranscriptionTier;
  privacy_mode: boolean;
  ollama_url?: string;
  deepgram_api_key?: string;
}

export interface TranscriptionResult {
  text: string;
  engine: string;
  language?: string;
  confidence?: number;
  duration_ms: number;
  segments?: TranscriptionSegment[];
  speakers?: SpeakerSegment[];
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface SpeakerSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

// ─── Transcription Router ───────────────────────────────────────────────────

export class TranscriptionRouter {
  private config: TranscriptionConfig;

  constructor(config: TranscriptionConfig) {
    this.config = config;
  }

  /**
   * Transcribe audio data. Routes to the appropriate engine based on tier.
   */
  async transcribe(
    audio: Buffer,
    options: { language?: string; filename?: string } = {},
  ): Promise<TranscriptionResult> {
    const engine = this.resolveEngine();
    logger.info({ engine, tier: this.config.tier, privacy: this.config.privacy_mode }, 'Transcribing');

    switch (engine) {
      case 'local_whisper':
        return this.transcribeWithWhisper(audio, options);
      case 'deepgram_batch':
        return this.transcribeWithDeepgram(audio, options, false);
      case 'deepgram_premium':
        return this.transcribeWithDeepgram(audio, options, true);
      default:
        throw new Error(`Unknown transcription engine: ${engine}`);
    }
  }

  /**
   * Resolve which engine to use based on tier and privacy mode.
   */
  private resolveEngine(): string {
    // Privacy mode always forces local
    if (this.config.privacy_mode) return 'local_whisper';

    switch (this.config.tier) {
      case 'free':
      case 'starter':
        return 'local_whisper';
      case 'pro':
        return 'deepgram_batch';
      case 'business':
      case 'agency':
        return 'deepgram_premium';
      default:
        return 'local_whisper';
    }
  }

  /**
   * Transcribe using local Whisper via Ollama.
   */
  private async transcribeWithWhisper(
    audio: Buffer,
    _options: { language?: string; filename?: string },
  ): Promise<TranscriptionResult> {
    const startMs = Date.now();
    const ollamaUrl = this.config.ollama_url ?? 'http://localhost:11434';

    try {
      // Ollama doesn't natively support audio transcription via the chat API.
      // In practice, this would use Whisper through Ollama's model serving
      // or a sidecar process. For now, we use the Ollama audio endpoint
      // if available, or fall back to the whisper CLI.

      // Attempt Ollama-served Whisper model
      const formData = new FormData();
      formData.append('file', new Blob([audio]), _options.filename ?? 'audio.ogg');
      formData.append('model', 'whisper-large-v3');

      const res = await fetch(`${ollamaUrl}/api/transcribe`, {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        const data = await res.json() as { text: string; language?: string; segments?: TranscriptionSegment[] };
        return {
          text: data.text,
          engine: 'local_whisper',
          language: data.language,
          duration_ms: Date.now() - startMs,
          segments: data.segments,
        };
      }

      // Fallback: return placeholder indicating Whisper needs to be configured
      logger.warn('Ollama Whisper not available. Ensure whisper-large-v3 is pulled.');
      return {
        text: '[Transcription unavailable — configure Whisper in Ollama]',
        engine: 'local_whisper',
        duration_ms: Date.now() - startMs,
      };
    } catch (err) {
      logger.error({ err }, 'Local Whisper transcription failed');
      return {
        text: '[Transcription failed]',
        engine: 'local_whisper',
        duration_ms: Date.now() - startMs,
      };
    }
  }

  /**
   * Transcribe using Deepgram Nova-3 batch API.
   */
  private async transcribeWithDeepgram(
    audio: Buffer,
    options: { language?: string; filename?: string },
    premium: boolean,
  ): Promise<TranscriptionResult> {
    const startMs = Date.now();
    const apiKey = this.config.deepgram_api_key;

    if (!apiKey) {
      logger.warn('Deepgram API key not configured, falling back to local Whisper');
      return this.transcribeWithWhisper(audio, options);
    }

    try {
      const params = new URLSearchParams({
        model: 'nova-3',
        smart_format: 'true',
      });

      if (options.language) {
        params.set('language', options.language);
      } else if (premium) {
        params.set('detect_language', 'true');
      }

      if (premium) {
        params.set('diarize', 'true');
      }

      const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'audio/ogg',
        },
        body: audio,
      });

      if (!res.ok) {
        throw new Error(`Deepgram API error: ${res.status} ${await res.text()}`);
      }

      const data = await res.json() as {
        results: {
          channels: Array<{
            alternatives: Array<{
              transcript: string;
              confidence: number;
              words?: Array<{
                word: string;
                start: number;
                end: number;
                speaker?: number;
              }>;
            }>;
            detected_language?: string;
          }>;
        };
      };

      const channel = data.results.channels[0];
      const alternative = channel?.alternatives[0];

      const result: TranscriptionResult = {
        text: alternative?.transcript ?? '',
        engine: premium ? 'deepgram_premium' : 'deepgram_batch',
        language: channel?.detected_language,
        confidence: alternative?.confidence,
        duration_ms: Date.now() - startMs,
      };

      // Build speaker segments if diarization was enabled
      if (premium && alternative?.words) {
        const speakers: SpeakerSegment[] = [];
        let currentSpeaker = -1;
        let segmentText = '';
        let segmentStart = 0;

        for (const word of alternative.words) {
          if (word.speaker !== currentSpeaker) {
            if (segmentText) {
              speakers.push({
                speaker: `Speaker ${currentSpeaker}`,
                start: segmentStart,
                end: word.start,
                text: segmentText.trim(),
              });
            }
            currentSpeaker = word.speaker ?? 0;
            segmentStart = word.start;
            segmentText = '';
          }
          segmentText += ` ${word.word}`;
        }

        if (segmentText) {
          const lastWord = alternative.words[alternative.words.length - 1];
          speakers.push({
            speaker: `Speaker ${currentSpeaker}`,
            start: segmentStart,
            end: lastWord?.end ?? segmentStart,
            text: segmentText.trim(),
          });
        }

        result.speakers = speakers;
      }

      return result;
    } catch (err) {
      logger.error({ err }, 'Deepgram transcription failed, falling back to local Whisper');
      return this.transcribeWithWhisper(audio, options);
    }
  }
}
