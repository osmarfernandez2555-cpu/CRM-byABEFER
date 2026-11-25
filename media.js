// Conversiones de audio con ffmpeg (viene incluido con ffmpeg-static, no hay que instalar nada).
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';

function run(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    const out = [];
    let err = '';
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg: ' + err.slice(-400))));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

// Audio grabado en el navegador (webm/mp4) -> OGG Opus mono, el formato de las notas de voz de WhatsApp.
export const toVoiceNote = (buf) => run([
  '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
  '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
  '-f', 'ogg', 'pipe:1',
], buf);

// Audio de WhatsApp (ogg opus) -> MP3, para que se reproduzca en cualquier navegador (también iPhone).
export const toMp3 = (buf) => run([
  '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
  '-vn', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1',
], buf);

// Duración en segundos (aprox.) leyendo la salida de ffmpeg.
export function durationOf(buf) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', 'pipe:0', '-f', 'null', '-']);
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', () => resolve(0));
    p.on('close', () => {
      const all = [...err.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const m = all.at(-1);
      resolve(m ? Math.round(+m[1] * 3600 + +m[2] * 60 + +m[3]) : 0);
    });
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}
