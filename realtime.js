'use strict';

require('dotenv').config();
const WebSocket = require('ws');
const { TOOL_DEFINITIONS, executeTool } = require('./tools');

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';

// Twilio streams mulaw 8kHz; OpenAI expects PCM16 24kHz
const TWILIO_SAMPLE_RATE  = 8000;
const OPENAI_SAMPLE_RATE  = 24000;
const UPSAMPLE_RATIO      = OPENAI_SAMPLE_RATE / TWILIO_SAMPLE_RATE; // 3

/**
 * Convert mulaw byte to 16-bit linear PCM sample.
 * Standard G.711 mulaw decode.
 */
function mulawToLinear(mulaw) {
  mulaw = ~mulaw & 0xFF;
  let sign = mulaw & 0x80;
  let exponent = (mulaw >> 4) & 0x07;
  let mantissa = mulaw & 0x0F;
  let sample = ((mantissa << 1) + 33) << exponent;
  sample -= 33;
  return sign ? -sample : sample;
}

/**
 * Convert 16-bit linear PCM sample to mulaw byte.
 */
function linearToMulaw(sample) {
  const MULAW_BIAS = 33;
  const MULAW_CLIP = 32635;
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return mulawByte;
}

/**
 * Decode mulaw Buffer → PCM16 Buffer, upsampled 3x (8kHz → 24kHz).
 */
function mulawToPCM16(mulawBuf) {
  const samples = mulawBuf.length;
  const out = Buffer.alloc(samples * UPSAMPLE_RATIO * 2); // 2 bytes per sample
  let outIdx = 0;
  for (let i = 0; i < samples; i++) {
    const linear = mulawToLinear(mulawBuf[i]);
    // Repeat sample 3x for simple nearest-neighbor upsample
    for (let r = 0; r < UPSAMPLE_RATIO; r++) {
      out.writeInt16LE(linear, outIdx);
      outIdx += 2;
    }
  }
  return out;
}

/**
 * Encode PCM16 Buffer → mulaw Buffer, downsampled 3x (24kHz → 8kHz).
 */
function pcm16ToMulaw(pcmBuf) {
  const samples = Math.floor(pcmBuf.length / 2);
  const outSamples = Math.floor(samples / UPSAMPLE_RATIO);
  const out = Buffer.alloc(outSamples);
  for (let i = 0; i < outSamples; i++) {
    const linear = pcmBuf.readInt16LE(i * UPSAMPLE_RATIO * 2);
    out[i] = linearToMulaw(linear);
  }
  return out;
}

/**
 * Create and manage one OpenAI Realtime session for a single call.
 *
 * @param {string} systemPrompt - full prompt with caller context injected
 * @param {object} twilioWs     - the Twilio media stream WebSocket
 * @param {string} streamSid    - Twilio stream SID (needed to send audio back)
 * @returns {object} { openaiWs, close }
 */
function createRealtimeSession(systemPrompt, twilioWs, streamSid) {
  const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });

  // Track partial function call arguments as they stream in
  const pendingCalls = {};

  openaiWs.on('open', () => {
    console.log('[Realtime] Connected to OpenAI');

    // Configure the session
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: { type: 'server_vad' },
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        voice: 'shimmer',
        instructions: systemPrompt,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
        modalities: ['text', 'audio'],
        temperature: 0.7,
      },
    }));
  });

  openaiWs.on('message', async (data) => {
    let event;
    try { event = JSON.parse(data); } catch { return; }

    switch (event.type) {

      // Stream audio back to Twilio
      case 'response.audio.delta': {
        if (!event.delta) break;
        try {
          const pcmBuf = Buffer.from(event.delta, 'base64');
          const mulawBuf = pcm16ToMulaw(pcmBuf);
          const payload = mulawBuf.toString('base64');

          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload },
            }));
          }
        } catch (err) {
          console.error('[Realtime] Audio encode error:', err.message);
        }
        break;
      }

      // Accumulate streaming function call arguments
      case 'response.function_call_arguments.delta': {
        const callId = event.call_id;
        if (!pendingCalls[callId]) {
          pendingCalls[callId] = { name: event.name || '', args: '' };
        }
        pendingCalls[callId].args += event.delta || '';
        if (event.name) pendingCalls[callId].name = event.name;
        break;
      }

      // Function call complete — execute and return result
      case 'response.function_call_arguments.done': {
        const callId = event.call_id;
        const name = event.name || pendingCalls[callId]?.name;
        const argsStr = event.arguments || pendingCalls[callId]?.args || '{}';
        delete pendingCalls[callId];

        console.log(`[Tool] ${name}(${argsStr})`);

        let result;
        try {
          const args = JSON.parse(argsStr);
          result = await executeTool(name, args);
        } catch (err) {
          console.error(`[Tool] Error executing ${name}:`, err.message);
          result = { error: err.message };
        }

        console.log(`[Tool] Result:`, JSON.stringify(result).slice(0, 200));

        // Send result back to OpenAI
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: JSON.stringify(result),
            },
          }));

          // Prompt OpenAI to continue the conversation
          openaiWs.send(JSON.stringify({ type: 'response.create' }));
        }
        break;
      }

      case 'session.created':
        console.log('[Realtime] Session created:', event.session?.id);
        break;

      case 'error':
        console.error('[Realtime] OpenAI error:', event.error);
        break;

      case 'input_audio_buffer.speech_started':
        // Caller started speaking — cancel any in-progress response
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'response.cancel' }));
        }
        break;

      default:
        break;
    }
  });

  openaiWs.on('error', (err) => {
    console.error('[Realtime] WebSocket error:', err.message);
  });

  openaiWs.on('close', (code, reason) => {
    console.log(`[Realtime] Closed: ${code} ${reason}`);
  });

  function close() {
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  }

  /**
   * Send PCM16 audio from Twilio (after mulaw decode) to OpenAI.
   * @param {Buffer} mulawBuf - raw mulaw bytes from Twilio media event
   */
  function sendAudio(mulawBuf) {
    if (openaiWs.readyState !== WebSocket.OPEN) return;
    const pcmBuf = mulawToPCM16(mulawBuf);
    openaiWs.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: pcmBuf.toString('base64'),
    }));
  }

  return { openaiWs, sendAudio, close };
}

module.exports = { createRealtimeSession };
