import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

type ProgressStatus = 'waiting' | 'converting' | 'done' | 'error' | 'cancelled';

interface ConvertRequest {
  files: string[];
  outputDir: string;
  compress?: boolean;
}

interface ProgressEvent {
  index: number;
  total: number;
  inputPath: string;
  outputPath?: string;
  fileName: string;
  percent: number;
  status: ProgressStatus;
  error?: string;
}

let mainWindow: BrowserWindow | null = null;
const currentProcesses = new Set<ChildProcessWithoutNullStreams>();
let cancelRequested = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 760,
    minHeight: 600,
    title: 'Video to MP4',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.removeMenu();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function resolveFfmpegPath(): string {
  if (!ffmpegStatic) {
    throw new Error('FFmpeg binary was not found. Reinstall dependencies with npm install.');
  }

  const resolved = app.isPackaged
    ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
    : ffmpegStatic;

  if (!existsSync(resolved)) {
    throw new Error(`FFmpeg binary not found at: ${resolved}`);
  }

  return resolved;
}

function secondsFromTimestamp(value: string): number {
  const [hours, minutes, seconds] = value.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

async function uniqueOutputPath(
  outputDir: string,
  inputPath: string,
  reservedOutputPaths: Set<string>
): Promise<string> {
  const base = path.basename(inputPath, path.extname(inputPath));
  let candidate = path.join(outputDir, `${base}.mp4`);
  let counter = 1;

  while (true) {
    if (reservedOutputPaths.has(candidate)) {
      candidate = path.join(outputDir, `${base} (${counter}).mp4`);
      counter += 1;
      continue;
    }

    try {
      await access(candidate);
      candidate = path.join(outputDir, `${base} (${counter}).mp4`);
      counter += 1;
    } catch {
      reservedOutputPaths.add(candidate);
      return candidate;
    }
  }
}

function sendProgress(payload: ProgressEvent): void {
  mainWindow?.webContents.send('conversion-progress', payload);
}

// Quality-based encoding saves space on simple scenes and allows more detail
// in complex scenes. VBV limits bitrate spikes without forcing a fixed file size.
const VIDEO_CRF = '22';
const VIDEO_MAXRATE = '7500k';
const VIDEO_BUFSIZE = '15000k';
const AUDIO_BITRATE = '128k';

function convertOne(
  inputPath: string,
  outputPath: string,
  index: number,
  total: number,
  compress = false
): Promise<void> {
  if (cancelRequested) return Promise.reject(new Error('CONVERSION_CANCELLED'));

  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpegPath();
    let durationSeconds = 0;
    let errorOutput = '';
    let lastPercent = 0;
    const args = [
      '-hide_banner', '-nostdin', '-y',
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', compress ? '0:a:0?' : '0:a?',
      ...(compress ? [
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', VIDEO_CRF,
        '-maxrate', VIDEO_MAXRATE,
        '-bufsize', VIDEO_BUFSIZE,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', AUDIO_BITRATE,
      ] : ['-c', 'copy']),
      '-movflags', '+faststart',
      outputPath
    ];

    const currentProcess = spawn(ffmpeg, args, { windowsHide: true });
    currentProcesses.add(currentProcess);

    currentProcess.stderr.setEncoding('utf8');
    currentProcess.stderr.on('data', (chunk: string) => {
      errorOutput = (errorOutput + chunk).slice(-12000);
      const durationMatch = errorOutput.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
      if (durationMatch) durationSeconds = secondsFromTimestamp(durationMatch[1]);

      const timeMatches = [...errorOutput.matchAll(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g)];
      const lastTime = timeMatches.at(-1)?.[1];
      if (lastTime && durationSeconds > 0) {
        const currentSeconds = secondsFromTimestamp(lastTime);
        lastPercent = Math.max(lastPercent, Math.min(99, (currentSeconds / durationSeconds) * 100));
        sendProgress({
          index,
          total,
          inputPath,
          outputPath,
          fileName: path.basename(inputPath),
          percent: lastPercent,
          status: 'converting'
        });
      }
    });

    currentProcess.on('error', (error) => {
      currentProcesses.delete(currentProcess);
      reject(error);
    });

    currentProcess.on('close', (code) => {
      currentProcesses.delete(currentProcess);
      if (cancelRequested) {
        reject(new Error('CONVERSION_CANCELLED'));
      } else if (code === 0) {
        resolve();
      } else {
        const usefulMessage = errorOutput.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
        const incompatibleCodecs = /Could not find tag|not (?:currently )?supported in container|Could not write header/i.test(errorOutput);
        reject(new Error(!compress && incompatibleCodecs
          ? 'Исходные кодеки несовместимы с MP4. Включите «Сжимать видео» и повторите конвертацию.'
          : usefulMessage || `FFmpeg exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  cancelRequested = true;
  for (const process of currentProcesses) {
    if (!process.killed) process.kill();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('select-videos', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Выберите MOV или AVI видео',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Видео MOV / AVI', extensions: ['mov', 'avi'] },
      { name: 'Все файлы', extensions: ['*'] }
    ]
  });

  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Выберите папку для MP4',
    properties: ['openDirectory', 'createDirectory']
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('open-folder', async (_event, folderPath: string) => {
  if (!folderPath) return;
  await shell.openPath(folderPath);
});

ipcMain.handle('cancel-conversion', () => {
  cancelRequested = true;
  for (const process of currentProcesses) {
    if (!process.killed) {
      process.kill();
    }
  }
});

ipcMain.handle('convert-videos', async (_event, request: ConvertRequest) => {
  const { files, outputDir } = request;
  const compress = request.compress === true;

  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Не выбраны файлы для конвертации.');
  }

  if (!outputDir) {
    throw new Error('Не выбрана папка назначения.');
  }

  await mkdir(outputDir, { recursive: true });
  cancelRequested = false;

  const results: Array<{ inputPath: string; outputPath?: string; ok: boolean; error?: string }> = [];
  const reservedOutputPaths = new Set<string>();
  const jobs: Array<{ inputPath: string; outputPath: string; index: number }> = [];

  for (let i = 0; i < files.length; i += 1) {
    const inputPath = files[i];
    const index = i + 1;

    const extension = path.extname(inputPath).toLowerCase();
    if (extension !== '.mov' && extension !== '.avi') {
      const error = 'Поддерживаются только .mov и .avi';
      results.push({ inputPath, ok: false, error });
      sendProgress({
        index,
        total: files.length,
        inputPath,
        fileName: path.basename(inputPath),
        percent: 0,
        status: 'error',
        error
      });
      continue;
    }

    const outputPath = await uniqueOutputPath(outputDir, inputPath, reservedOutputPaths);

    sendProgress({
      index,
      total: files.length,
      inputPath,
      outputPath,
      fileName: path.basename(inputPath),
      percent: 0,
      status: 'converting'
    });

    jobs.push({ inputPath, outputPath, index });
  }

  await Promise.all(jobs.map(async ({ inputPath, outputPath, index }) => {
    if (cancelRequested) {
      sendProgress({
        index,
        total: files.length,
        inputPath,
        outputPath,
        fileName: path.basename(inputPath),
        percent: 0,
        status: 'cancelled'
      });
      return;
    }

    try {
      await convertOne(inputPath, outputPath, index, files.length, compress);
      results.push({ inputPath, outputPath, ok: true });
      sendProgress({
        index,
        total: files.length,
        inputPath,
        outputPath,
        fileName: path.basename(inputPath),
        percent: 100,
        status: 'done'
      });
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => undefined);

      if (cancelRequested || (error instanceof Error && error.message === 'CONVERSION_CANCELLED')) {
        sendProgress({
          index,
          total: files.length,
          inputPath,
          outputPath,
          fileName: path.basename(inputPath),
          percent: 0,
          status: 'cancelled'
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      results.push({ inputPath, outputPath, ok: false, error: message });
      sendProgress({
        index,
        total: files.length,
        inputPath,
        outputPath,
        fileName: path.basename(inputPath),
        percent: 0,
        status: 'error',
        error: message
      });
    }
  }));

  return {
    cancelled: cancelRequested,
    completed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results
  };
});
